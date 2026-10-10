import { UNKNOWN, type Measured } from '../execution/worker-provider.ts';
import type { CollabEvent } from './events.ts';
import type { CollaborationStore } from './store.ts';
import type { AgentKind, EngineeringRole, SessionOutcome, SessionStatus, WorkRef } from './types.ts';

/**
 * Read models for a live view (the Control Center): a snapshot plus an ordered event feed with a resumable cursor. Both
 * are pure projections of stored events: nothing here is sampled, estimated or simulated. An agent that did nothing shows
 * zero messages and no activity time; a quantity that was never reported is the literal 'UNKNOWN'.
 */

export interface SessionSummary {
  id: string;
  threadId: string;
  status: SessionStatus;
  suspended: boolean;
  owner: string | null;
  epoch: number;
  chair: string;
  participants: string[];
  agenda: string[];
  /** Highest round a turn was reserved in (0 before the first turn). */
  roundsStarted: number;
  maxRounds: number;
  invocationsUsed: number;
  maxInvocations: number;
  tokensUsed: Measured<number>;
  maxTokens: number | null;
  pending: { participant: string; round: number; turn: number; attempt: number } | null;
  outcome: SessionOutcome | null;
  reason: string | null;
}

export interface ThreadSummary {
  id: string;
  title: string;
  refs: WorkRef;
  participants: { id: string; role: EngineeringRole; kind: AgentKind }[];
  createdBy: string;
  createdAt: number;
  messageCount: number;
  messageKinds: Record<string, number>;
  lastSeq: number;
  lastAt: number;
  sessions: SessionSummary[];
}

export interface AgentActivity {
  id: string;
  role: EngineeringRole;
  kind: AgentKind;
  provider: string | null;
  model: string | null;
  messages: number;
  /** Turns charged to this agent in meetings (answered, rejected, failed or abandoned, plus one in flight). */
  invocations: number;
  inputTokens: Measured<number>;
  outputTokens: Measured<number>;
  lastActiveAt: number | null;
  /** The meeting turn this agent is being asked right now, if any. */
  currentTurn: { sessionId: string; round: number; turn: number } | null;
}

export interface CollaborationOverview {
  threads: ThreadSummary[];
  agents: AgentActivity[];
  /** The feed cursor this snapshot is consistent with: subscribe with eventFeed(cursor). */
  cursor: number;
}

const add = (a: Measured<number>, b: Measured<number>): Measured<number> => (a === UNKNOWN || b === UNKNOWN ? UNKNOWN : a + b);

export function collaborationOverview(store: CollaborationStore): CollaborationOverview {
  return store.scheduler.transact(() => {
    const cursor = (store.scheduler.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM collab_events').get() as { m: number }).m;
    const agents = new Map<string, AgentActivity>(
      store.directory.list().map((a) => [a.id, { id: a.id, role: a.role, kind: a.kind, provider: a.provider ?? null, model: a.model ?? null, messages: 0, invocations: 0, inputTokens: 0, outputTokens: 0, lastActiveAt: null, currentTurn: null }]),
    );
    const touch = (id: string, at: number) => {
      const a = agents.get(id);
      if (a) a.lastActiveAt = Math.max(a.lastActiveAt ?? 0, at);
      return a;
    };
    const threads: ThreadSummary[] = store.threadIds().map((threadId) => {
      const state = store.thread(threadId);
      const kinds: Record<string, number> = {};
      for (const m of state.messages) {
        kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
        const a = touch(m.author.id, m.at);
        if (!a) continue;
        a.messages += 1;
        if (m.invocation) {
          a.inputTokens = add(a.inputTokens, m.invocation.usage.inputTokens);
          a.outputTokens = add(a.outputTokens, m.invocation.usage.outputTokens);
        }
      }
      const sessions = [...state.sessions.values()].map((s): SessionSummary => {
        for (const t of s.turns) {
          const a = agents.get(t.participant);
          if (!a) continue;
          a.invocations += 1;
          // A charged turn that produced no stored message used tokens nobody reported.
          if (t.outcome !== 'message') {
            a.inputTokens = UNKNOWN;
            a.outputTokens = UNKNOWN;
          }
        }
        if (s.pending) {
          const a = agents.get(s.pending.participant);
          if (a) {
            a.invocations += 1;
            if (s.status === 'open') a.currentTurn = { sessionId: s.id, round: s.pending.round, turn: s.pending.turn };
          }
        }
        return {
          id: s.id,
          threadId: s.threadId,
          status: s.status,
          suspended: s.suspended,
          owner: s.owner,
          epoch: s.epoch,
          chair: s.chair,
          participants: s.participants,
          agenda: s.agenda,
          roundsStarted: Math.max(0, ...s.turns.map((t) => t.round), s.pending?.round ?? 0),
          maxRounds: s.limits.maxRounds,
          invocationsUsed: s.invocationsUsed,
          maxInvocations: s.limits.maxInvocations,
          tokensUsed: s.tokensUsed,
          maxTokens: s.limits.maxTokens ?? null,
          pending: s.pending ? { participant: s.pending.participant, round: s.pending.round, turn: s.pending.turn, attempt: s.pending.attempt } : null,
          outcome: s.outcome?.outcome ?? null,
          reason: s.outcome?.reason ?? null,
        };
      });
      const lastAt = state.messages.length ? state.messages[state.messages.length - 1].at : state.thread.createdAt;
      return {
        id: threadId,
        title: state.thread.title,
        refs: state.thread.refs,
        participants: state.thread.participants.map((p) => ({ id: p.id, role: p.role, kind: p.kind })),
        createdBy: state.thread.createdBy.id,
        createdAt: state.thread.createdAt,
        messageCount: state.messages.length,
        messageKinds: kinds,
        lastSeq: state.lastSeq,
        lastAt,
        sessions,
      };
    });
    return { threads, agents: [...agents.values()], cursor };
  });
}

export interface FeedEvent {
  seq: number;
  threadId: string;
  type: CollabEvent['type'];
  at: number;
  actor: string;
  hash: string;
  payload: CollabEvent['payload'];
}

/** Events strictly after `afterSeq`, in order. `cursor` is the last seq returned (or afterSeq): pass it back to continue. */
export function eventFeed(store: CollaborationStore, afterSeq: number, limit = 200): { events: FeedEvent[]; cursor: number; hasMore: boolean } {
  const page = store.eventsSince(afterSeq, limit + 1);
  const events = page.slice(0, limit).map((e) => ({ seq: e.seq, threadId: e.threadId, type: e.type, at: e.at, actor: e.actor, hash: e.hash, payload: e.payload }));
  return { events, cursor: events.length ? events[events.length - 1].seq : Math.max(0, Math.floor(afterSeq)), hasMore: page.length > limit };
}

/** One Server-Sent Events frame. `id` is the global seq, so a reconnecting client's Last-Event-ID is its cursor. */
export function toSseFrame(e: FeedEvent): string {
  return `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

/**
 * Parses a Last-Event-ID header. Null = absent or not a sequence number: the client must take a fresh snapshot
 * (collaborationOverview) and subscribe from its cursor, never guess a position.
 */
export function parseLastEventId(header: string | null | undefined): number | null {
  if (header === null || header === undefined) return null;
  const t = header.trim();
  if (!/^\d{1,15}$/.test(t)) return null;
  return Number(t);
}

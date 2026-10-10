import { UNKNOWN, type Measured } from '../execution/worker-provider.ts';
import { eventHash, GENESIS_HASH, type CollabEvent } from './events.ts';
import { CollaborationError, type MessageView, type SessionOutcome, type SessionState, type ThreadInfo, type TurnLogEntry } from './types.ts';

/**
 * The single reducer from a thread's events to its state. The store validates every command against the state this
 * returns, and every read model is built from it, so "what the thread says" has exactly one definition and replaying the
 * same events always yields the same state.
 */

export interface ThreadState {
  thread: ThreadInfo;
  messages: MessageView[];
  byId: Map<string, MessageView>;
  sessions: Map<string, SessionState>;
  lastSeq: number;
  lastHash: string;
  eventCount: number;
}

/** Replays a thread from its first event. Verifies order and the hash chain; any break is `corrupt` (fail closed). */
export function replay(events: readonly CollabEvent[]): ThreadState {
  if (events.length === 0) throw new CollaborationError('not_found', 'no events');
  let state: ThreadState | undefined;
  let prevHash = GENESIS_HASH;
  let prevSeq = 0;
  for (const e of events) {
    if (e.seq <= prevSeq) throw new CollaborationError('corrupt', `thread ${e.threadId}: event seq ${e.seq} is out of order`);
    if (e.prevHash !== prevHash || eventHash(prevHash, e) !== e.hash) throw new CollaborationError('corrupt', `thread ${e.threadId}: hash chain broken at seq ${e.seq}`);
    if (e.payload.type !== e.type) throw new CollaborationError('corrupt', `thread ${e.threadId}: seq ${e.seq} type mismatch`);
    state = apply(state, e);
    prevHash = e.hash;
    prevSeq = e.seq;
  }
  return state!;
}

const addTokens = (a: Measured<number>, b: Measured<number>): Measured<number> => (a === UNKNOWN || b === UNKNOWN ? UNKNOWN : a + b);

function advance(s: SessionState): void {
  const turn = s.next.turn + 1;
  s.next = turn >= s.participants.length ? { round: s.next.round + 1, turn: 0 } : { round: s.next.round, turn };
}

function logTurn(s: SessionState, entry: Omit<TurnLogEntry, 'participant' | 'attempt' | 'round' | 'turn'>): void {
  const p = s.pending!;
  s.turns.push({ round: p.round, turn: p.turn, participant: p.participant, attempt: p.attempt, ...entry });
}

function apply(state: ThreadState | undefined, e: CollabEvent): ThreadState {
  const p = e.payload;
  if (p.type === 'thread.opened') {
    if (state) throw new CollaborationError('corrupt', `thread ${e.threadId} opened twice`);
    return { thread: p.thread, messages: [], byId: new Map(), sessions: new Map(), lastSeq: e.seq, lastHash: e.hash, eventCount: 1 };
  }
  if (!state) throw new CollaborationError('corrupt', `thread ${e.threadId}: first event is ${e.type}, not thread.opened`);
  state.lastSeq = e.seq;
  state.lastHash = e.hash;
  state.eventCount += 1;
  const session = (id: string): SessionState => {
    const s = state.sessions.get(id);
    if (!s) throw new CollaborationError('corrupt', `thread ${e.threadId} seq ${e.seq}: unknown session ${id}`);
    return s;
  };
  switch (p.type) {
    case 'message.posted': {
      const m: MessageView = { ...p.message, seq: e.seq, correctedBy: [], withdrawnBy: null };
      state.messages.push(m);
      state.byId.set(m.id, m);
      const parent = m.parentId ? state.byId.get(m.parentId) : undefined;
      if (parent && m.kind === 'correction') parent.correctedBy.push(m.id);
      if (parent && m.kind === 'withdrawal') parent.withdrawnBy = m.id;
      if (m.sessionId) {
        const s = session(m.sessionId);
        const usage = m.invocation?.usage;
        const tokens: Measured<number> = usage ? addTokens(usage.inputTokens, usage.outputTokens) : UNKNOWN;
        s.tokensUsed = addTokens(s.tokensUsed, tokens);
        logTurn(s, { outcome: 'message', seq: e.seq, messageId: m.id, kind: m.kind, reason: null });
        s.pending = null;
        advance(s);
      }
      return state;
    }
    case 'session.opened': {
      const o = p.session;
      state.sessions.set(o.id, {
        id: o.id,
        threadId: e.threadId,
        agenda: o.agenda,
        participants: o.participants,
        chair: o.chair,
        limits: o.limits,
        openedBy: o.openedBy,
        openedAt: e.at,
        status: 'open',
        owner: null,
        epoch: 0,
        suspended: false,
        next: { round: 1, turn: 0 },
        pending: null,
        invocationsUsed: 0,
        tokensUsed: 0,
        turns: [],
        outcome: null,
      });
      return state;
    }
    case 'session.claimed': {
      const s = session(p.sessionId);
      s.owner = p.owner;
      s.epoch = p.epoch;
      s.suspended = false;
      return state;
    }
    case 'session.suspended': {
      session(p.sessionId).suspended = true;
      return state;
    }
    case 'turn.reserved': {
      const s = session(p.sessionId);
      s.pending = { round: p.round, turn: p.turn, participant: p.participant, attempt: p.attempt, epoch: p.epoch, seq: e.seq };
      s.invocationsUsed = p.invocationNo;
      return state;
    }
    case 'turn.abandoned': {
      const s = session(p.sessionId);
      logTurn(s, { outcome: 'abandoned', seq: e.seq, messageId: null, kind: null, reason: p.reason });
      s.pending = null; // the same turn is reserved again; `next` does not move
      return state;
    }
    case 'turn.rejected':
    case 'turn.failed': {
      const s = session(p.sessionId);
      const kind = p.type === 'turn.rejected' ? ((p.attempted.kind as MessageView['kind']) ?? null) : null;
      logTurn(s, { outcome: p.type === 'turn.rejected' ? 'rejected' : 'failed', seq: e.seq, messageId: null, kind, reason: p.reason });
      s.pending = null;
      advance(s);
      return state;
    }
    case 'session.concluded': {
      const s = session(p.sessionId);
      s.status = 'concluded';
      s.outcome = { outcome: p.outcome, reason: p.reason, seq: e.seq };
      return state;
    }
    case 'session.cancelled': {
      const s = session(p.sessionId);
      if (s.pending) logTurn(s, { outcome: 'abandoned', seq: e.seq, messageId: null, kind: null, reason: 'session cancelled' });
      s.pending = null;
      s.status = 'cancelled';
      s.outcome = { outcome: 'cancelled', reason: p.reason, seq: e.seq };
      return state;
    }
    default:
      throw new CollaborationError('corrupt', `thread ${e.threadId}: unknown event type ${(p as { type: string }).type}`);
  }
}

/** Whose turn is next, or null when the session is closed or every round is spent. */
export function nextTurn(s: SessionState): { round: number; turn: number; participant: string } | null {
  if (s.status !== 'open' || s.next.round > s.limits.maxRounds) return null;
  return { ...s.next, participant: s.participants[s.next.turn] };
}

/**
 * The deterministic stopping conditions checked between turns (budget exhaustion is enforced when a turn is reserved):
 * a decision by the chair ends the session; a complete round in which nobody contributed ends it unresolved; so does
 * running out of rounds. Null = keep going.
 */
export function stopCondition(state: ThreadState, s: SessionState): { outcome: Exclude<SessionOutcome, 'cancelled'>; reason: string } | null {
  if (s.status !== 'open' || s.pending) return null;
  const decision = state.messages.find((m) => m.sessionId === s.id && m.kind === 'decision');
  if (decision) return { outcome: 'decided', reason: `decision ${decision.id} by ${decision.author.id}: ${decision.decision!.outcome} ${decision.decision!.proposalIds.join(', ')}` };
  if (s.next.turn === 0 && s.next.round > 1) {
    const round = s.next.round - 1;
    const finals = new Map<number, TurnLogEntry>();
    for (const t of s.turns) if (t.round === round && t.outcome !== 'abandoned') finals.set(t.turn, t);
    const quiet = [...finals.values()].every((t) => t.outcome === 'rejected' || (t.outcome === 'message' && t.kind === 'pass'));
    if (quiet) return { outcome: 'unresolved', reason: `no_progress: nobody contributed in round ${round}` };
  }
  if (s.next.round > s.limits.maxRounds) return { outcome: 'unresolved', reason: `max_rounds: all ${s.limits.maxRounds} round(s) spent without a decision` };
  return null;
}

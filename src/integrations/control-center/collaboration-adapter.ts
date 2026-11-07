import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { UNKNOWN, type Measured } from '../../runtime/execution/worker-provider.ts';
import { collaborationOverview, eventFeed, type SessionSummary } from '../../runtime/collaboration/read-model.ts';
import { ParticipantDirectory } from '../../runtime/collaboration/directory.ts';
import { CollaborationStore } from '../../runtime/collaboration/store.ts';
import type { ThreadState } from '../../runtime/collaboration/replay.ts';
import type { MeetingRecord } from '../../runtime/collaboration/record.ts';
import { CollaborationError, idSchema, type MessageView, type ParticipantIdentity, type SessionState } from '../../runtime/collaboration/types.ts';
import type { SchedulerStore } from '../../runtime/scheduler/store.ts';

/**
 * Read-only Gateway adapter over Core B's collaboration store (src/runtime/collaboration). It opens the scheduler database
 * with `readOnly` + `query_only` and hands Core B's unchanged CollaborationStore a minimal facade (db, now, a read
 * transaction), so threads are replayed and hash-chain verified by Core B's own code. No SchedulerStore, coordinator,
 * participant, provider or write path is constructed; every write is refused by SQLite.
 *
 * The output is the Control Center presentation DTO (apps/control-center/src/collaboration-model.ts). Nothing is derived
 * beyond Core B's records: no consensus, no presence, no token totals from incomplete usage (null = UNKNOWN). A broken hash
 * chain or unreadable event is reported as CORRUPT with no records, never as an empty or partial view.
 */

export interface CollaborationParticipant { id: string; name: string; role: string; provider: string | null; model: string | null }
export interface CollaborationMessage {
  id: string; seq: number; threadId: string; sessionId: string | null; round: number | null; turn: number | null;
  authorId: string; at: string; type: string; text: string; replyTo: string | null;
  references: { label: string; url: string | null }[];
  invocationId: string | null; traceId: string | null; traceUrl: null;
  objectionState: 'OPEN' | 'WITHDRAWN' | null; correctedBy: string[]; withdrawnBy: string | null;
}
/**
 * Where a thread (and its meetings) belongs, from persisted references only. ATTRIBUTED requires a batch or task reference
 * resolved in the scheduler database this store lives in (the store validated them against it when written). A free-form
 * objective label, a missing reference, or a store that is not the scheduler of record (the council's own database) is
 * UNATTRIBUTED, with the reason, and is never assigned to a project by name, time or model.
 */
export interface Attribution {
  status: 'ATTRIBUTED' | 'UNATTRIBUTED';
  batchId: string | null;
  project: string | null;
  reason: string | null;
}
export interface CollaborationThread {
  id: string; title: string; objectiveId: string | null; taskId: string | null; synthetic: boolean;
  batchId: string | null; attribution: Attribution;
  participants: CollaborationParticipant[]; messages: CollaborationMessage[]; lastSeq: number; lastHash: string;
}
type Attributed = { text: string; messageIds: string[] };
export interface CollaborationMeeting {
  attribution?: Attribution;
  id: string; title: string; threadId: string; agenda: string[]; participants: CollaborationParticipant[]; synthetic: boolean;
  status: string; suspended: boolean; outcome: string | null; reason: string | null;
  startedAt: string; endedAt: string | null;
  rounds: { id: string; number: number; state: string; messageIds: string[] }[];
  roundLimit: number; invocationLimit: number; invocationsUsed: number; budgetExhausted: boolean | null;
  tokensUsed: number | null; tokenLimit: number | null;
  agreements: Attributed[]; disagreements: Attributed[]; decisions: Attributed[];
  objections: (Attributed & { id: string; status: string })[];
  actions: (Attributed & { id: string; ownerId: string; state: null })[];
  references: { label: string; url: string | null }[];
  usage: { inputTokens: number | null; outputTokens: number | null; source: string; completeness: 'complete' | 'partial' | 'unavailable' };
  provenance: { throughSeq: number; throughHash: string; recordHash: string; messageCount: number } | null;
}
export interface CollaborationView {
  availability: 'AVAILABLE' | 'NOT_AVAILABLE' | 'CORRUPT';
  source: 'core' | 'unavailable';
  reason: string | null;
  cursor: number | null;
  threads: CollaborationThread[];
  meetings: CollaborationMeeting[];
}
export interface CollaborationFeedEvent { seq: number; threadId: string; type: string; at: number }

const iso = (ms: number) => new Date(ms).toISOString();
const known = (v: Measured<number>) => (v === UNKNOWN ? null : v);
const isFake = (p: Pick<ParticipantIdentity, 'provider'>) => p.provider === 'fake';

function participant(p: ParticipantIdentity): CollaborationParticipant {
  return { id: p.id, name: p.displayName ?? p.id, role: p.role, provider: p.provider ?? null, model: p.model ?? null };
}

function message(m: MessageView): CollaborationMessage {
  return {
    id: m.id, seq: m.seq, threadId: m.threadId, sessionId: m.sessionId, round: m.round, turn: m.turn,
    authorId: m.author.id, at: iso(m.at), type: m.kind.toUpperCase(), text: m.body, replyTo: m.parentId,
    // Evidence is an opaque reference (a message id, path, commit, trace id), never a link the viewer could follow blindly.
    references: m.evidence.map((e) => ({ label: `${e.kind}: ${e.ref}${e.note ? ` (${e.note})` : ''}`, url: null })),
    invocationId: m.invocation?.runId ?? null, traceId: m.invocation?.traceId ?? null, traceUrl: null,
    objectionState: m.kind === 'objection' ? (m.withdrawnBy ? 'WITHDRAWN' : 'OPEN') : null,
    correctedBy: m.correctedBy, withdrawnBy: m.withdrawnBy,
  };
}

function thread(state: ThreadState): CollaborationThread {
  const people = state.thread.participants.map(participant);
  return {
    id: state.thread.id, title: state.thread.title, objectiveId: state.thread.refs.objectiveId ?? null, taskId: state.thread.refs.taskId ?? null,
    batchId: state.thread.refs.batchId ?? null, attribution: { status: 'UNATTRIBUTED', batchId: null, project: null, reason: 'not resolved' },
    synthetic: state.thread.participants.some(isFake) || state.messages.some((m) => isFake(m.author)),
    participants: people, messages: state.messages.map(message), lastSeq: state.lastSeq, lastHash: state.lastHash,
  };
}

/** Token usage of a session's own turns. Any unreported usage, charged turn without a message, or turn in flight = UNKNOWN. */
function sessionUsage(state: ThreadState, s: SessionState): CollaborationMeeting['usage'] {
  const messages = state.messages.filter((m) => m.sessionId === s.id && m.invocation);
  const sum = (pick: (m: MessageView) => Measured<number>) => messages.reduce<Measured<number>>((a, m) => (a === UNKNOWN || pick(m) === UNKNOWN ? UNKNOWN : a + (pick(m) as number)), 0);
  const unreported = s.turns.some((t) => t.outcome !== 'message') || s.pending !== null;
  const input = unreported ? UNKNOWN : sum((m) => m.invocation!.usage.inputTokens);
  const output = unreported ? UNKNOWN : sum((m) => m.invocation!.usage.outputTokens);
  const anyReported = messages.some((m) => m.invocation!.usage.inputTokens !== UNKNOWN || m.invocation!.usage.outputTokens !== UNKNOWN);
  return {
    inputTokens: known(input), outputTokens: known(output), source: 'collab_events invocation references',
    completeness: input !== UNKNOWN && output !== UNKNOWN ? 'complete' : anyReported ? 'partial' : 'unavailable',
  };
}

function meeting(state: ThreadState, s: SessionState, summary: SessionSummary | undefined, record: MeetingRecord | null, endedAt: number | null): CollaborationMeeting {
  const byId = new Map(state.thread.participants.map((p) => [p.id, p]));
  const people = (record?.participants ?? s.participants.map((id) => byId.get(id)).filter((p): p is ParticipantIdentity => !!p)).map(participant);
  const roundNumbers = [...new Set([...s.turns.map((t) => t.round), ...(s.pending ? [s.pending.round] : [])])].sort((a, b) => a - b);
  const rounds = roundNumbers.map((n) => {
    const turns = s.turns.filter((t) => t.round === n);
    const silent = turns.filter((t) => t.outcome !== 'message').length;
    const state = s.pending?.round === n ? 'IN PROGRESS' : 'COMPLETE';
    return { id: `${s.id}:round-${n}`, number: n, state: silent ? `${state} · ${silent} turn(s) without a message` : state, messageIds: turns.flatMap((t) => (t.messageId ? [t.messageId] : [])) };
  });
  const one = (source: { messageId: string }) => [source.messageId];
  return {
    id: s.id, title: state.thread.title, threadId: s.threadId, agenda: s.agenda, participants: people,
    synthetic: people.some((p) => p.provider === 'fake'),
    status: s.status.toUpperCase(), suspended: s.suspended, outcome: s.outcome?.outcome ?? null, reason: s.outcome?.reason ?? null,
    startedAt: iso(s.openedAt), endedAt: endedAt === null ? null : iso(endedAt),
    rounds, roundLimit: s.limits.maxRounds, invocationLimit: s.limits.maxInvocations, invocationsUsed: s.invocationsUsed,
    // Open sessions have no outcome yet: whether the budget will run out is unknown, not "no".
    budgetExhausted: s.outcome ? s.outcome.outcome === 'budget_exhausted' : null,
    tokensUsed: known(summary?.tokensUsed ?? s.tokensUsed), tokenLimit: s.limits.maxTokens ?? null,
    agreements: (record?.agreements ?? []).map((a) => ({ text: `Support for ${a.proposalId} from ${a.supporters.join(', ')} · ${a.unanimous ? 'unanimous' : 'not unanimous'}`, messageIds: a.sources.map((x) => x.messageId) })),
    disagreements: (record?.unresolved ?? []).map((u) => ({ text: `${u.kind} ${u.id}: ${u.detail}`, messageIds: one(u.source) })),
    decisions: (record?.decisions ?? []).map((d) => ({
      text: `${d.outcome.toUpperCase()} ${d.proposalIds.join(', ')} by ${d.decider}: ${d.rationale}${d.contested ? ` · CONTESTED, overrules ${d.overruledObjections.join(', ')}` : ''} · grants no authority`,
      messageIds: one(d.source),
    })),
    objections: (record?.objections ?? []).map((o) => ({ id: o.id, status: o.status.toUpperCase(), text: `${o.author} on ${o.target}: ${o.body}`, messageIds: one(o.source) })),
    actions: (record?.actionItems ?? []).map((a, i) => ({ id: `${a.decisionId}:action-${i + 1}`, ownerId: a.owner, state: null, text: a.description, messageIds: one(a.source) })),
    references: [],
    usage: sessionUsage(state, s),
    provenance: record ? { throughSeq: record.provenance.throughSeq, throughHash: record.provenance.throughHash, recordHash: record.recordHash, messageCount: record.provenance.messageSeqs.length } : null,
  };
}

const unavailable = (reason: string): CollaborationView => ({ availability: 'NOT_AVAILABLE', source: 'unavailable', reason, cursor: null, threads: [], meetings: [] });

export function isCollaborationId(value: string): boolean {
  return idSchema.safeParse(value).success;
}

const UNATTRIBUTED = (reason: string): Attribution => ({ status: 'UNATTRIBUTED', batchId: null, project: null, reason });
/** Resolves a thread's own references in the scheduler of record; never by name similarity. */
export function attribute(db: DatabaseSync | null, refs: { batchId?: string; taskId?: string; objectiveId?: string }): Attribution {
  if (!db) return UNATTRIBUTED('This store is not the scheduler of record; its references cannot be resolved here.');
  if (!refs.batchId && !refs.taskId)
    return UNATTRIBUTED(refs.objectiveId ? `Only an unverified objective label (${refs.objectiveId}); no scheduler batch or task reference.` : 'No scheduler batch or task reference.');
  try {
    const task = refs.taskId ? (db.prepare('SELECT batch_id FROM tasks WHERE id = ?').get(refs.taskId) as { batch_id: string } | undefined) : undefined;
    if (refs.taskId && !task) return UNATTRIBUTED(`Referenced task ${refs.taskId} is not in this scheduler database.`);
    const batchId = task?.batch_id ?? refs.batchId!;
    if (refs.batchId && task && task.batch_id !== refs.batchId) return UNATTRIBUTED('Task and batch references disagree.');
    const batch = db.prepare('SELECT project FROM batches WHERE id = ?').get(batchId) as { project: string } | undefined;
    if (!batch) return UNATTRIBUTED(`Referenced batch ${batchId} is not in this scheduler database.`);
    return { status: 'ATTRIBUTED', batchId, project: batch.project, reason: null };
  } catch {
    return UNATTRIBUTED('Scheduler tables are not readable in this store.');
  }
}

/**
 * `schedulerOfRecord`: this collaboration store lives in the scheduler database the Control Center reads, so its validated
 * batch/task references resolve here. False (the default) for any other store, such as the council's own database.
 */
export function createCollaborationReader(options: { dbPath: string; schedulerOfRecord?: boolean }) {
  /** One read transaction over Core B's store. `null` when collab_events was never created in this database. */
  function read<T>(fn: (store: CollaborationStore, db: DatabaseSync) => T): T | null {
    if (!existsSync(options.dbPath)) throw new Error('unavailable');
    const db = new DatabaseSync(options.dbPath, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 250; PRAGMA query_only = ON;');
      const objects = new Set((db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'collab_events%'").all() as { name: string }[]).map((r) => r.name));
      if (!objects.has('collab_events')) return null;
      // The append-only triggers are part of the store's integrity, not decoration: without them rows can be rewritten.
      const missing = ['collab_events_no_update', 'collab_events_no_delete', 'collab_events_thread'].filter((n) => !objects.has(n));
      if (missing.length) throw new CollaborationError('corrupt', `collab_events guard missing: ${missing.join(', ')}`);
      let depth = 0;
      const facade = {
        db,
        now: Date.now,
        transact<R>(inner: () => R): R {
          if (depth > 0) return inner();
          depth += 1;
          db.exec('BEGIN');
          try {
            const result = inner();
            db.exec('COMMIT');
            return result;
          } catch (err) {
            try { db.exec('ROLLBACK'); } catch { /* already closed */ }
            throw err;
          } finally {
            depth -= 1;
          }
        },
      };
      // The constructor's CREATE ... IF NOT EXISTS is a no-op on an existing table and needs no write.
      const store = new CollaborationStore(facade as unknown as SchedulerStore, new ParticipantDirectory([]));
      return facade.transact(() => fn(store, db));
    } finally {
      db.close();
    }
  }

  function guarded<T extends CollaborationView | null>(fn: () => T): T | CollaborationView {
    try {
      return fn();
    } catch (err) {
      if (err instanceof CollaborationError && err.code === 'corrupt')
        return { availability: 'CORRUPT', source: 'core', reason: `Collaboration store failed integrity verification: ${err.message}`, cursor: null, threads: [], meetings: [] };
      if (err instanceof Error && err.message === 'unavailable') return unavailable('Scheduler database not found; collaboration cannot be read.');
      throw err;
    }
  }

  function view(store: CollaborationStore, db: DatabaseSync, threadIds: string[], sessionFilter?: string): CollaborationView {
    const overview = collaborationOverview(store);
    const summaries = new Map(overview.threads.flatMap((t) => t.sessions.map((s) => [s.id, s] as const)));
    const states = threadIds.map((id) => store.thread(id));
    const attributions = new Map(states.map((st) => [st.thread.id, attribute(options.schedulerOfRecord ? db : null, st.thread.refs)] as const));
    const meetings = states.flatMap((state) =>
      [...state.sessions.values()]
        .filter((s) => !sessionFilter || s.id === sessionFilter)
        .map((s) => {
          const record = s.outcome ? store.record(s.id) : null;
          const ended = s.outcome ? store.events(s.threadId).find((e) => e.seq === s.outcome!.seq)?.at ?? null : null;
          return { ...meeting(state, s, summaries.get(s.id), record, ended), attribution: attributions.get(state.thread.id)! };
        }),
    );
    return { availability: 'AVAILABLE', source: 'core', reason: null, cursor: overview.cursor, threads: states.map((st) => ({ ...thread(st), attribution: attributions.get(st.thread.id)! })), meetings };
  }

  const empty = (): CollaborationView => ({ availability: 'AVAILABLE', source: 'core', reason: 'No collaboration events are persisted in this scheduler database.', cursor: 0, threads: [], meetings: [] });

  return {
    snapshot(): CollaborationView {
      return guarded(() => read((store, db) => view(store, db, store.threadIds())) ?? empty());
    },
    /** One thread with its messages; null when it does not exist (a CORRUPT or unavailable store is still a view). */
    thread(threadId: string): CollaborationView | null {
      return guarded(() => read((store, db) => (store.threadIds().includes(threadId) ? view(store, db, [threadId]) : null)));
    },
    /** One meeting session with its record and provenance; null when it does not exist. */
    session(sessionId: string): CollaborationView | null {
      return guarded(() =>
        read((store, db) => {
          const threadId = store.sessionThreadId(sessionId);
          return threadId ? view(store, db, [threadId], sessionId) : null;
        }),
      );
    },
    cursor(): number {
      return read((_store, db) => (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM collab_events').get() as { m: number }).m) ?? 0;
    },
    /** Events strictly after `afterSeq` (ids and types only; clients re-read the verified snapshot). */
    feed(afterSeq: number, limit = 200): { events: CollaborationFeedEvent[]; cursor: number; hasMore: boolean } {
      return read((store) => {
        const page = eventFeed(store, afterSeq, limit);
        return { events: page.events.map((e) => ({ seq: e.seq, threadId: e.threadId, type: e.type, at: e.at })), cursor: page.cursor, hasMore: page.hasMore };
      }) ?? { events: [], cursor: afterSeq, hasMore: false };
    },
  };
}

export type CollaborationReader = ReturnType<typeof createCollaborationReader>;

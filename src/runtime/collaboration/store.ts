import { normalizeUsage, UNKNOWN } from '../execution/worker-provider.ts';
import type { SchedulerStore } from '../scheduler/store.ts';
import type { ParticipantDirectory } from './directory.ts';
import { canonicalJson, eventHash, GENESIS_HASH, sha256, type CollabEvent, type CollabEventPayload, type StoredMessage } from './events.ts';
import { buildMeetingRecord, type MeetingRecord } from './record.ts';
import { replay, type ThreadState } from './replay.ts';
import {
  COLLABORATION_CEILINGS,
  CollaborationError,
  decisionPayloadSchema,
  evidenceRefSchema,
  idSchema,
  invocationInputSchema,
  MESSAGE_KINDS,
  PARENT_RULES,
  sessionLimitsSchema,
  workRefSchema,
  type ParticipantIdentity,
  type EvidenceRef,
  type InvocationInput,
  type InvocationRef,
  type MessageKind,
  type MessageView,
  type PendingTurn,
  type SessionFence,
  type SessionOutcome,
  type SessionState,
  type ThreadInfo,
  type WorkRef,
} from './types.ts';

/**
 * Durable engineering discussions. Like LifecycleStore, it sits BESIDE the scheduler: it adds one append-only table to the
 * scheduler database, reuses its connection, busy handling and IMMEDIATE transactions (`SchedulerStore.transact`), and
 * changes no scheduler table. It is not a scheduler: it never claims, runs or transitions a task.
 *
 * Every command is one IMMEDIATE transaction: replay the thread, validate the command against that state, append one
 * event. Validation is fail closed (an unknown author, a stale fence, a turn that is not yours, an oversize body, a
 * reference that does not resolve are refused, never coerced).
 *
 * Idempotency: every event has a unique idempotency key. Re-sending a command with the same key and the same request is
 * answered from the existing event (no second event); the same key with a different request is `idempotency_conflict`.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collab_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS collab_events_thread ON collab_events(thread_id, seq);
CREATE TRIGGER IF NOT EXISTS collab_events_no_update BEFORE UPDATE ON collab_events BEGIN SELECT RAISE(ABORT, 'collab_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS collab_events_no_delete BEFORE DELETE ON collab_events BEGIN SELECT RAISE(ABORT, 'collab_events is append-only'); END;
`;

export interface PostInput {
  threadId: string;
  authorId: string;
  kind: MessageKind;
  body: string;
  parentId?: string;
  refs?: WorkRef;
  evidence?: EvidenceRef[];
  decision?: unknown;
  invocation?: InvocationInput;
  /** Required outside a session (the caller's retry key). Inside a session the key is derived from the turn. */
  idempotencyKey?: string;
  /** A turn in a meeting session: only the coordinator holding the fence, for the participant whose turn is reserved. */
  session?: { sessionId: string; fence: SessionFence; round: number; turn: number; attempt: number };
}

/** Who cancels: a configured operator or lead (by id), or the coordinator that holds the session's fence. */
export type Canceller = { actorId: string } | { fence: SessionFence };

function rowToEvent(r: Record<string, any>): CollabEvent {
  let payload: CollabEventPayload;
  try {
    payload = JSON.parse(r.payload);
  } catch (err) {
    throw new CollaborationError('corrupt', `collab_events seq ${r.seq}: payload is not valid JSON (${(err as Error).message})`);
  }
  return { seq: r.seq, threadId: r.thread_id, type: r.type, at: r.at, actor: r.actor, idempotencyKey: r.idempotency_key, payload, prevHash: r.prev_hash, hash: r.hash };
}

const fmtIssues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

function parseOr<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new CollaborationError('invalid', `${what}: ${fmtIssues(r.error)}`);
  return r.data;
}

export class CollaborationStore {
  readonly scheduler: SchedulerStore;
  readonly directory: ParticipantDirectory;

  constructor(scheduler: SchedulerStore, directory: ParticipantDirectory) {
    this.scheduler = scheduler;
    this.directory = directory;
    scheduler.db.exec(SCHEMA);
  }

  private get now(): () => number {
    return this.scheduler.now;
  }

  // ---- reads -----------------------------------------------------------------------------------------------------

  events(threadId: string): CollabEvent[] {
    return (this.scheduler.db.prepare('SELECT * FROM collab_events WHERE thread_id = ? ORDER BY seq').all(threadId) as Record<string, any>[]).map(rowToEvent);
  }

  /** Every event after `afterSeq`, in global order: the cursor a live view (SSE `Last-Event-ID`) resumes from. */
  eventsSince(afterSeq: number, limit = 500): CollabEvent[] {
    const n = Math.max(1, Math.min(5_000, Math.floor(limit)));
    return (this.scheduler.db.prepare('SELECT * FROM collab_events WHERE seq > ? ORDER BY seq LIMIT ?').all(Math.max(0, Math.floor(afterSeq)), n) as Record<string, any>[]).map(rowToEvent);
  }

  threadIds(): string[] {
    return (this.scheduler.db.prepare('SELECT thread_id, MIN(seq) AS first FROM collab_events GROUP BY thread_id ORDER BY first').all() as { thread_id: string }[]).map((r) => r.thread_id);
  }

  /** Replayed state of one thread (hash chain verified). */
  thread(threadId: string): ThreadState {
    const events = this.events(threadId);
    if (events.length === 0) throw new CollaborationError('not_found', `thread ${threadId} not found`);
    return replay(events);
  }

  sessionThreadId(sessionId: string): string | undefined {
    const r = this.scheduler.db.prepare("SELECT thread_id FROM collab_events WHERE type = 'session.opened' AND json_extract(payload, '$.session.id') = ?").get(sessionId) as { thread_id: string } | undefined;
    return r?.thread_id;
  }

  session(sessionId: string): { thread: ThreadState; session: SessionState } {
    const threadId = this.sessionThreadId(sessionId);
    if (!threadId) throw new CollaborationError('not_found', `session ${sessionId} not found`);
    const thread = this.thread(threadId);
    return { thread, session: thread.sessions.get(sessionId)! };
  }

  /** The record stored when the session concluded or was cancelled; null while it is open. */
  record(sessionId: string): MeetingRecord | null {
    const { thread, session } = this.session(sessionId);
    if (!session.outcome) return null;
    const e = this.events(thread.thread.id).find((x) => x.seq === session.outcome!.seq)!;
    return (e.payload as { record: MeetingRecord }).record;
  }

  // ---- the one write path ---------------------------------------------------------------------------------------

  /**
   * Runs `decide` against the replayed thread inside one IMMEDIATE transaction and appends the event it returns. A known
   * idempotency key short-circuits before validation (a retry of a command that already took effect is answered, not
   * re-judged against the state it produced).
   */
  private command(threadId: string, key: string, request: unknown, decide: (state: ThreadState | undefined) => { actor: string; payload: CollabEventPayload }): CollabEvent {
    const digest = sha256(canonicalJson(request));
    return this.scheduler.transact(() => {
      const existing = this.scheduler.db.prepare('SELECT * FROM collab_events WHERE idempotency_key = ?').get(key) as Record<string, any> | undefined;
      if (existing) {
        if (existing.request_digest !== digest || existing.thread_id !== threadId) throw new CollaborationError('idempotency_conflict', `idempotency key ${key} was already used for a different request`);
        return rowToEvent(existing);
      }
      const events = this.events(threadId);
      if (events.length >= COLLABORATION_CEILINGS.maxEventsPerThread) throw new CollaborationError('invalid', `thread ${threadId} has reached ${COLLABORATION_CEILINGS.maxEventsPerThread} events; open a new thread`);
      const state = events.length ? replay(events) : undefined;
      const { actor, payload } = decide(state);
      const prevHash = state?.lastHash ?? GENESIS_HASH;
      const at = this.now();
      const draft = { threadId, type: payload.type, at, actor, idempotencyKey: key, payload };
      const hash = eventHash(prevHash, draft);
      const info = this.scheduler.db
        .prepare('INSERT INTO collab_events (thread_id, type, at, actor, idempotency_key, request_digest, payload, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(threadId, payload.type, at, actor, key, digest, JSON.stringify(payload), prevHash, hash);
      return { seq: Number(info.lastInsertRowid), ...draft, prevHash, hash };
    });
  }

  private requireThread(state: ThreadState | undefined, threadId: string): ThreadState {
    if (!state) throw new CollaborationError('not_found', `thread ${threadId} not found`);
    return state;
  }

  private checkRefs(refs: WorkRef): void {
    if (refs.batchId && !this.scheduler.getBatch(refs.batchId)) throw new CollaborationError('invalid', `batch ${refs.batchId} does not exist in the scheduler`);
    if (refs.taskId) {
      const t = this.scheduler.getTask(refs.taskId);
      if (!t) throw new CollaborationError('invalid', `task ${refs.taskId} does not exist in the scheduler`);
      if (refs.batchId && t.batchId !== refs.batchId) throw new CollaborationError('invalid', `task ${refs.taskId} is not in batch ${refs.batchId}`);
    }
  }

  private checkEvidence(state: ThreadState, evidence: unknown): EvidenceRef[] {
    const list = parseOr(evidenceRefSchema.array().max(COLLABORATION_CEILINGS.maxEvidence), evidence ?? [], 'evidence');
    for (const e of list) {
      const bad = (why: string) => new CollaborationError('invalid', `evidence ${e.kind}:${e.ref}: ${why}`);
      if (e.kind === 'message' && !state.byId.has(e.ref)) throw bad('no such message in this thread');
      if (e.kind === 'event') {
        const seq = Number(e.ref);
        if (!Number.isInteger(seq) || seq < 1 || seq > state.lastSeq || !this.events(state.thread.id).some((x) => x.seq === seq)) throw bad('no such event in this thread');
      }
      if (e.kind === 'task' && !this.scheduler.getTask(e.ref)) throw bad('no such task in the scheduler');
      if (e.kind === 'commit' && !/^[0-9a-f]{7,64}$/.test(e.ref)) throw bad('not a hex commit id');
      if (e.kind === 'file' && (e.ref.startsWith('/') || e.ref.split(/[\\/]/).includes('..') || e.ref.includes('\0'))) throw bad('must be a repository-relative path without ..');
    }
    return list;
  }

  // ---- threads and messages -------------------------------------------------------------------------------------

  openThread(input: { threadId: string; title: string; refs?: WorkRef; participants: string[]; actorId: string; idempotencyKey?: string }): ThreadInfo {
    const threadId = parseOr(idSchema, input.threadId, 'threadId');
    const key = input.idempotencyKey ?? `thread:${threadId}:open`;
    this.command(threadId, key, { op: 'openThread', ...input }, (state) => {
      if (state) throw new CollaborationError('duplicate', `thread ${threadId} already exists`);
      const creator = this.directory.require(input.actorId);
      const title = input.title.trim();
      if (!title || title.length > 200) throw new CollaborationError('invalid', 'a thread needs a title of 1-200 characters');
      const refs = parseOr(workRefSchema, input.refs ?? {}, 'refs');
      this.checkRefs(refs);
      const ids = [...new Set(input.participants)];
      if (ids.length !== input.participants.length) throw new CollaborationError('invalid', 'participants are listed twice');
      if (ids.length === 0 || ids.length > COLLABORATION_CEILINGS.maxParticipants) throw new CollaborationError('invalid', `a thread has 1-${COLLABORATION_CEILINGS.maxParticipants} participants`);
      const participants = ids.map((id) => this.directory.require(id));
      if (!participants.some((p) => p.id === creator.id) && creator.kind !== 'operator' && creator.kind !== 'lead') throw new CollaborationError('unauthorized', `${creator.id} may not open a thread it does not take part in`);
      return { actor: creator.id, payload: { type: 'thread.opened', thread: { id: threadId, title, refs, participants, createdBy: creator, createdAt: this.now() } } };
    });
    return this.thread(threadId).thread;
  }

  post(input: PostInput): MessageView {
    const s = input.session;
    const key = s ? `session:${s.sessionId}:r${s.round}:t${s.turn}:a${s.attempt}:message` : input.idempotencyKey;
    if (!key) throw new CollaborationError('invalid', 'a message outside a session needs an idempotencyKey');
    const event = this.command(input.threadId, key, { op: 'post', ...input }, (maybe) => {
      const state = this.requireThread(maybe, input.threadId);
      const author = this.directory.require(input.authorId);
      if (!state.thread.participants.some((p) => p.id === author.id)) throw new CollaborationError('unauthorized', `${author.id} is not a participant of thread ${input.threadId}`);
      if (!(MESSAGE_KINDS as readonly string[]).includes(input.kind)) throw new CollaborationError('invalid', `unknown message kind ${JSON.stringify(input.kind)}`);
      if (typeof input.body !== 'string' || !input.body.trim()) throw new CollaborationError('invalid', 'a message needs a body');
      if (input.body.length > COLLABORATION_CEILINGS.maxBodyChars) throw new CollaborationError('invalid', `body is ${input.body.length} chars; the limit is ${COLLABORATION_CEILINGS.maxBodyChars} (refused, not truncated)`);

      let pending: PendingTurn | null = null;
      let session: SessionState | null = null;
      if (s) {
        session = state.sessions.get(s.sessionId) ?? null;
        if (!session) throw new CollaborationError('not_found', `session ${s.sessionId} is not in thread ${input.threadId}`);
        if (session.status !== 'open') throw new CollaborationError('session_closed', `session ${s.sessionId} is ${session.status}`);
        if (s.fence.owner !== session.owner || s.fence.epoch !== session.epoch) throw new CollaborationError('stale', `session ${s.sessionId}: fence ${s.fence.owner}@${s.fence.epoch} is not the current ${session.owner}@${session.epoch}`);
        pending = session.pending;
        if (!pending || pending.epoch !== session.epoch || pending.participant !== author.id || pending.round !== s.round || pending.turn !== s.turn || pending.attempt !== s.attempt) throw new CollaborationError('not_your_turn', `session ${s.sessionId}: no turn r${s.round}/t${s.turn}/a${s.attempt} is reserved for ${author.id}`);
      } else if (input.kind === 'decision' || input.kind === 'pass') {
        throw new CollaborationError('unauthorized', `a ${input.kind} is recorded only as a turn in a meeting session`);
      }

      const parentRule = PARENT_RULES[input.kind];
      const parent = input.parentId ? state.byId.get(input.parentId) : undefined;
      if (input.parentId && !parent) throw new CollaborationError('invalid', `parent ${input.parentId} is not a message in this thread`);
      if (parentRule === 'none' && input.parentId) throw new CollaborationError('invalid', `a ${input.kind} has no parent`);
      if (Array.isArray(parentRule)) {
        if (!parent) throw new CollaborationError('invalid', `a ${input.kind} must reply to a ${parentRule.join(' or ')}`);
        if (!parentRule.includes(parent.kind)) throw new CollaborationError('invalid', `a ${input.kind} cannot reply to a ${parent.kind}`);
      }
      if ((input.kind === 'withdrawal' || input.kind === 'correction') && parent!.author.id !== author.id) throw new CollaborationError('unauthorized', `${author.id} may only ${input.kind === 'withdrawal' ? 'withdraw' : 'correct'} its own messages`);
      if (parent && parent.withdrawnBy && ['support', 'objection', 'withdrawal'].includes(input.kind)) throw new CollaborationError('invalid', `${parent.id} was withdrawn by ${parent.withdrawnBy}`);

      let decision = null;
      if (input.kind === 'decision') {
        if (author.id !== session!.chair) throw new CollaborationError('unauthorized', `only the chair (${session!.chair}) records a decision in session ${session!.id}`);
        decision = parseOr(decisionPayloadSchema, input.decision, 'decision');
        for (const pid of decision.proposalIds) {
          const p = state.byId.get(pid);
          if (!p || p.kind !== 'proposal') throw new CollaborationError('invalid', `decision: ${pid} is not a proposal in this thread`);
          if (p.withdrawnBy) throw new CollaborationError('invalid', `decision: ${pid} was withdrawn`);
        }
        for (const a of decision.actionItems) this.directory.require(a.owner);
      } else if (input.decision !== undefined) {
        throw new CollaborationError('invalid', `a ${input.kind} carries no decision`);
      }

      const refs = input.refs ? parseOr(workRefSchema, input.refs, 'refs') : state.thread.refs;
      if (input.refs) this.checkRefs(refs);
      const evidence = this.checkEvidence(state, input.evidence);
      let invocation: InvocationRef | null = null;
      if (input.invocation !== undefined || s) {
        if (!author.provider) throw new CollaborationError('invalid', `${author.id} has no configured provider; its messages carry no model invocation`);
        const inv = parseOr(invocationInputSchema, input.invocation ?? {}, 'invocation');
        invocation = { provider: author.provider, model: author.model ?? UNKNOWN, runId: inv.runId ?? null, traceId: inv.traceId ?? null, inferenceMs: inv.inferenceMs ?? UNKNOWN, usage: normalizeUsage(inv.usage) };
      }

      const message: StoredMessage = {
        id: `m${state.messages.length + 1}`,
        threadId: input.threadId,
        sessionId: s?.sessionId ?? null,
        round: s?.round ?? null,
        turn: s?.turn ?? null,
        at: this.now(),
        author,
        parentId: input.parentId ?? null,
        kind: input.kind,
        body: input.body,
        refs,
        evidence,
        invocation,
        decision,
      };
      return { actor: author.id, payload: { type: 'message.posted', message } };
    });
    const id = (event.payload as { message: StoredMessage }).message.id;
    return this.thread(input.threadId).byId.get(id)!;
  }

  // ---- sessions -------------------------------------------------------------------------------------------------

  openSession(input: { sessionId: string; threadId: string; agenda: string[]; participants: string[]; chair: string; limits: unknown; actorId: string; idempotencyKey?: string }): SessionState {
    const sessionId = parseOr(idSchema, input.sessionId, 'sessionId');
    const key = input.idempotencyKey ?? `session:${sessionId}:open`;
    this.command(input.threadId, key, { op: 'openSession', ...input }, (maybe) => {
      const state = this.requireThread(maybe, input.threadId);
      const actor = this.directory.require(input.actorId);
      if (actor.kind !== 'lead' && actor.kind !== 'operator') throw new CollaborationError('unauthorized', `only a lead or an operator opens a meeting session (${actor.id} is ${actor.kind})`);
      const other = this.sessionThreadId(sessionId);
      if (other) throw new CollaborationError('duplicate', `session ${sessionId} already exists (thread ${other})`);
      if (input.agenda.length === 0 || input.agenda.length > COLLABORATION_CEILINGS.maxAgendaItems || input.agenda.some((a) => !a.trim() || a.length > 500)) throw new CollaborationError('invalid', `an agenda has 1-${COLLABORATION_CEILINGS.maxAgendaItems} items of 1-500 characters`);
      const ids = [...new Set(input.participants)];
      if (ids.length !== input.participants.length || ids.length < 2 || ids.length > COLLABORATION_CEILINGS.maxParticipants) throw new CollaborationError('invalid', `a session has 2-${COLLABORATION_CEILINGS.maxParticipants} distinct participants`);
      for (const id of ids) {
        const a = this.directory.require(id);
        if (!state.thread.participants.some((p) => p.id === id)) throw new CollaborationError('unauthorized', `${id} is not a participant of thread ${input.threadId}`);
        if (!a.provider) throw new CollaborationError('invalid', `${id} has no configured provider and cannot take a turn`);
      }
      if (!ids.includes(input.chair)) throw new CollaborationError('invalid', `chair ${input.chair} must be a session participant`);
      const limits = parseOr(sessionLimitsSchema, input.limits, 'limits');
      if (limits.maxInvocations < ids.length) throw new CollaborationError('invalid', `maxInvocations ${limits.maxInvocations} cannot cover one round of ${ids.length} participants`);
      return { actor: actor.id, payload: { type: 'session.opened', session: { id: sessionId, agenda: input.agenda, participants: ids, chair: input.chair, limits, openedBy: actor.id } } };
    });
    return this.session(sessionId).session;
  }

  /**
   * Takes (or takes over) the session for a coordinator and returns its fence. Each claim bumps the epoch, so writes from a
   * previous coordinator (a crashed process, a superseded run) are refused as `stale`. A closed session cannot be claimed.
   */
  claimSession(sessionId: string, owner: string): SessionFence {
    if (!owner.trim()) throw new CollaborationError('invalid', 'a coordinator needs an owner id');
    const { session } = this.session(sessionId);
    const epoch = session.epoch + 1;
    let ev: CollabEvent;
    try {
      ev = this.command(session.threadId, `session:${sessionId}:claim:${epoch}`, { op: 'claim', sessionId, owner, epoch }, (state) => {
        const s = state!.sessions.get(sessionId)!;
        if (s.status !== 'open') throw new CollaborationError('session_closed', `session ${sessionId} is ${s.status}`);
        if (s.epoch + 1 !== epoch) throw new CollaborationError('stale', `session ${sessionId} was claimed concurrently (epoch ${s.epoch})`);
        return { actor: owner, payload: { type: 'session.claimed', sessionId, owner, epoch, previousOwner: s.owner } };
      });
    } catch (err) {
      // Another coordinator took epoch `epoch` between our read and our write: that is a lost race, not a retry.
      if (err instanceof CollaborationError && err.code === 'idempotency_conflict') throw new CollaborationError('stale', `session ${sessionId} was claimed concurrently at epoch ${epoch}`);
      throw err;
    }
    return { owner: (ev.payload as { owner: string }).owner, epoch };
  }

  private fenced(sessionId: string, fence: SessionFence, state: ThreadState | undefined): SessionState {
    const s = state?.sessions.get(sessionId);
    if (!s) throw new CollaborationError('not_found', `session ${sessionId} not found`);
    if (s.status !== 'open') throw new CollaborationError('session_closed', `session ${sessionId} is ${s.status}`);
    if (fence.owner !== s.owner || fence.epoch !== s.epoch) throw new CollaborationError('stale', `session ${sessionId}: fence ${fence.owner}@${fence.epoch} is not the current ${s.owner}@${s.epoch}`);
    return s;
  }

  /** A coordinator stopping without ending the session (shutdown, abort). The next claim resumes it. */
  suspendSession(sessionId: string, fence: SessionFence, reason: string): void {
    const { session } = this.session(sessionId);
    this.command(session.threadId, `session:${sessionId}:suspend:${fence.epoch}`, { op: 'suspend', sessionId, fence, reason }, (state) => {
      this.fenced(sessionId, fence, state);
      return { actor: fence.owner, payload: { type: 'session.suspended', sessionId, owner: fence.owner, epoch: fence.epoch, reason } };
    });
  }

  /**
   * Reserves the next turn and charges one invocation BEFORE the participant is asked: a crash after the call cannot hide
   * it from the budget. The turn must be exactly the next one (turn ownership is derived from the session, not chosen by
   * the caller) and inside maxRounds. Budget exhaustion is `budget_exhausted` and nothing is reserved. A turn still reserved
   * under an older epoch (its coordinator died) is recorded as abandoned and reserved again as the next attempt.
   */
  reserveTurn(sessionId: string, fence: SessionFence, turn: { round: number; turn: number; participant: string }): PendingTurn {
    const { session } = this.session(sessionId);
    const attempt = session.pending && session.pending.round === turn.round && session.pending.turn === turn.turn ? session.pending.attempt + (session.pending.epoch === fence.epoch ? 0 : 1) : 1;
    const base = `session:${sessionId}:r${turn.round}:t${turn.turn}:a${attempt}`;
    // An older-epoch reservation is abandoned first, in its own event.
    if (session.pending && session.pending.epoch !== fence.epoch) {
      const old = session.pending;
      this.command(session.threadId, `session:${sessionId}:r${old.round}:t${old.turn}:a${old.attempt}:abandoned`, { op: 'abandon', sessionId, old, fence }, (state) => {
        const s = this.fenced(sessionId, fence, state);
        if (!s.pending || s.pending.seq !== old.seq) throw new CollaborationError('stale', `session ${sessionId}: the reserved turn changed`);
        return { actor: fence.owner, payload: { type: 'turn.abandoned', sessionId, round: old.round, turn: old.turn, participant: old.participant, attempt: old.attempt, reason: `coordinator ${old.epoch} was superseded by ${fence.owner}@${fence.epoch} before the turn was answered` } };
      });
    }
    const ev = this.command(session.threadId, `${base}:reserve`, { op: 'reserve', sessionId, fence, turn }, (state) => {
      const s = this.fenced(sessionId, fence, state);
      if (s.pending) throw new CollaborationError('invalid', `session ${sessionId}: turn r${s.pending.round}/t${s.pending.turn} is still reserved`);
      if (s.next.round > s.limits.maxRounds) throw new CollaborationError('budget_exhausted', `session ${sessionId}: all ${s.limits.maxRounds} round(s) are spent`);
      if (turn.round !== s.next.round || turn.turn !== s.next.turn || turn.participant !== s.participants[s.next.turn]) throw new CollaborationError('not_your_turn', `session ${sessionId}: next turn is r${s.next.round}/t${s.next.turn} (${s.participants[s.next.turn]})`);
      if (s.invocationsUsed >= s.limits.maxInvocations) throw new CollaborationError('budget_exhausted', `session ${sessionId}: invocation budget ${s.limits.maxInvocations} is spent`);
      if (s.limits.maxTokens !== undefined) {
        if (s.tokensUsed === UNKNOWN) throw new CollaborationError('budget_exhausted', `session ${sessionId}: token usage is UNKNOWN, so the ${s.limits.maxTokens}-token budget cannot be verified`);
        if (s.tokensUsed >= s.limits.maxTokens) throw new CollaborationError('budget_exhausted', `session ${sessionId}: ${s.tokensUsed} of ${s.limits.maxTokens} tokens used`);
      }
      return { actor: fence.owner, payload: { type: 'turn.reserved', sessionId, round: turn.round, turn: turn.turn, participant: turn.participant, attempt, epoch: fence.epoch, invocationNo: s.invocationsUsed + 1 } };
    });
    const p = ev.payload as Extract<CollabEventPayload, { type: 'turn.reserved' }>;
    return { round: p.round, turn: p.turn, participant: p.participant, attempt: p.attempt, epoch: p.epoch, seq: ev.seq };
  }

  /** Closes the reserved turn without a message: the reply was refused (rejected) or the participant failed. */
  closeTurn(sessionId: string, fence: SessionFence, pending: PendingTurn, outcome: { rejected: { reason: string; attempted: { kind: string; body: string } } } | { failed: { reason: string } }): void {
    const { session } = this.session(sessionId);
    const tag = 'rejected' in outcome ? 'rejected' : 'failed';
    this.command(session.threadId, `session:${sessionId}:r${pending.round}:t${pending.turn}:a${pending.attempt}:${tag}`, { op: tag, sessionId, fence, pending, outcome }, (state) => {
      const s = this.fenced(sessionId, fence, state);
      if (!s.pending || s.pending.seq !== pending.seq) throw new CollaborationError('stale', `session ${sessionId}: turn r${pending.round}/t${pending.turn} is not the reserved one`);
      const common = { sessionId, round: pending.round, turn: pending.turn, participant: pending.participant, attempt: pending.attempt };
      if ('rejected' in outcome) {
        const attempted = { kind: String(outcome.rejected.attempted.kind).slice(0, 32), body: String(outcome.rejected.attempted.body ?? '').slice(0, COLLABORATION_CEILINGS.maxBodyChars) };
        return { actor: fence.owner, payload: { type: 'turn.rejected', ...common, reason: outcome.rejected.reason, attempted } };
      }
      return { actor: fence.owner, payload: { type: 'turn.failed', ...common, reason: outcome.failed.reason } };
    });
  }

  /** Ends the session with an outcome and stores its meeting record. Only between turns. */
  concludeSession(sessionId: string, fence: SessionFence, outcome: Exclude<SessionOutcome, 'cancelled'>, reason: string): MeetingRecord {
    const { session } = this.session(sessionId);
    this.command(session.threadId, `session:${sessionId}:conclude`, { op: 'conclude', sessionId, fence, outcome, reason }, (state) => {
      const s = this.fenced(sessionId, fence, state);
      if (s.pending) throw new CollaborationError('invalid', `session ${sessionId}: turn r${s.pending.round}/t${s.pending.turn} is still reserved`);
      const record = buildMeetingRecord(state!, s, { outcome, reason });
      return { actor: fence.owner, payload: { type: 'session.concluded', sessionId, outcome, reason, record } };
    });
    return this.record(sessionId)!;
  }

  /**
   * Cancels an open session: terminal, audited, and it fences out the coordinator (its next write is `session_closed`).
   * Allowed for a configured operator or lead, or the coordinator holding the fence. A participant cannot cancel a meeting.
   */
  cancelSession(sessionId: string, by: Canceller, reason: string): MeetingRecord {
    if (!reason.trim()) throw new CollaborationError('invalid', 'a cancellation needs a reason');
    const { session } = this.session(sessionId);
    this.command(session.threadId, `session:${sessionId}:cancel`, { op: 'cancel', sessionId, by, reason }, (state) => {
      let actor: ParticipantIdentity | { id: string; kind: 'coordinator' };
      let s: SessionState;
      if ('fence' in by) {
        s = this.fenced(sessionId, by.fence, state);
        actor = { id: by.fence.owner, kind: 'coordinator' };
      } else {
        const a = this.directory.require(by.actorId);
        if (a.kind !== 'operator' && a.kind !== 'lead') throw new CollaborationError('unauthorized', `${a.id} (${a.kind}) may not cancel a meeting`);
        s = state!.sessions.get(sessionId)!;
        if (s.status !== 'open') throw new CollaborationError('session_closed', `session ${sessionId} is ${s.status}`);
        actor = a;
      }
      const record = buildMeetingRecord(state!, s, { outcome: 'cancelled', reason });
      return { actor: actor.id, payload: { type: 'session.cancelled', sessionId, actor, reason, abandonedTurn: s.pending, record } };
    });
    return this.record(sessionId)!;
  }
}

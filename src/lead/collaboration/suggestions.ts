/**
 * Meeting suggestions (M12): when the lifecycle escalates for a TECHNICAL reason, it records a durable suggestion that the Lead
 * hold a meeting about it. A suggestion is not a meeting and opens nothing: the Engineering Lead or an operator accepts it
 * explicitly (`lead meeting open <session> --suggestion <id>`, which opens a real meeting on the M9/M10 collaboration engine) or
 * dismisses it with a reason.
 *
 *   classify      deterministic, from the runtime's own failure category; never from a model's words
 *   technical     the worker could not do it, repair rejections used up the correction budget, it does not integrate, the oracle
 *                 rejects the result
 *   operator      security (out-of-scope edits, the change gate's blocking findings), evidence integrity (a reviewer escalating to
 *                 a human), authorization, budget, a dirty source tree: a human decides; no meeting can approve these
 *   none          retryable or derived failures (timeouts, unavailable runtime, lost leases, a failed dependency)
 *
 * Bounds: one suggestion per (batch, root task, category), ever, so a resumed objective that escalates the same way again, or a
 * dismissed suggestion, is never suggested again; at most MAX_SUGGESTIONS_PER_BATCH per batch. The reason and evidence are
 * copied from the scheduler's records (failure category, state reason, review decision), fixed at creation, and never edited.
 */
import type { SchedulerStore, TaskRow } from '../../runtime/scheduler/store.ts';
import { providerOfSpec } from '../../runtime/scheduler/types.ts';
import { ENGINEERING_LEAD_ID } from './roster.ts';

export const MAX_SUGGESTIONS_PER_BATCH = 3;
const MAX_REASON_CHARS = 600;

export const MEETING_TYPES = ['technical_escalation', 'review_escalation', 'integration_failure', 'acceptance_failure'] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export type EscalationClass =
  | { kind: 'technical'; meetingType: MeetingType }
  | { kind: 'operator'; why: string }
  | { kind: 'none'; why: string };

const TECHNICAL: Record<string, MeetingType> = {
  coding_attempts_exhausted: 'technical_escalation',
  review_rejected: 'review_escalation',
  integration_conflict: 'integration_failure',
  integration_verification_failed: 'integration_failure',
  diverged_after_review: 'integration_failure',
};
const OPERATOR: Record<string, string> = {
  forbidden_mutation: 'security: the worker changed files outside its scope',
  // The change gate blocks out-of-scope files, credential-like additions and other policy findings; a reviewer escalates to a
  // human when the evidence itself cannot be trusted. Both are for a person, not a meeting.
  review_gate_blocked: 'the change gate blocked the result (scope, security or policy finding)',
  escalated_by_reviewer: 'the reviewer escalated to a human (the evidence could not be trusted)',
  provider_not_authorized: 'authorization or budget: only the operator grants it',
  source_tree_dirty: 'the source tree changed under the batch: an operator reconciles it',
  cancelled: 'cancelled by a person',
};

/** What an escalated task's runtime failure category calls for. Unknown categories suggest nothing (conservative). */
export function classifyEscalation(failureCategory: string | null | undefined): EscalationClass {
  if (failureCategory && Object.hasOwn(TECHNICAL, failureCategory)) return { kind: 'technical', meetingType: TECHNICAL[failureCategory] };
  if (failureCategory && Object.hasOwn(OPERATOR, failureCategory)) return { kind: 'operator', why: OPERATOR[failureCategory] };
  return { kind: 'none', why: failureCategory ? `${failureCategory} is retryable or derived from another failure` : 'no failure category recorded' };
}

export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed';

export interface ProposedParticipant {
  id: string;
  role: 'engineering_lead' | 'implementer' | 'reviewer';
  /** Only a proposal: opening the meeting still needs explicit, authorized `--participant` specs. */
  note: string;
}

export interface MeetingSuggestion {
  id: string;
  dedupeKey: string;
  status: SuggestionStatus;
  meetingType: MeetingType;
  /** The runtime failure category (or `not_accepted`) this suggestion rests on. */
  category: string;
  /** Verified at creation from the scheduler's own rows. */
  refs: { project: string; objectiveId: string | null; batchId: string; taskId: string | null };
  reason: string;
  evidence: { kind: 'task' | 'review' | 'lifecycle'; ref: string; detail: string }[];
  participants: ProposedParticipant[];
  createdAt: number;
  createdBy: string;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionReason: string | null;
  sessionId: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meeting_suggestions (
  id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'dismissed')),
  meeting_type TEXT NOT NULL, category TEXT NOT NULL,
  project TEXT NOT NULL, objective_id TEXT, batch_id TEXT NOT NULL REFERENCES batches(id), task_id TEXT REFERENCES tasks(id),
  reason TEXT NOT NULL, evidence TEXT NOT NULL, participants TEXT NOT NULL,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  decided_at INTEGER, decided_by TEXT, decision_reason TEXT, session_id TEXT,
  -- the status and the decision columns agree: a pending row carries no decision; an accepted one names who and the meeting it
  -- opened; a dismissed one names who and a reason (so nothing can be "accepted" or "decided" by half a record)
  CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by IS NULL AND decision_reason IS NULL AND session_id IS NULL)
    OR (status = 'accepted' AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND session_id IS NOT NULL AND decision_reason IS NULL)
    OR (status = 'dismissed' AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND trim(decision_reason) <> '' AND session_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS meeting_suggestions_batch ON meeting_suggestions(batch_id);
-- A row is only ever INSERTed new and pending. Without this, INSERT OR REPLACE would overwrite a decided row: REPLACE fires neither
-- the UPDATE nor (unless recursive_triggers is on) the DELETE trigger, but it does fire BEFORE INSERT, before the conflict is resolved.
CREATE TRIGGER IF NOT EXISTS meeting_suggestions_insert_new BEFORE INSERT ON meeting_suggestions
  WHEN NEW.status <> 'pending' OR EXISTS (SELECT 1 FROM meeting_suggestions WHERE id = NEW.id OR dedupe_key = NEW.dedupe_key)
BEGIN SELECT RAISE(ABORT, 'a meeting suggestion is created once, pending; it is never replaced'); END;
CREATE TRIGGER IF NOT EXISTS meeting_suggestions_no_delete BEFORE DELETE ON meeting_suggestions BEGIN SELECT RAISE(ABORT, 'meeting_suggestions is never deleted'); END;
CREATE TRIGGER IF NOT EXISTS meeting_suggestions_fixed BEFORE UPDATE ON meeting_suggestions
  WHEN OLD.status <> 'pending' OR NEW.id <> OLD.id OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.meeting_type <> OLD.meeting_type OR NEW.category <> OLD.category
    OR NEW.reason <> OLD.reason OR NEW.evidence <> OLD.evidence OR NEW.participants <> OLD.participants OR NEW.batch_id <> OLD.batch_id
    OR NEW.task_id IS NOT OLD.task_id OR NEW.objective_id IS NOT OLD.objective_id OR NEW.project <> OLD.project
    OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by
BEGIN SELECT RAISE(ABORT, 'a meeting suggestion is decided once and its content never changes'); END;
`;

const GUARDS = ['meeting_suggestions_insert_new', 'meeting_suggestions_no_delete', 'meeting_suggestions_fixed'];

/**
 * Creates the table on first use. Once it exists, a missing guard is NOT recreated (that would quietly make rows that were
 * editable in the meantime look protected again): writing is refused until an operator investigates. The console reports the same
 * condition as CORRUPT.
 */
function ensureSchema(store: SchedulerStore): void {
  const exists = Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meeting_suggestions'").get());
  if (!exists) return void store.db.exec(SCHEMA);
  const present = new Set((store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'meeting_suggestions'").all() as { name: string }[]).map((r) => r.name));
  const missing = GUARDS.filter((g) => !present.has(g));
  if (missing.length > 0) throw new SuggestionError('invalid', `meeting_suggestions is missing its guard(s) ${missing.join(', ')}; refusing to write until an operator has checked the table`);
}

export class SuggestionError extends Error {
  readonly code: 'not_found' | 'not_pending' | 'invalid';
  constructor(code: SuggestionError['code'], message: string) {
    super(message);
    this.name = 'SuggestionError';
    this.code = code;
  }
}

function rowToSuggestion(r: Record<string, any>): MeetingSuggestion {
  return {
    id: r.id, dedupeKey: r.dedupe_key, status: r.status, meetingType: r.meeting_type, category: r.category,
    refs: { project: r.project, objectiveId: r.objective_id ?? null, batchId: r.batch_id, taskId: r.task_id ?? null },
    reason: r.reason, evidence: JSON.parse(r.evidence), participants: JSON.parse(r.participants),
    createdAt: r.created_at, createdBy: r.created_by, decidedAt: r.decided_at ?? null, decidedBy: r.decided_by ?? null,
    decisionReason: r.decision_reason ?? null, sessionId: r.session_id ?? null,
  };
}

/** The first task of a correction chain (`x` for `x-fix1`, `x-fix1-fix1`...): suggestions are per root task. */
function rootOf(store: SchedulerStore, task: TaskRow): TaskRow {
  let t = task;
  for (let i = 0; i < 20 && t.correctionOf; i++) {
    const parent = store.getTask(t.correctionOf);
    if (!parent) break;
    t = parent;
  }
  return t;
}

const clip = (s: string) => (s.length > MAX_REASON_CHARS ? `${s.slice(0, MAX_REASON_CHARS - 1)}…` : s);

/** Read-only: suggestions in this scheduler database, oldest first. Empty when the table was never created. */
export function listSuggestions(store: SchedulerStore, filter: { batchId?: string; status?: SuggestionStatus } = {}): MeetingSuggestion[] {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meeting_suggestions'").get()) return [];
  const rows = store.db.prepare('SELECT * FROM meeting_suggestions WHERE (?1 IS NULL OR batch_id = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY created_at, id').all(filter.batchId ?? null, filter.status ?? null) as Record<string, any>[];
  return rows.map(rowToSuggestion);
}

export function getSuggestion(store: SchedulerStore, id: string): MeetingSuggestion | undefined {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meeting_suggestions'").get()) return undefined;
  const row = store.db.prepare('SELECT * FROM meeting_suggestions WHERE id = ?').get(id) as Record<string, any> | undefined;
  return row ? rowToSuggestion(row) : undefined;
}

export interface SuggestOutcome {
  created: MeetingSuggestion[];
  /** Escalations that were looked at and did not produce a new suggestion, with the reason. */
  skipped: { taskId: string | null; why: string }[];
}

interface Candidate {
  meetingType: MeetingType;
  category: string;
  objectiveId: string | null;
  batchId: string;
  rootTask: TaskRow | null;
  reason: string;
  evidence: MeetingSuggestion['evidence'];
}

function insert(store: SchedulerStore, c: Candidate, actor: string, out: SuggestOutcome): void {
  const dedupeKey = `${c.batchId}:${c.rootTask?.id ?? '-'}:${c.category}`;
  const existing = store.db.prepare('SELECT id, status FROM meeting_suggestions WHERE dedupe_key = ?').get(dedupeKey) as { id: string; status: string } | undefined;
  if (existing) return void out.skipped.push({ taskId: c.rootTask?.id ?? null, why: `already suggested as ${existing.id} (${existing.status}); never suggested twice` });
  const count = (store.db.prepare('SELECT COUNT(*) AS n FROM meeting_suggestions WHERE batch_id = ?').get(c.batchId) as { n: number }).n;
  if (count >= MAX_SUGGESTIONS_PER_BATCH) return void out.skipped.push({ taskId: c.rootTask?.id ?? null, why: `batch ${c.batchId} already has ${count} suggestion(s), the limit` });
  const batch = store.getBatch(c.batchId);
  if (!batch) return void out.skipped.push({ taskId: c.rootTask?.id ?? null, why: `batch ${c.batchId} does not exist` });
  const provider = c.rootTask ? providerOfSpec(c.rootTask.spec) : null;
  const participants: ProposedParticipant[] = [
    { id: ENGINEERING_LEAD_ID, role: 'engineering_lead', note: 'chairs and records the decision' },
    ...(provider ? [{ id: `worker-${provider}`, role: 'implementer' as const, note: `the worker provider the task ran on (${provider})` }] : []),
    ...(c.meetingType === 'technical_escalation' ? [] : [{ id: 'reviewer', role: 'reviewer' as const, note: 'an authorized reviewer the opener names with --participant' }]),
  ];
  const now = store.now();
  const id = `sg-${c.batchId}-${now.toString(36)}-${count + 1}`;
  store.db
    .prepare('INSERT INTO meeting_suggestions (id, dedupe_key, status, meeting_type, category, project, objective_id, batch_id, task_id, reason, evidence, participants, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, dedupeKey, 'pending', c.meetingType, c.category, batch.project, c.objectiveId, c.batchId, c.rootTask?.id ?? null, clip(c.reason), JSON.stringify(c.evidence), JSON.stringify(participants), now, actor);
  out.created.push(getSuggestion(store, id)!);
}

/**
 * Called by the lifecycle driver when an objective escalates on dead tasks. Each escalated task is classified by its own failure
 * category; only technical ones become suggestions. Idempotent and bounded (see the module comment). One transaction.
 */
export function suggestForDeadTasks(store: SchedulerStore, input: { objectiveId: string; batchId: string; tasks: readonly TaskRow[]; actor: string }): SuggestOutcome {
  const out: SuggestOutcome = { created: [], skipped: [] };
  store.transact(() => {
    ensureSchema(store);
    for (const task of input.tasks) {
      const cls = classifyEscalation(task.failureCategory);
      if (cls.kind !== 'technical') {
        out.skipped.push({ taskId: task.id, why: cls.kind === 'operator' ? `operator decision, not a meeting: ${cls.why}` : cls.why });
        continue;
      }
      const review = store.latestReview(task.id);
      const evidence: MeetingSuggestion['evidence'] = [{ kind: 'task', ref: task.id, detail: `${task.state} [${task.failureCategory}]` }];
      if (review?.decision) evidence.push({ kind: 'review', ref: String(review.id), detail: `${review.decision} by ${review.reviewer ?? 'unknown'}` });
      insert(store, {
        meetingType: cls.meetingType,
        category: task.failureCategory!,
        objectiveId: input.objectiveId,
        batchId: input.batchId,
        rootTask: rootOf(store, task),
        reason: `${task.id} is ${task.state} [${task.failureCategory}]: ${task.stateReason ?? 'no reason recorded'}`,
        evidence,
      }, input.actor, out);
    }
  });
  return out;
}

/** Called when the pinned oracle rejects an integrated objective (NOT_ACCEPTED): one objective-level suggestion. */
export function suggestForRejectedObjective(store: SchedulerStore, input: { objectiveId: string; batchId: string; detail: string; evidenceHash: string; actor: string }): SuggestOutcome {
  const out: SuggestOutcome = { created: [], skipped: [] };
  store.transact(() => {
    ensureSchema(store);
    insert(store, {
      meetingType: 'acceptance_failure', category: 'not_accepted', objectiveId: input.objectiveId, batchId: input.batchId, rootTask: null,
      reason: `objective ${input.objectiveId} is NOT_ACCEPTED by its pinned oracle: ${input.detail}`,
      evidence: [{ kind: 'lifecycle', ref: input.objectiveId, detail: `acceptance evidence ${input.evidenceHash.slice(0, 16)}` }],
    }, input.actor, out);
  });
  return out;
}

/** The explicit decision on a pending suggestion. Once decided, it never changes (enforced by the table's trigger too). */
export function decideSuggestion(store: SchedulerStore, id: string, decision: { status: 'accepted'; by: string; sessionId: string } | { status: 'dismissed'; by: string; reason: string }): MeetingSuggestion {
  return store.transact(() => {
    const s = getSuggestion(store, id);
    if (!s) throw new SuggestionError('not_found', `no meeting suggestion ${id}`);
    if (s.status !== 'pending') throw new SuggestionError('not_pending', `suggestion ${id} is already ${s.status}`);
    if (decision.status === 'dismissed' && !decision.reason.trim()) throw new SuggestionError('invalid', 'dismissing a suggestion needs a reason');
    store.db
      .prepare('UPDATE meeting_suggestions SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ?, session_id = ? WHERE id = ?')
      .run(decision.status, store.now(), decision.by, decision.status === 'dismissed' ? decision.reason : null, decision.status === 'accepted' ? decision.sessionId : null, id);
    return getSuggestion(store, id)!;
  });
}

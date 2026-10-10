import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LEASED_STATES,
  OWNING_STATES,
  TRANSITIONS,
  batchPlanSchema,
  languageOfSpec,
  ownedFilesOf,
  providerOfSpec,
  taskSpecSchema,
  type BatchPlan,
  type BatchPlanInput,
  type FailureCategory,
  type TaskSpec,
  type TaskState,
} from './types.ts';
import { DEFAULT_PROVIDER_ID } from '../execution/worker-provider.ts';

/**
 * SQLite-backed backlog. Every state change goes through `transition()` (one IMMEDIATE transaction: read row,
 * validate the lifecycle edge, validate the fencing token, write the row and the audit event together).
 *
 * Concurrency model: `claim()` is a single IMMEDIATE transaction, so two schedulers (threads, processes) sharing the
 * DB file can never claim the same task. Each claim bumps `claim_epoch`; a worker presents (owner, epoch) with every
 * later write ("fence"), so a worker whose lease expired and whose task was re-claimed can never write a result.
 */

export class StoreError extends Error {
  code: 'not_found' | 'illegal_transition' | 'state_mismatch' | 'stale_owner' | 'duplicate' | 'invalid' | 'corrupt';
  constructor(code: StoreError['code'], message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export interface Fence {
  owner: string;
  epoch: number;
}

export interface TaskRow {
  id: string;
  batchId: string;
  project: string;
  title: string;
  priority: number;
  language: string | null;
  repository: string;
  spec: TaskSpec;
  state: TaskState;
  stateReason: string | null;
  assignedWorker: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  claimEpoch: number;
  runId: string | null;
  runIds: string[];
  attempts: number; // coding attempts used, summed over runs
  claims: number;
  runtimeRequeues: number;
  runtimeRetries: number;
  reviewOutcome: string | null;
  artifacts: Record<string, unknown>;
  worktreePath: string | null;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  correctionOf: string | null;
  supersededBy: string | null;
  corrections: number;
  feedback: string | null;
  executor: 'worker' | 'claude';
  implementedBy: 'worker' | 'claude' | null;
  failureCategory: string | null;
  result: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
  codingMs: number;
  verifyMs: number;
}

export interface BatchRow {
  id: string;
  project: string;
  repository: string;
  description: string;
  baseRef: string | null;
  baseCommit: string | null;
  integrationBranch: string | null;
  integrationCommands: string[][];
  linkPaths: string[];
  snapshotPaths: string[];
  createdAt: number;
}

export interface EventRow {
  seq: number;
  taskId: string;
  at: number;
  from: string | null;
  to: string;
  actor: string;
  reason: string | null;
  detail: Record<string, unknown> | null;
}

/** One fact about whether a DONE task's implementation is still integrated. Append-only. */
export interface IntegrationFact {
  seq: number;
  taskId: string;
  at: number;
  kind: 'reverted' | 'reinstated';
  actor: string;
  reason: string;
  /** The commit that reverted (or re-integrated) the implementation, when the recorder knew it. */
  commit: string | null;
}

export type IntegrationState = 'integrated' | 'reverted' | 'not_integrated';

/**
 * Execution, integration and acceptance are three facts, not one:
 *   execution   what the scheduler lifecycle recorded (DONE is terminal and never rewritten);
 *   integration whether the implementation is STILL in the integration branch (an append-only fact; DONE alone claims nothing);
 *   accepted    derived: DONE and currently integrated. A reverted implementation is never currently accepted.
 */
export interface TaskProjection {
  taskId: string;
  execution: { state: TaskState; finishedAt: number | null };
  integration: { state: IntegrationState; since: number | null; history: IntegrationFact[] };
  accepted: boolean;
}

export interface ReviewRow {
  id: number;
  taskId: string;
  round: number;
  createdAt: number;
  request: Record<string, any>;
  decision: 'APPROVED' | 'REJECTED_WITH_FEEDBACK' | 'ESCALATED_TO_HUMAN' | null;
  feedback: string | null;
  reviewer: string | null;
  decidedAt: number | null;
}

/** Lease expiries per task that give the claim back (see reapExpired). */
export const MAX_LEASE_REFUNDS = 3;
/** The task spec schema's own ceiling on maxClaims. */
const MAX_CLAIMS_CAP = 10;

/** Columns a caller may change alongside a transition. Anything else is rejected. */
const PATCHABLE = {
  stateReason: 'state_reason',
  assignedWorker: 'assigned_worker',
  runId: 'run_id',
  attempts: 'attempts',
  runtimeRequeues: 'runtime_requeues',
  runtimeRetries: 'runtime_retries',
  reviewOutcome: 'review_outcome',
  worktreePath: 'worktree_path',
  branch: 'branch',
  baseCommit: 'base_commit',
  headCommit: 'head_commit',
  supersededBy: 'superseded_by',
  corrections: 'corrections',
  feedback: 'feedback',
  implementedBy: 'implemented_by',
  failureCategory: 'failure_category',
  codingMs: 'coding_ms',
  verifyMs: 'verify_ms',
  finishedAt: 'finished_at',
  executor: 'executor',
} as const;
type Patch = Partial<{ [K in keyof typeof PATCHABLE]: unknown }> & { result?: Record<string, unknown> | null; artifacts?: Record<string, unknown> };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, repository TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  base_ref TEXT, base_commit TEXT, integration_branch TEXT,
  integration_commands TEXT NOT NULL DEFAULT '[]', link_paths TEXT NOT NULL DEFAULT '[]', snapshot_paths TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), project TEXT NOT NULL, title TEXT NOT NULL,
  priority INTEGER NOT NULL, language TEXT, repository TEXT NOT NULL, spec TEXT NOT NULL,
  state TEXT NOT NULL, state_reason TEXT,
  assigned_worker TEXT, lease_owner TEXT, lease_expires_at INTEGER, claim_epoch INTEGER NOT NULL DEFAULT 0,
  run_id TEXT, run_ids TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0, claims INTEGER NOT NULL DEFAULT 0,
  runtime_requeues INTEGER NOT NULL DEFAULT 0, runtime_retries INTEGER NOT NULL DEFAULT 0,
  review_outcome TEXT, artifacts TEXT NOT NULL DEFAULT '{}',
  worktree_path TEXT, branch TEXT, base_commit TEXT, head_commit TEXT,
  correction_of TEXT, superseded_by TEXT, corrections INTEGER NOT NULL DEFAULT 0, feedback TEXT,
  executor TEXT NOT NULL, implemented_by TEXT, failure_category TEXT, result TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_at INTEGER, finished_at INTEGER,
  coding_ms INTEGER NOT NULL DEFAULT 0, verify_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS tasks_batch ON tasks(batch_id);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL,
  from_state TEXT, to_state TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, round INTEGER NOT NULL, created_at INTEGER NOT NULL,
  request TEXT NOT NULL, decision TEXT, feedback TEXT, reviewer TEXT, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
-- M10.1: whether a DONE task's implementation is STILL integrated is a separate, append-only fact. DONE is terminal and the
-- task row and its events are history; a revert is recorded here (and as one audit event), never by rewriting them.
CREATE TABLE IF NOT EXISTS integration_facts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reverted', 'reinstated')), actor TEXT NOT NULL, reason TEXT NOT NULL, commit_sha TEXT
);
CREATE INDEX IF NOT EXISTS integration_facts_task ON integration_facts(task_id);
CREATE TRIGGER IF NOT EXISTS integration_facts_no_update BEFORE UPDATE ON integration_facts BEGIN SELECT RAISE(ABORT, 'integration_facts is append-only'); END;
CREATE TRIGGER IF NOT EXISTS integration_facts_no_delete BEFORE DELETE ON integration_facts BEGIN SELECT RAISE(ABORT, 'integration_facts is append-only'); END;
`;

const json = (v: unknown) => JSON.stringify(v);

/**
 * Parses a JSON column. Malformed data raises StoreError('corrupt') naming the row and column: list reads skip
 * (quarantine) such rows and report them via corruptRows(), so one damaged row can no longer take down every command.
 * Nothing rewrites the row; repairing it is a human decision.
 */
function parseJson(table: string, id: unknown, column: string, text: unknown): any {
  try {
    return JSON.parse(String(text));
  } catch (err) {
    throw new StoreError('corrupt', `${table} ${String(id)}: column ${column} is not valid JSON (${(err as Error).message})`);
  }
}

const isCorrupt = (err: unknown): err is StoreError => err instanceof StoreError && err.code === 'corrupt';

export interface CorruptRow {
  table: 'tasks' | 'batches' | 'reviews';
  id: string;
  state?: string;
  error: string;
}

function rowToTask(r: Record<string, any>): TaskRow {
  return {
    id: r.id,
    batchId: r.batch_id,
    project: r.project,
    title: r.title,
    priority: r.priority,
    language: r.language,
    repository: r.repository,
    spec: parseJson('task', r.id, 'spec', r.spec),
    state: r.state,
    stateReason: r.state_reason,
    assignedWorker: r.assigned_worker,
    leaseOwner: r.lease_owner,
    leaseExpiresAt: r.lease_expires_at,
    claimEpoch: r.claim_epoch,
    runId: r.run_id,
    runIds: parseJson('task', r.id, 'run_ids', r.run_ids),
    attempts: r.attempts,
    claims: r.claims,
    runtimeRequeues: r.runtime_requeues,
    runtimeRetries: r.runtime_retries,
    reviewOutcome: r.review_outcome,
    artifacts: parseJson('task', r.id, 'artifacts', r.artifacts),
    worktreePath: r.worktree_path,
    branch: r.branch,
    baseCommit: r.base_commit,
    headCommit: r.head_commit,
    correctionOf: r.correction_of,
    supersededBy: r.superseded_by,
    corrections: r.corrections,
    feedback: r.feedback,
    executor: r.executor,
    implementedBy: r.implemented_by,
    failureCategory: r.failure_category,
    result: r.result ? parseJson('task', r.id, 'result', r.result) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    claimedAt: r.claimed_at,
    finishedAt: r.finished_at,
    codingMs: r.coding_ms,
    verifyMs: r.verify_ms,
  };
}

function rowToBatch(r: Record<string, any>): BatchRow {
  return {
    id: r.id,
    project: r.project,
    repository: r.repository,
    description: r.description,
    baseRef: r.base_ref,
    baseCommit: r.base_commit,
    integrationBranch: r.integration_branch,
    integrationCommands: parseJson('batch', r.id, 'integration_commands', r.integration_commands),
    linkPaths: parseJson('batch', r.id, 'link_paths', r.link_paths),
    snapshotPaths: parseJson('batch', r.id, 'snapshot_paths', r.snapshot_paths),
    createdAt: r.created_at,
  };
}

export interface ClaimOptions {
  workerId: string;
  languages: string[];
  leaseMs: number;
  /** Max tasks leased (CLAIMED/CODING/VERIFYING) at once, counted inside the claim transaction. */
  maxActive: number;
  /** Optional: only claim from this batch. */
  batchId?: string;
  /** Max distinct tasks of one batch that may ever be claimed (a task already counted may be re-claimed). */
  maxTasksPerBatch?: number;
}

export interface Claim {
  task: TaskRow;
  fence: Fence;
}

export class SchedulerStore {
  readonly db: DatabaseSync;
  /** Injectable clock: tests drive lease expiry deterministically. */
  now: () => number;

  constructor(path: string, options: { now?: () => number; busyTimeoutMs?: number } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = options.now ?? Date.now;
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 10_000))}; PRAGMA foreign_keys = ON;`);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private txDepth = 0;

  /** Runs fn inside BEGIN IMMEDIATE ... COMMIT (rolls back on throw). Nested calls join the outer transaction. */
  private tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  // ---- reads -------------------------------------------------------------------------------------------------

  getTask(id: string): TaskRow | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return r ? rowToTask(r) : undefined;
  }

  requireTask(id: string): TaskRow {
    const t = this.getTask(id);
    if (!t) throw new StoreError('not_found', `task ${id} not found`);
    return t;
  }

  /** Parseable task rows only: a corrupt row is quarantined (skipped here, reported by corruptRows()). */
  listTasks(filter: { batchId?: string; states?: readonly TaskState[] } = {}): TaskRow[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at ASC, id ASC').all().flatMap((r) => this.parseOrSkip(rowToTask, r));
    return rows.filter((t) => (!filter.batchId || t.batchId === filter.batchId) && (!filter.states || filter.states.includes(t.state)));
  }

  private parseOrSkip<T>(parse: (r: Record<string, any>) => T, row: Record<string, any>): T[] {
    try {
      return [parse(row)];
    } catch (err) {
      if (isCorrupt(err)) return [];
      throw err;
    }
  }

  /** Every row that cannot be parsed, with the reason. Read-only: repairing or deleting a row is left to a human. */
  corruptRows(): CorruptRow[] {
    const out: CorruptRow[] = [];
    const check = (table: CorruptRow['table'], parse: (r: Record<string, any>) => unknown, sql: string) => {
      for (const r of this.db.prepare(sql).all() as Record<string, any>[]) {
        try {
          parse(r);
        } catch (err) {
          if (isCorrupt(err)) out.push({ table, id: String(r.id), state: r.state, error: err.message });
          else throw err;
        }
      }
    };
    check('tasks', rowToTask, 'SELECT * FROM tasks ORDER BY id');
    check('batches', rowToBatch, 'SELECT * FROM batches ORDER BY id');
    check('reviews', rowToReview, 'SELECT * FROM reviews ORDER BY id');
    return out;
  }

  getBatch(id: string): BatchRow | undefined {
    const r = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
    return r ? rowToBatch(r) : undefined;
  }

  listBatches(): BatchRow[] {
    return this.db.prepare('SELECT * FROM batches ORDER BY created_at ASC').all().flatMap((r) => this.parseOrSkip(rowToBatch, r));
  }

  events(taskId?: string): EventRow[] {
    const rows = taskId
      ? this.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY seq').all(taskId)
      : this.db.prepare('SELECT * FROM events ORDER BY seq').all();
    return rows.map((r: Record<string, any>) => ({
      seq: r.seq,
      taskId: r.task_id,
      at: r.at,
      from: r.from_state,
      to: r.to_state,
      actor: r.actor,
      reason: r.reason,
      detail: r.detail ? (() => { try { return JSON.parse(r.detail); } catch { return { corrupt: true }; } })() : null,
    }));
  }

  // ---- integration facts (execution vs integration vs acceptance) -------------------------------------------------

  integrationFacts(taskId: string): IntegrationFact[] {
    const rows = this.db.prepare('SELECT * FROM integration_facts WHERE task_id = ? ORDER BY seq').all(taskId) as Record<string, any>[];
    return rows.map((r) => ({ seq: r.seq, taskId: r.task_id, at: r.at, kind: r.kind, actor: r.actor, reason: r.reason, commit: r.commit_sha }));
  }

  /** The newest integration fact of a task, if any. */
  private latestFact(taskId: string): IntegrationFact | undefined {
    return this.integrationFacts(taskId).at(-1);
  }

  /** True while the task's implementation is recorded as reverted (its latest fact is a revert). */
  isReverted(taskId: string): boolean {
    return this.latestFact(taskId)?.kind === 'reverted';
  }

  /** Every task whose implementation is currently recorded as reverted. One query, for list views and metrics. */
  revertedTaskIds(): Set<string> {
    const rows = this.db.prepare("SELECT task_id FROM integration_facts f WHERE kind = 'reverted' AND seq = (SELECT MAX(seq) FROM integration_facts WHERE task_id = f.task_id)").all() as { task_id: string }[];
    return new Set(rows.map((r) => r.task_id));
  }

  projection(taskId: string): TaskProjection {
    const task = this.requireTask(taskId);
    const history = this.integrationFacts(taskId);
    const integration: IntegrationState = task.state !== 'DONE' ? 'not_integrated' : history.at(-1)?.kind === 'reverted' ? 'reverted' : 'integrated';
    return {
      taskId,
      execution: { state: task.state, finishedAt: task.finishedAt },
      integration: { state: integration, since: history.at(-1)?.at ?? null, history },
      accepted: integration === 'integrated',
    };
  }

  /**
   * Records that a DONE task's implementation is no longer integrated (typically a `git revert` after DONE). The task row and
   * every earlier event stay exactly as they were: DONE is terminal and is history. One fact and one audit event are appended,
   * atomically. Refused for a task that is not DONE, that is already reverted, or without a reason.
   */
  recordRevert(taskId: string, input: { actor: string; reason: string; commit?: string }): TaskProjection {
    return this.recordIntegrationFact(taskId, 'reverted', input);
  }

  /** The opposing fact: the implementation was integrated again. Only a reverted implementation can be reinstated. */
  recordReinstatement(taskId: string, input: { actor: string; reason: string; commit?: string }): TaskProjection {
    return this.recordIntegrationFact(taskId, 'reinstated', input);
  }

  private recordIntegrationFact(taskId: string, kind: IntegrationFact['kind'], input: { actor: string; reason: string; commit?: string }): TaskProjection {
    const reason = input.reason?.trim();
    if (!reason) throw new StoreError('invalid', `an integration ${kind === 'reverted' ? 'revert' : 'reinstatement'} needs a reason (it is part of the audit trail)`);
    if (!input.actor?.trim()) throw new StoreError('invalid', 'an integration fact needs an actor');
    return this.tx(() => {
      const task = this.requireTask(taskId);
      if (task.state !== 'DONE') throw new StoreError('state_mismatch', `task ${taskId} is ${task.state}; only a DONE task has an implementation to ${kind === 'reverted' ? 'revert' : 'reinstate'}`);
      const reverted = this.latestFact(taskId)?.kind === 'reverted';
      if (kind === 'reverted' && reverted) throw new StoreError('state_mismatch', `task ${taskId}: the implementation is already recorded as reverted`);
      if (kind === 'reinstated' && !reverted) throw new StoreError('state_mismatch', `task ${taskId}: the implementation is not recorded as reverted, so there is nothing to reinstate`);
      const now = this.now();
      this.db.prepare('INSERT INTO integration_facts (task_id, at, kind, actor, reason, commit_sha) VALUES (?,?,?,?,?,?)').run(taskId, now, kind, input.actor, reason, input.commit ?? null);
      this.db
        .prepare('INSERT INTO events (task_id, at, from_state, to_state, actor, reason, detail) VALUES (?,?,?,?,?,?,?)')
        .run(taskId, now, 'DONE', 'DONE', input.actor, `integration ${kind}: ${reason}${input.commit ? ` (${input.commit})` : ''}`, json({ integration: kind, commit: input.commit ?? null }));
      return this.projection(taskId);
    });
  }

  // ---- planning ----------------------------------------------------------------------------------------------

  /** Creates a batch and its tasks in BACKLOG. Plans are append-only: an existing batch/task id is an error. */
  createBatch(input: BatchPlanInput, actor = 'lead'): BatchPlan {
    const plan = batchPlanSchema.parse(input);
    const ids = new Set<string>();
    for (const t of plan.tasks) {
      if (ids.has(t.id)) throw new StoreError('invalid', `duplicate task id ${t.id} in plan`);
      ids.add(t.id);
    }
    for (const t of plan.tasks) {
      for (const dep of t.dependsOn) {
        if (dep === t.id) throw new StoreError('invalid', `task ${t.id} depends on itself`);
        if (!ids.has(dep) && !this.getTask(dep)) throw new StoreError('invalid', `task ${t.id} depends on unknown task ${dep}`);
      }
      if (t.executor === 'worker' && !t.request) throw new StoreError('invalid', `worker task ${t.id} needs a request (contract + assessment)`);
      if (t.executor === 'claude' && !t.keptReason) throw new StoreError('invalid', `claude task ${t.id} needs a keptReason`);
    }
    assertAcyclic(plan.tasks);
    const now = this.now();
    this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM batches WHERE id = ?').get(plan.batchId)) throw new StoreError('duplicate', `batch ${plan.batchId} already exists`);
      this.db
        .prepare('INSERT INTO batches (id, project, repository, description, base_ref, integration_commands, link_paths, snapshot_paths, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(plan.batchId, plan.project, plan.repository, plan.description, plan.baseRef ?? null, json(plan.integrationCommands), json(plan.linkPaths), json(plan.snapshotPaths), now);
      for (const t of plan.tasks) this.insertTask(plan.batchId, plan.project, plan.repository, t, null, now, actor);
    });
    return plan;
  }

  private insertTask(batchId: string, project: string, repository: string, spec: TaskSpec, correctionOf: string | null, now: number, actor: string, corrections = 0): void {
    if (this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(spec.id)) throw new StoreError('duplicate', `task ${spec.id} already exists`);
    this.db
      .prepare(
        `INSERT INTO tasks (id, batch_id, project, title, priority, language, repository, spec, state, executor, correction_of, corrections, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(spec.id, batchId, project, spec.title, spec.priority, languageOfSpec(spec) ?? null, repository, json(spec), 'BACKLOG', spec.executor, correctionOf, corrections, now, now);
    this.db.prepare('INSERT INTO events (task_id, at, from_state, to_state, actor, reason) VALUES (?,?,?,?,?,?)').run(spec.id, now, null, 'BACKLOG', actor, correctionOf ? `correction of ${correctionOf}` : 'planned');
  }

  /** Adds a bounded correction task (used by review). `spec.id` must be new. */
  addCorrectionTask(of: TaskRow, spec: TaskSpec, actor: string): void {
    const now = this.now();
    this.tx(() => this.insertTask(of.batchId, of.project, of.repository, taskSpecSchema.parse(spec), of.id, now, actor));
  }

  setBatchBase(batchId: string, patch: { baseCommit?: string; integrationBranch?: string }): void {
    this.db.prepare('UPDATE batches SET base_commit = COALESCE(?, base_commit), integration_branch = COALESCE(?, integration_branch) WHERE id = ?').run(patch.baseCommit ?? null, patch.integrationBranch ?? null, batchId);
  }

  // ---- dependency resolution --------------------------------------------------------------------------------

  /** Follows superseded_by (rejected -> correction) so dependents track the live replacement. */
  resolveDependency(id: string): TaskRow | undefined {
    let t = this.getTask(id);
    for (let hops = 0; t?.supersededBy && hops < 20; hops++) t = this.getTask(t.supersededBy);
    return t;
  }

  /**
   * The DAG contract. A task is executable only when EVERY dependency is DONE (reviewed, approved, integrated and
   * verified on the batch's integration branch; so the dependent's worktree, cut from that branch, contains it).
   *
   *  - 'ready':   all dependencies DONE.
   *  - 'waiting': at least one dependency is still on its way to DONE (BACKLOG, READY, running, REVIEW_PENDING,
   *               APPROVED, INTEGRATING, REVIEW_REJECTED with a live correction, or RUNTIME_FAILURE with claims left
   *               for a retry). `waitingOn` names each of them with its state, so a waiting task is never a mystery.
   *  - 'failed':  a dependency can never reach DONE without a human decision: ESCALATED, CANCELLED, BLOCKED, a rejection
   *               with no correction, a RUNTIME_FAILURE whose claim budget is spent, or a missing task. `promote` turns
   *               the dependent into BLOCKED(dependency_failed) with the reason below, transitively, so no descendant
   *               is left waiting for something that cannot happen. It returns to BACKLOG on its own if the
   *               dependency is later recovered (retry / take-over).
   */
  dependencyStatus(task: TaskRow): { status: 'ready' | 'waiting' | 'failed'; reason?: string; waitingOn: { id: string; state: TaskState }[] } {
    const waitingOn: { id: string; state: TaskState }[] = [];
    for (const depId of task.spec.dependsOn) {
      let dep: TaskRow | undefined;
      try {
        dep = this.resolveDependency(depId);
      } catch (err) {
        // never treat an unreadable dependency as done or as failed: wait until a human repairs the row
        if (isCorrupt(err)) return { status: 'waiting', reason: err.message, waitingOn };
        throw err;
      }
      if (!dep) return { status: 'failed', reason: `dependency ${depId} does not exist`, waitingOn: [] };
      if (dep.state === 'DONE') {
        // DONE is history; whether the code is still there is the integration fact. A reverted dependency satisfies nobody.
        const fact = this.latestFact(dep.id);
        if (fact?.kind === 'reverted') return { status: 'failed', reason: `dependency ${dep.id} is DONE but its implementation was reverted${fact.commit ? ` (${fact.commit})` : ''}: ${fact.reason}`, waitingOn: [] };
        continue;
      }
      if (['ESCALATED', 'CANCELLED', 'BLOCKED'].includes(dep.state) || (dep.state === 'REVIEW_REJECTED' && !dep.supersededBy)) {
        const cause = dep.state === 'BLOCKED' && dep.failureCategory === 'dependency_failed' && dep.stateReason ? ` (${dep.stateReason})` : '';
        return { status: 'failed', reason: `dependency ${dep.id} is ${dep.state}${cause}`, waitingOn: [] };
      }
      if (dep.state === 'RUNTIME_FAILURE' && dep.claims >= dep.spec.maxClaims) {
        return { status: 'failed', reason: `dependency ${dep.id} is RUNTIME_FAILURE with its claim budget spent (${dep.claims}/${dep.spec.maxClaims}); it cannot be retried`, waitingOn: [] };
      }
      waitingOn.push({ id: dep.id, state: dep.state });
    }
    return waitingOn.length > 0 ? { status: 'waiting', waitingOn } : { status: 'ready', waitingOn };
  }

  /**
   * BACKLOG -> READY when all dependencies are DONE; BACKLOG -> BLOCKED when one failed for good; a task that was
   * BLOCKED only because of a dependency returns to BACKLOG/READY once that dependency recovers.
   */
  promote(actor = 'scheduler'): { ready: string[]; blocked: string[]; unblocked: string[] } {
    const out = { ready: [] as string[], blocked: [] as string[], unblocked: [] as string[] };
    for (const task of this.listTasks({ states: ['BACKLOG', 'BLOCKED'] })) {
      if (task.state === 'BLOCKED' && task.failureCategory !== 'dependency_failed') continue;
      const dep = this.dependencyStatus(task);
      try {
        if (task.state === 'BACKLOG') {
          if (dep.status === 'ready') {
            this.transition(task.id, 'READY', { actor, reason: 'dependencies satisfied', expectFrom: 'BACKLOG' });
            out.ready.push(task.id);
          } else if (dep.status === 'failed') {
            this.transition(task.id, 'BLOCKED', { actor, reason: dep.reason, expectFrom: 'BACKLOG', patch: { failureCategory: 'dependency_failed' } satisfies Patch });
            out.blocked.push(task.id);
          }
        } else if (dep.status !== 'failed') {
          this.transition(task.id, 'BACKLOG', { actor, reason: 'dependency recovered', expectFrom: 'BLOCKED', patch: { failureCategory: null } });
          out.unblocked.push(task.id);
        }
      } catch (err) {
        if (!(err instanceof StoreError && err.code === 'state_mismatch')) throw err; // raced with another scheduler: fine
      }
    }
    return out;
  }

  // ---- claim / lease ----------------------------------------------------------------------------------------

  /**
   * Atomically picks the best claimable READY task and leases it. Honors: dependencies, priority, worker language,
   * file ownership (no overlap with any task that still holds un-integrated work), maxActive, and the claim budget.
   * Returns undefined when nothing is claimable right now.
   */
  claim(options: ClaimOptions): Claim | undefined {
    return this.tx(() => {
      const now = this.now();
      const leased = (this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state IN (${LEASED_STATES.map(() => '?').join(',')})`).get(...LEASED_STATES) as { n: number }).n;
      if (leased >= options.maxActive) return undefined;

      const owned = new Set<string>();
      // A corrupt row that may hold files has an unknown ownership set: fail closed for its whole repository.
      const unknownOwnership = new Set<string>();
      const holdingRows = this.db.prepare(`SELECT id, repository, spec FROM tasks WHERE state IN (${OWNING_STATES.map(() => '?').join(',')})`).all(...OWNING_STATES) as { id: string; repository: string; spec: string }[];
      for (const h of holdingRows) {
        try {
          for (const f of ownedFilesOf(parseJson('task', h.id, 'spec', h.spec) as TaskSpec)) owned.add(f);
        } catch (err) {
          if (!isCorrupt(err)) throw err;
          unknownOwnership.add(h.repository);
        }
      }

      const candidates = this.db
        .prepare(`SELECT * FROM tasks WHERE state = 'READY' AND executor = 'worker' ORDER BY priority DESC, created_at ASC, id ASC`)
        .all()
        .flatMap((r) => this.parseOrSkip(rowToTask, r));
      for (const task of candidates) {
        if (unknownOwnership.has(task.repository)) continue;
        if (options.batchId && task.batchId !== options.batchId) continue;
        if (task.language && !options.languages.includes(task.language)) continue;
        if (task.claims >= task.spec.maxClaims) continue;
        if (this.dependencyStatus(task).status !== 'ready') continue;
        if (options.maxTasksPerBatch && task.claims === 0) {
          const used = (this.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE batch_id = ? AND claims > 0').get(task.batchId) as { n: number }).n;
          if (used >= options.maxTasksPerBatch) continue;
        }
        if (ownedFilesOf(task.spec).some((f) => owned.has(f))) continue;

        const epoch = task.claimEpoch + 1;
        const res = this.db
          .prepare(
            `UPDATE tasks SET state = 'CLAIMED', lease_owner = ?, lease_expires_at = ?, claim_epoch = ?, claims = claims + 1,
               assigned_worker = ?, claimed_at = ?, updated_at = ?, state_reason = NULL
             WHERE id = ? AND state = 'READY' AND claim_epoch = ?`,
          )
          .run(options.workerId, now + options.leaseMs, epoch, options.workerId, now, now, task.id, task.claimEpoch);
        if (Number(res.changes) !== 1) continue;
        this.db
          .prepare('INSERT INTO events (task_id, at, from_state, to_state, actor, reason, detail) VALUES (?,?,?,?,?,?,?)')
          .run(task.id, now, 'READY', 'CLAIMED', options.workerId, `claim #${task.claims + 1}`, json({ epoch, leaseExpiresAt: now + options.leaseMs }));
        return { task: this.requireTask(task.id), fence: { owner: options.workerId, epoch } };
      }
      return undefined;
    });
  }

  /** Extends the lease iff the caller still owns it. False means the lease was lost: stop working. */
  heartbeat(id: string, fence: Fence, leaseMs: number): boolean {
    const now = this.now();
    const res = this.db
      .prepare(
        `UPDATE tasks SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND claim_epoch = ? AND state IN (${LEASED_STATES.map(() => '?').join(',')})`,
      )
      .run(now + leaseMs, now, id, fence.owner, fence.epoch, ...LEASED_STATES);
    return Number(res.changes) === 1;
  }

  /** Returns tasks whose lease has expired to READY (or RUNTIME_FAILURE once the claim budget is spent). */
  reapExpired(actor = 'scheduler'): { requeued: string[]; exhausted: string[] } {
    const out = { requeued: [] as string[], exhausted: [] as string[] };
    const now = this.now();
    const expired = this.listTasks({ states: LEASED_STATES }).filter((t) => t.leaseExpiresAt !== null && t.leaseExpiresAt < now);
    for (const t of expired) {
      const detail = { previousOwner: t.leaseOwner, epoch: t.claimEpoch, expiredAt: t.leaseExpiresAt };
      // `leaseExpiredBefore` re-checks expiry inside the transition's transaction: the owner (another process) may have
      // heartbeated between the read above and this write, and a renewed lease must never be reaped.
      const guard = { expectFrom: t.state, fence: { owner: t.leaseOwner ?? '', epoch: t.claimEpoch }, leaseExpiredBefore: now, detail, releaseLease: true };
      try {
        // A lease normally expires because the HOST stalled (laptop asleep, event loop blocked), which says nothing about the
        // task. The first MAX_LEASE_REFUNDS expiries therefore give the claim back, so a stalled host does not spend the
        // task's attempts; after that an expiry counts like any other claim, so a task that keeps losing its lease still
        // ends in RUNTIME_FAILURE (bounded). The count is kept in artifacts.leaseExpiries (no schema change).
        const expiries = Number(t.artifacts.leaseExpiries ?? 0);
        if (providerOfSpec(t.spec) !== DEFAULT_PROVIDER_ID) {
          // A non-default provider is paid/quota-limited: a lost lease never turns into a second automatic call. The previous
          // run is still adoptable by an explicit `lead retry`, which is a human decision.
          this.transition(t.id, 'RUNTIME_FAILURE', { actor, reason: `lease expired; not requeued automatically (provider "${providerOfSpec(t.spec)}" is not the default); an explicit retry starts a NEW paid call: lead retry ${t.id}`, ...guard, patch: { failureCategory: 'lease_expired' satisfies FailureCategory } });
          out.exhausted.push(t.id);
        } else if (expiries < MAX_LEASE_REFUNDS) {
          this.transition(t.id, 'READY', { actor, reason: `lease expired; requeued (claim refunded ${expiries + 1}/${MAX_LEASE_REFUNDS})`, ...guard, refundClaim: true, patch: { artifacts: { leaseExpiries: expiries + 1 } } });
          out.requeued.push(t.id);
        } else if (t.claims >= t.spec.maxClaims) {
          this.transition(t.id, 'RUNTIME_FAILURE', { actor, reason: 'lease expired and claim budget exhausted', ...guard, patch: { failureCategory: 'lease_expired' satisfies FailureCategory } });
          out.exhausted.push(t.id);
        } else {
          this.transition(t.id, 'READY', { actor, reason: 'lease expired; requeued', ...guard });
          out.requeued.push(t.id);
        }
      } catch (err) {
        if (!(err instanceof StoreError && (err.code === 'stale_owner' || err.code === 'state_mismatch'))) throw err; // worker finished/heartbeat won the race
      }
    }
    return out;
  }

  /**
   * Audited recovery of a task whose claim budget is spent: raises its maxClaims (hard cap: the spec schema's maximum) so it
   * can be claimed again. Only a RUNTIME_FAILURE task qualifies. The grant is recorded as an event and in
   * artifacts.recoveries; `dependencyStatus` stops reporting the task as a dead end as soon as claims < maxClaims.
   * Returning the task to READY is a separate, explicit transition (see src/lead/recovery.ts).
   */
  grantClaims(id: string, extra: number, actor: string, reason: string): TaskRow {
    if (!Number.isInteger(extra) || extra < 1) throw new StoreError('invalid', 'extra claims must be a positive integer');
    if (!reason.trim()) throw new StoreError('invalid', 'a recovery needs a reason');
    return this.tx(() => {
      const task = this.requireTask(id);
      if (task.state !== 'RUNTIME_FAILURE') throw new StoreError('state_mismatch', `task ${id} is ${task.state}; only a RUNTIME_FAILURE task is granted claims`);
      const maxClaims = Math.min(MAX_CLAIMS_CAP, task.spec.maxClaims + extra);
      if (maxClaims <= task.claims) throw new StoreError('invalid', `task ${id} has used ${task.claims} claims and the hard limit is ${MAX_CLAIMS_CAP}; escalate it or take it over instead`);
      const now = this.now();
      const recoveries = [...((task.artifacts.recoveries as unknown[] | undefined) ?? []), { at: now, actor, action: 'grant_claims', reason, from: task.spec.maxClaims, to: maxClaims }];
      this.db.prepare('UPDATE tasks SET spec = ?, artifacts = ?, updated_at = ? WHERE id = ?').run(json({ ...task.spec, maxClaims }), json({ ...task.artifacts, recoveries }), now, id);
      this.db
        .prepare('INSERT INTO events (task_id, at, from_state, to_state, actor, reason, detail) VALUES (?,?,?,?,?,?,?)')
        .run(id, now, task.state, task.state, actor, `claim budget raised ${task.spec.maxClaims} -> ${maxClaims}: ${reason}`, json({ claims: task.claims, maxClaims }));
      return this.requireTask(id);
    });
  }

  // ---- transitions ------------------------------------------------------------------------------------------

  /**
   * The only writer of `state`. Validates the lifecycle edge, the optional expected current state, and the optional
   * fence (lease owner + claim epoch); applies a whitelisted patch; appends the audit event; all atomically.
   */
  transition(
    id: string,
    to: TaskState,
    options: {
      actor: string;
      reason?: string;
      expectFrom?: TaskState | readonly TaskState[];
      fence?: Fence;
      /** Only apply if the lease is (still) expired at this instant: guards a reaper against a concurrent heartbeat. */
      leaseExpiredBefore?: number;
      patch?: Patch;
      detail?: Record<string, unknown>;
      /** Clear lease_owner / lease_expires_at (default: cleared on every state outside the leased states). */
      releaseLease?: boolean;
      /** Creates the review request in the same transaction (used for REVIEW_PENDING). */
      review?: Record<string, unknown>;
      /** Gives back one claim (never below 0) in the same write: used when a claim was lost to the host, not to the task. */
      refundClaim?: boolean;
    },
  ): TaskRow {
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!row) throw new StoreError('not_found', `task ${id} not found`);
      const task = rowToTask(row);
      const expect = options.expectFrom === undefined ? undefined : ([] as TaskState[]).concat(options.expectFrom as TaskState | TaskState[]);
      if (expect && !expect.includes(task.state)) throw new StoreError('state_mismatch', `task ${id} is ${task.state}, expected ${expect.join('|')}`);
      if (!TRANSITIONS[task.state].includes(to)) throw new StoreError('illegal_transition', `task ${id}: ${task.state} -> ${to} is not allowed`);
      if (options.fence && (task.leaseOwner !== options.fence.owner || task.claimEpoch !== options.fence.epoch)) {
        throw new StoreError('stale_owner', `task ${id} is owned by ${task.leaseOwner}@${task.claimEpoch}, not ${options.fence.owner}@${options.fence.epoch}`);
      }
      if (options.leaseExpiredBefore !== undefined && !(task.leaseExpiresAt !== null && task.leaseExpiresAt < options.leaseExpiredBefore)) {
        throw new StoreError('state_mismatch', `task ${id}: lease was renewed (now expires at ${task.leaseExpiresAt})`);
      }

      const now = this.now();
      const sets: string[] = ['state = ?', 'updated_at = ?', 'state_reason = ?'];
      const values: unknown[] = [to, now, options.reason ?? null];
      for (const [key, value] of Object.entries(options.patch ?? {})) {
        if (key === 'result') {
          sets.push('result = ?');
          values.push(value === null ? null : json(value));
        } else if (key === 'artifacts') {
          sets.push('artifacts = ?');
          values.push(json({ ...task.artifacts, ...(value as object) }));
        } else if (key in PATCHABLE) {
          const column = PATCHABLE[key as keyof typeof PATCHABLE];
          // coding/verify time and counters accumulate; run ids are tracked as a list
          sets.push(`${column} = ?`);
          values.push(value ?? null);
        } else {
          throw new StoreError('invalid', `column ${key} is not patchable`);
        }
      }
      if (options.patch && 'runId' in options.patch && options.patch.runId) {
        sets.push('run_ids = ?');
        values.push(json([...new Set([...task.runIds, options.patch.runId as string])]));
      }
      if (options.releaseLease || !LEASED_STATES.includes(to)) sets.push('lease_owner = NULL', 'lease_expires_at = NULL');
      if (options.refundClaim) sets.push('claims = MAX(claims - 1, 0)');
      // Requeueing a SETTLED failure (retry / take-over) means "run again": the previous run's outcome is already recorded,
      // so it must not be re-adopted by the next claim's reconcile. (A lease-expiry requeue keeps run_id: that run's
      // outcome was never recorded and may still be adopted.) run_ids keeps the full history.
      if (to === 'READY' && (task.state === 'RUNTIME_FAILURE' || task.state === 'ESCALATED') && !(options.patch && 'runId' in options.patch)) sets.push('run_id = NULL');
      if (['DONE', 'CANCELLED', 'ESCALATED', 'REVIEW_REJECTED'].includes(to) && !(options.patch && 'finishedAt' in options.patch)) {
        sets.push('finished_at = ?');
        values.push(now);
      }
      this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...(values as any[]), id);
      this.db
        .prepare('INSERT INTO events (task_id, at, from_state, to_state, actor, reason, detail) VALUES (?,?,?,?,?,?,?)')
        .run(id, now, task.state, to, options.actor, options.reason ?? null, options.detail ? json(options.detail) : null);
      if (options.review) {
        const round = (this.db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE task_id = ?').get(id) as { n: number }).n + 1;
        this.db.prepare('INSERT INTO reviews (task_id, round, created_at, request) VALUES (?,?,?,?)').run(id, round, now, json(options.review));
      }
      return this.requireTask(id);
    });
  }

  /** Records a workflow run id on a task the caller owns (so a crash can be reconciled against Mastra). */
  recordRun(id: string, fence: Fence, runId: string): boolean {
    return this.tx(() => {
      const t = this.getTask(id);
      if (!t || t.leaseOwner !== fence.owner || t.claimEpoch !== fence.epoch) return false;
      this.db.prepare('UPDATE tasks SET run_id = ?, run_ids = ?, updated_at = ? WHERE id = ?').run(runId, json([...new Set([...t.runIds, runId])]), this.now(), id);
      this.db.prepare('INSERT INTO events (task_id, at, from_state, to_state, actor, reason, detail) VALUES (?,?,?,?,?,?,?)').run(id, this.now(), t.state, t.state, fence.owner, 'workflow run started', json({ runId }));
      return true;
    });
  }

  /** Appends an audit event without changing the task (e.g. a run cancellation and what it confirmed). Not fenced: it records, never decides. */
  audit(id: string, actor: string, reason: string, detail?: Record<string, unknown>): void {
    this.tx(() => {
      const t = this.requireTask(id);
      this.db.prepare('INSERT INTO events (task_id, at, from_state, to_state, actor, reason, detail) VALUES (?,?,?,?,?,?,?)').run(id, this.now(), t.state, t.state, actor, reason, detail ? json(detail) : null);
    });
  }

  /** Merge-patch artifacts without a state change (worktree path, artifact dirs...). */
  setArtifacts(id: string, artifacts: Record<string, unknown>): void {
    this.tx(() => {
      const t = this.requireTask(id);
      this.db.prepare('UPDATE tasks SET artifacts = ?, updated_at = ? WHERE id = ?').run(json({ ...t.artifacts, ...artifacts }), this.now(), id);
    });
  }

  /** Same-state patch (workspace info). Audited. Fence optional. */
  patchTask(id: string, patch: Patch, actor: string, fence?: Fence): TaskRow {
    return this.tx(() => {
      const t = this.requireTask(id);
      if (fence && (t.leaseOwner !== fence.owner || t.claimEpoch !== fence.epoch)) throw new StoreError('stale_owner', `task ${id} fence mismatch`);
      const sets: string[] = ['updated_at = ?'];
      const values: unknown[] = [this.now()];
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'artifacts') {
          sets.push('artifacts = ?');
          values.push(json({ ...t.artifacts, ...(value as object) }));
        } else if (key === 'result') {
          sets.push('result = ?');
          values.push(value === null ? null : json(value));
        } else if (key in PATCHABLE) {
          sets.push(`${PATCHABLE[key as keyof typeof PATCHABLE]} = ?`);
          values.push(value ?? null);
        } else throw new StoreError('invalid', `column ${key} is not patchable`);
      }
      this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...(values as any[]), id);
      return this.requireTask(id);
    });
  }

  // ---- reviews ----------------------------------------------------------------------------------------------

  createReview(taskId: string, request: Record<string, unknown>): ReviewRow {
    return this.tx(() => {
      const round = (this.db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE task_id = ?').get(taskId) as { n: number }).n + 1;
      const res = this.db.prepare('INSERT INTO reviews (task_id, round, created_at, request) VALUES (?,?,?,?)').run(taskId, round, this.now(), json(request));
      return this.requireReview(Number(res.lastInsertRowid));
    });
  }

  requireReview(id: number): ReviewRow {
    const r = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
    if (!r) throw new StoreError('not_found', `review ${id} not found`);
    return rowToReview(r);
  }

  /** The newest review for the task (decided or not). */
  latestReview(taskId: string): ReviewRow | undefined {
    const r = this.db.prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId);
    return r ? rowToReview(r) : undefined;
  }

  listReviews(filter: { pendingOnly?: boolean } = {}): ReviewRow[] {
    const rows = this.db.prepare(`SELECT * FROM reviews ${filter.pendingOnly ? 'WHERE decision IS NULL' : ''} ORDER BY id`).all();
    return rows.flatMap((r) => this.parseOrSkip(rowToReview, r));
  }

  /** Records a decision once. A second decision on the same review is rejected (no duplicate review decisions). */
  decideReview(reviewId: number, decision: NonNullable<ReviewRow['decision']>, reviewer: string, feedback: string | null): ReviewRow {
    return this.tx(() => {
      const r = this.requireReview(reviewId);
      if (r.decision) throw new StoreError('state_mismatch', `review ${reviewId} already decided: ${r.decision}`);
      this.db.prepare('UPDATE reviews SET decision = ?, feedback = ?, reviewer = ?, decided_at = ? WHERE id = ?').run(decision, feedback, reviewer, this.now(), reviewId);
      return this.requireReview(reviewId);
    });
  }

  /**
   * Records the Lead's decision on the task's pending review AND applies its consequence in ONE transaction, so a
   * crash can never leave a decided review on a REVIEW_PENDING task. A second decision on the same review is rejected.
   * REJECTED_WITH_FEEDBACK creates a bounded correction task (if the correction budget allows) and supersedes the
   * rejected one, so dependents follow the replacement; once the budget is spent the task is ESCALATED instead.
   */
  applyReviewDecision(input: {
    taskId: string;
    decision: NonNullable<ReviewRow['decision']>;
    reviewer: string;
    feedback?: string | null;
    maxCorrections: number;
    correctionSpec?: TaskSpec;
  }): { task: TaskRow; correctionId?: string } {
    return this.tx(() => {
      const task = this.requireTask(input.taskId);
      if (task.state !== 'REVIEW_PENDING') throw new StoreError('state_mismatch', `task ${task.id} is ${task.state}, not REVIEW_PENDING`);
      const review = this.latestReview(task.id);
      if (!review || review.decision) throw new StoreError('state_mismatch', `task ${task.id} has no undecided review`);
      if (input.decision === 'REJECTED_WITH_FEEDBACK' && !input.feedback?.trim()) throw new StoreError('invalid', 'a rejection must carry feedback for the correction');
      this.decideReview(review.id, input.decision, input.reviewer, input.feedback ?? null);
      const base = { actor: input.reviewer, expectFrom: 'REVIEW_PENDING' as const };

      if (input.decision === 'APPROVED') {
        return { task: this.transition(task.id, 'APPROVED', { ...base, reason: input.feedback ?? 'approved', patch: { reviewOutcome: 'APPROVED' } }) };
      }
      if (input.decision === 'ESCALATED_TO_HUMAN') {
        return { task: this.transition(task.id, 'ESCALATED', { ...base, reason: input.feedback ?? 'escalated to human', patch: { reviewOutcome: 'ESCALATED_TO_HUMAN', failureCategory: 'escalated_by_reviewer' satisfies FailureCategory } }) };
      }
      if (task.corrections < input.maxCorrections && input.correctionSpec) {
        this.insertTask(task.batchId, task.project, task.repository, taskSpecSchema.parse(input.correctionSpec), task.id, this.now(), input.reviewer, task.corrections + 1);
        const updated = this.transition(task.id, 'REVIEW_REJECTED', {
          ...base,
          reason: input.feedback ?? 'rejected',
          patch: { reviewOutcome: 'REJECTED_WITH_FEEDBACK', supersededBy: input.correctionSpec.id, feedback: input.feedback ?? null, failureCategory: 'review_rejected' satisfies FailureCategory },
        });
        return { task: updated, correctionId: input.correctionSpec.id };
      }
      return {
        task: this.transition(task.id, 'ESCALATED', {
          ...base,
          reason: `rejected after ${task.corrections} correction(s); correction budget (${input.maxCorrections}) exhausted: ${input.feedback}`,
          patch: { reviewOutcome: 'REJECTED_WITH_FEEDBACK', feedback: input.feedback ?? null, failureCategory: 'review_rejected' satisfies FailureCategory },
        }),
      };
    });
  }

  /** Runs several store operations atomically (nested store calls join the transaction). */
  transact<T>(fn: () => T): T {
    return this.tx(fn);
  }

  // ---- locks ------------------------------------------------------------------------------------------------

  /** Named expiring lock (used to serialize integration per repository). */
  acquireLock(name: string, owner: string, ttlMs: number): boolean {
    return this.tx(() => {
      const now = this.now();
      const cur = this.db.prepare('SELECT * FROM locks WHERE name = ?').get(name) as { owner: string; expires_at: number } | undefined;
      if (cur && cur.expires_at > now && cur.owner !== owner) return false;
      this.db.prepare('INSERT INTO locks (name, owner, expires_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at').run(name, owner, now + ttlMs);
      return true;
    });
  }

  releaseLock(name: string, owner: string): void {
    this.db.prepare('DELETE FROM locks WHERE name = ? AND owner = ?').run(name, owner);
  }
}

function rowToReview(r: Record<string, any>): ReviewRow {
  return {
    id: r.id,
    taskId: r.task_id,
    round: r.round,
    createdAt: r.created_at,
    request: parseJson('review', r.id, 'request', r.request),
    decision: r.decision,
    feedback: r.feedback,
    reviewer: r.reviewer,
    decidedAt: r.decided_at,
  };
}

function assertAcyclic(tasks: TaskSpec[]): void {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw new StoreError('invalid', `dependency cycle: ${[...path, id].join(' -> ')}`);
    state.set(id, 'visiting');
    for (const dep of deps.get(id) ?? []) if (deps.has(dep)) visit(dep, [...path, id]);
    state.set(id, 'done');
  };
  for (const id of deps.keys()) visit(id, []);
}

export { TRANSITIONS };

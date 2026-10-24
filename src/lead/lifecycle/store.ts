import type { SchedulerStore } from '../../runtime/scheduler/store.ts';

/**
 * Durable state of one objective's lifecycle. It sits BESIDE the scheduler tables (it adds two tables, created if absent, and
 * changes none): the scheduler still owns every task transition; this records which phase the objective is in, the pinned
 * acceptance oracle, the operator's authorizations and an append-only audit trail. Every phase change goes through
 * `LifecycleStore.transition`, the only writer of `phase`.
 *
 *   PINNED --> EXECUTING --> ACCEPTING --> ACCEPTED | NOT_ACCEPTED
 *                 |  ^            |
 *                 v  |            v
 *      AWAITING_OPERATOR / ESCALATED  (resumable by an explicit, audited operator action)
 *   any non-final phase --> CANCELLED
 *
 * ACCEPTED, NOT_ACCEPTED and CANCELLED are final. ESCALATED and AWAITING_OPERATOR are stops that wait for a human: nothing in
 * the lifecycle leaves them by itself.
 */

export const LIFECYCLE_PHASES = ['PINNED', 'EXECUTING', 'AWAITING_OPERATOR', 'ESCALATED', 'ACCEPTING', 'ACCEPTED', 'NOT_ACCEPTED', 'CANCELLED'] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export const FINAL_PHASES: readonly LifecyclePhase[] = ['ACCEPTED', 'NOT_ACCEPTED', 'CANCELLED'];

export const LIFECYCLE_TRANSITIONS: Record<LifecyclePhase, readonly LifecyclePhase[]> = {
  PINNED: ['EXECUTING', 'CANCELLED'],
  EXECUTING: ['ACCEPTING', 'AWAITING_OPERATOR', 'ESCALATED', 'CANCELLED'],
  AWAITING_OPERATOR: ['EXECUTING', 'ESCALATED', 'CANCELLED'],
  ESCALATED: ['EXECUTING', 'CANCELLED'],
  ACCEPTING: ['ACCEPTED', 'NOT_ACCEPTED', 'ESCALATED', 'CANCELLED'],
  ACCEPTED: [],
  NOT_ACCEPTED: [],
  CANCELLED: [],
};

export type OracleNegativeControl = { mode: 'required' } | { mode: 'not_applicable'; reason: string };

/** The objective-level acceptance oracle exactly as pinned: hashes of every file and the commands that judge them. */
export interface PinnedOracle {
  /** Real path of the directory holding the oracle files. It is outside the repository, the worktrees and the artifact roots. */
  dir: string;
  /** Oracle file (relative to dir) -> sha256 of its content at pin time. */
  files: Record<string, string>;
  commands: string[][];
  negativeControl: OracleNegativeControl;
  /** sha256 over the canonical JSON of files + commands + negativeControl: the oracle's version. */
  specHash: string;
  pinnedAt: number;
  pinnedBy: string;
}

/** An operator's explicit permission for one bounded action the lifecycle will not take on its own. */
export interface Authorization {
  kind: 'repair';
  /** The root task id (a correction `x-fix1` is covered by an authorization for `x`). */
  taskId: string;
  /** How many repairs this authorization still allows. */
  remaining: number;
  grantedAt: number;
  actor: string;
  reason: string;
}

export interface LifecycleRow {
  objectiveId: string;
  batchId: string;
  phase: LifecyclePhase;
  oracle: PinnedOracle;
  baseCommit: string;
  authorizations: Authorization[];
  /** The final (or latest) verdict record; set when the lifecycle leaves ACCEPTING or stops. */
  result: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface LifecycleEvent {
  seq: number;
  objectiveId: string;
  at: number;
  fromPhase: LifecyclePhase;
  toPhase: LifecyclePhase;
  actor: string;
  /** 'phase' for a transition; otherwise what was audited (review, repair, integration, authorization, ...). */
  kind: string;
  reason: string | null;
  detail: Record<string, unknown> | null;
}

export class LifecycleError extends Error {
  code: 'not_found' | 'illegal_transition' | 'phase_mismatch' | 'duplicate' | 'invalid' | 'corrupt';
  constructor(code: LifecycleError['code'], message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS objective_lifecycle (
  objective_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL UNIQUE REFERENCES batches(id), phase TEXT NOT NULL,
  oracle TEXT NOT NULL, base_commit TEXT NOT NULL, authorizations TEXT NOT NULL DEFAULT '[]', result TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS objective_lifecycle_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, objective_id TEXT NOT NULL, at INTEGER NOT NULL,
  from_phase TEXT NOT NULL, to_phase TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS objective_lifecycle_events_objective ON objective_lifecycle_events(objective_id);
`;

const json = (v: unknown) => JSON.stringify(v);

function parse<T>(id: string, column: string, text: unknown): T {
  try {
    return JSON.parse(String(text)) as T;
  } catch (err) {
    throw new LifecycleError('corrupt', `objective_lifecycle ${id}: column ${column} is not valid JSON (${(err as Error).message})`);
  }
}

function rowToLifecycle(r: Record<string, any>): LifecycleRow {
  return {
    objectiveId: r.objective_id,
    batchId: r.batch_id,
    phase: r.phase,
    oracle: parse(r.objective_id, 'oracle', r.oracle),
    baseCommit: r.base_commit,
    authorizations: parse(r.objective_id, 'authorizations', r.authorizations),
    result: r.result ? parse(r.objective_id, 'result', r.result) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * The batch a pinned objective runs as, read without creating anything: undefined when the scheduler database holds no
 * lifecycle for it (or no lifecycle table at all). For readers that must not write, such as reference verification.
 */
export function pinnedObjectiveBatch(scheduler: SchedulerStore, objectiveId: string): string | undefined {
  if (!scheduler.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'objective_lifecycle'").get()) return undefined;
  const row = scheduler.db.prepare('SELECT batch_id FROM objective_lifecycle WHERE objective_id = ?').get(objectiveId) as { batch_id: string } | undefined;
  return row?.batch_id;
}

export class LifecycleStore {
  readonly scheduler: SchedulerStore;

  constructor(scheduler: SchedulerStore) {
    this.scheduler = scheduler;
    scheduler.db.exec(SCHEMA);
  }

  get now(): () => number {
    return this.scheduler.now;
  }

  get(objectiveId: string): LifecycleRow | undefined {
    const r = this.scheduler.db.prepare('SELECT * FROM objective_lifecycle WHERE objective_id = ?').get(objectiveId);
    return r ? rowToLifecycle(r) : undefined;
  }

  require(objectiveId: string): LifecycleRow {
    const row = this.get(objectiveId);
    if (!row) throw new LifecycleError('not_found', `no lifecycle for objective ${objectiveId}`);
    return row;
  }

  getByBatch(batchId: string): LifecycleRow | undefined {
    const r = this.scheduler.db.prepare('SELECT * FROM objective_lifecycle WHERE batch_id = ?').get(batchId);
    return r ? rowToLifecycle(r) : undefined;
  }

  /** Objectives in `phase`, oldest pin first (ties by id): the order a queue takes them in. */
  listByPhase(phase: LifecyclePhase): LifecycleRow[] {
    return this.scheduler.db.prepare('SELECT * FROM objective_lifecycle WHERE phase = ? ORDER BY created_at, objective_id').all(phase).map(rowToLifecycle);
  }

  /** Registers an objective with its pinned oracle, in phase PINNED. One lifecycle per objective and per batch. */
  create(input: { objectiveId: string; batchId: string; oracle: PinnedOracle; baseCommit: string; actor: string }): LifecycleRow {
    return this.scheduler.transact(() => {
      if (this.get(input.objectiveId)) throw new LifecycleError('duplicate', `objective ${input.objectiveId} already has a lifecycle`);
      if (this.getByBatch(input.batchId)) throw new LifecycleError('duplicate', `batch ${input.batchId} already belongs to a lifecycle`);
      const now = this.now();
      this.scheduler.db
        .prepare('INSERT INTO objective_lifecycle (objective_id, batch_id, phase, oracle, base_commit, authorizations, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(input.objectiveId, input.batchId, 'PINNED', json(input.oracle), input.baseCommit, '[]', now, now);
      this.insertEvent(input.objectiveId, 'PINNED', 'PINNED', input.actor, 'pin', `oracle ${input.oracle.specHash.slice(0, 12)} pinned (${Object.keys(input.oracle.files).length} file(s), ${input.oracle.commands.length} command(s))`, { specHash: input.oracle.specHash, files: input.oracle.files, baseCommit: input.baseCommit });
      return this.require(input.objectiveId);
    });
  }

  private insertEvent(objectiveId: string, from: LifecyclePhase, to: LifecyclePhase, actor: string, kind: string, reason: string | null, detail?: Record<string, unknown> | null): void {
    this.scheduler.db
      .prepare('INSERT INTO objective_lifecycle_events (objective_id, at, from_phase, to_phase, actor, kind, reason, detail) VALUES (?,?,?,?,?,?,?,?)')
      .run(objectiveId, this.now(), from, to, actor, kind, reason, detail ? json(detail) : null);
  }

  /**
   * The only writer of `phase`. `expectFrom` makes the write conditional on the phase the caller last observed: a lifecycle
   * that was cancelled (or escalated) by someone else while this caller was working is refused, never overwritten.
   */
  transition(objectiveId: string, to: LifecyclePhase, options: { actor: string; reason?: string; expectFrom?: LifecyclePhase | readonly LifecyclePhase[]; detail?: Record<string, unknown>; result?: Record<string, unknown> }): LifecycleRow {
    return this.scheduler.transact(() => {
      const row = this.require(objectiveId);
      const expect = options.expectFrom === undefined ? undefined : ([] as LifecyclePhase[]).concat(options.expectFrom as LifecyclePhase | LifecyclePhase[]);
      if (expect && !expect.includes(row.phase)) throw new LifecycleError('phase_mismatch', `objective ${objectiveId} is ${row.phase}, expected ${expect.join('|')}`);
      if (!LIFECYCLE_TRANSITIONS[row.phase].includes(to)) throw new LifecycleError('illegal_transition', `objective ${objectiveId}: ${row.phase} -> ${to} is not allowed`);
      const now = this.now();
      this.scheduler.db.prepare('UPDATE objective_lifecycle SET phase = ?, result = COALESCE(?, result), updated_at = ? WHERE objective_id = ?').run(to, options.result ? json(options.result) : null, now, objectiveId);
      this.insertEvent(objectiveId, row.phase, to, options.actor, 'phase', options.reason ?? null, options.detail);
      return this.require(objectiveId);
    });
  }

  /** Appends an audit entry without changing the phase. Always allowed, including after the lifecycle is final (late evidence is still evidence). */
  audit(objectiveId: string, actor: string, kind: string, reason: string, detail?: Record<string, unknown>): void {
    this.scheduler.transact(() => {
      const row = this.require(objectiveId);
      this.insertEvent(objectiveId, row.phase, row.phase, actor, kind, reason, detail);
    });
  }

  events(objectiveId: string): LifecycleEvent[] {
    const rows = this.scheduler.db.prepare('SELECT * FROM objective_lifecycle_events WHERE objective_id = ? ORDER BY seq').all(objectiveId) as Record<string, any>[];
    return rows.map((r) => ({
      seq: r.seq,
      objectiveId: r.objective_id,
      at: r.at,
      fromPhase: r.from_phase,
      toPhase: r.to_phase,
      actor: r.actor,
      kind: r.kind,
      reason: r.reason,
      detail: r.detail ? (() => { try { return JSON.parse(r.detail); } catch { return { corrupt: true }; } })() : null,
    }));
  }

  /** Records an operator authorization. Not allowed once the lifecycle is final. */
  authorize(objectiveId: string, input: { kind: Authorization['kind']; taskId: string; uses?: number; actor: string; reason: string }): LifecycleRow {
    if (!input.reason.trim()) throw new LifecycleError('invalid', 'an authorization needs a reason (it is part of the audit trail)');
    const uses = input.uses ?? 1;
    if (!Number.isInteger(uses) || uses < 1 || uses > 3) throw new LifecycleError('invalid', 'an authorization covers 1 to 3 uses');
    return this.scheduler.transact(() => {
      const row = this.require(objectiveId);
      if (FINAL_PHASES.includes(row.phase)) throw new LifecycleError('phase_mismatch', `objective ${objectiveId} is ${row.phase}; nothing can be authorized`);
      const auth: Authorization = { kind: input.kind, taskId: input.taskId, remaining: uses, grantedAt: this.now(), actor: input.actor, reason: input.reason };
      this.scheduler.db.prepare('UPDATE objective_lifecycle SET authorizations = ?, updated_at = ? WHERE objective_id = ?').run(json([...row.authorizations, auth]), this.now(), objectiveId);
      this.insertEvent(objectiveId, row.phase, row.phase, input.actor, 'authorization', `${input.kind} of ${input.taskId} x${uses}: ${input.reason}`, { ...auth });
      return this.require(objectiveId);
    });
  }

  /** Spends one use of a matching authorization. False when there is none: the caller must not proceed. */
  consumeAuthorization(objectiveId: string, kind: Authorization['kind'], taskId: string, actor: string): boolean {
    return this.scheduler.transact(() => {
      const row = this.require(objectiveId);
      const idx = row.authorizations.findIndex((a) => a.kind === kind && a.taskId === taskId && a.remaining > 0);
      if (idx < 0) return false;
      const next = row.authorizations.map((a, i) => (i === idx ? { ...a, remaining: a.remaining - 1 } : a));
      this.scheduler.db.prepare('UPDATE objective_lifecycle SET authorizations = ?, updated_at = ? WHERE objective_id = ?').run(json(next), this.now(), objectiveId);
      this.insertEvent(objectiveId, row.phase, row.phase, actor, 'authorization_used', `${kind} of ${taskId} (${next[idx].remaining} use(s) left)`, { authorizedBy: next[idx].actor });
      return true;
    });
  }

  /** Stores the latest verdict record without changing the phase (used for stops). */
  setResult(objectiveId: string, result: Record<string, unknown>): void {
    this.scheduler.db.prepare('UPDATE objective_lifecycle SET result = ?, updated_at = ? WHERE objective_id = ?').run(json(result), this.now(), objectiveId);
  }
}

import { z } from 'zod';
import { DEFAULT_MODEL_WAIT_BUDGET_MS, modelWaitBudgetMs } from '../capacity/model-capacity.ts';
import { delegationRequestSchema, languageOf, type Language } from '../execution/delegation.ts';

/**
 * M5 persistent engineering backlog: task model, lifecycle state machine and scheduler configuration.
 *
 * The lifecycle is enforced in exactly one place (SchedulerStore.transition) from TRANSITIONS below; nothing else
 * writes `state`. Markdown is a generated *view* of this data (see render.ts), never the source of truth.
 */

export const TASK_STATES = [
  'BACKLOG',
  'READY',
  'CLAIMED',
  'CODING',
  'VERIFYING',
  'REVIEW_PENDING',
  'APPROVED',
  'INTEGRATING',
  'DONE',
  // failure / exit paths
  'BLOCKED',
  'REVIEW_REJECTED',
  'ESCALATED',
  'RUNTIME_FAILURE',
  'CANCELLED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** States in which a worker (or reviewer / integrator) holds work that is not yet in the integration branch. */
export const OWNING_STATES: readonly TaskState[] = ['CLAIMED', 'CODING', 'VERIFYING', 'REVIEW_PENDING', 'APPROVED', 'INTEGRATING'];
/** States that are held by a live worker lease. */
export const LEASED_STATES: readonly TaskState[] = ['CLAIMED', 'CODING', 'VERIFYING'];
export const TERMINAL_STATES: readonly TaskState[] = ['DONE', 'CANCELLED'];

export const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  BACKLOG: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['CLAIMED', 'BLOCKED', 'CANCELLED', 'CODING'], // CODING: a Lead directly taking an executor:'claude' task
  CLAIMED: ['CODING', 'READY', 'BLOCKED', 'RUNTIME_FAILURE', 'CANCELLED', 'ESCALATED'],
  CODING: ['VERIFYING', 'READY', 'RUNTIME_FAILURE', 'ESCALATED', 'CANCELLED', 'DONE'], // DONE: Claude-direct completion only
  VERIFYING: ['REVIEW_PENDING', 'READY', 'RUNTIME_FAILURE', 'ESCALATED', 'CANCELLED'],
  REVIEW_PENDING: ['APPROVED', 'REVIEW_REJECTED', 'ESCALATED', 'CANCELLED'],
  APPROVED: ['INTEGRATING', 'CANCELLED'],
  INTEGRATING: ['DONE', 'ESCALATED', 'APPROVED'],
  BLOCKED: ['BACKLOG', 'READY', 'CANCELLED'],
  REVIEW_REJECTED: ['CANCELLED'],
  ESCALATED: ['READY', 'CANCELLED'],
  RUNTIME_FAILURE: ['READY', 'ESCALATED', 'CANCELLED'],
  DONE: [],
  CANCELLED: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export const taskSpecSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/, 'task id must be [A-Za-z0-9._-]'),
  title: z.string().min(1),
  priority: z.number().int().min(0).max(100).default(50),
  dependsOn: z.array(z.string()).default([]),
  /** 'worker' = eligible for the local pool; 'claude' = kept by the Lead (never claimed by a worker). */
  executor: z.enum(['worker', 'claude']).default('worker'),
  /** Only 'implementation' tasks count toward the accepted-local-implementation rate. */
  kind: z.enum(['implementation', 'planning', 'review']).default('implementation'),
  risk: z.enum(['low', 'medium', 'high']).default('low'),
  complexity: z.enum(['small', 'medium', 'large']).default('small'),
  /** Required for worker tasks: the CodingTask contract + the Lead's honest assessment (the existing runner's input). */
  request: delegationRequestSchema.optional(),
  /** Required for claude tasks: why a local worker is not used. */
  keptReason: z.string().optional(),
  /** Files a claude task will touch (ownership / conflict detection); worker tasks use contract.allowedFiles. */
  ownedFiles: z.array(z.string()).default([]),
  /** Total times the task may be claimed (initial run + lease-expiry / runtime requeues). */
  maxClaims: z.number().int().min(1).max(10).default(3),
});
export type TaskSpec = z.output<typeof taskSpecSchema>;
export type TaskSpecInput = z.input<typeof taskSpecSchema>;

export const batchPlanSchema = z.object({
  batchId: z.string().regex(/^[A-Za-z0-9._-]+$/),
  project: z.string().min(1),
  repository: z.string().min(1),
  description: z.string().default(''),
  /** Ref the integration branch is cut from. Defaults to the repository's current HEAD. */
  baseRef: z.string().optional(),
  /** argv arrays run (in the integration worktree) after each task integrates. Checked like worker verification. */
  integrationCommands: z.array(z.array(z.string()).min(1)).default([]),
  /** Repo-relative paths symlinked from the source repo into every worktree (e.g. node_modules). Never tracked files. */
  linkPaths: z.array(z.string()).default([]),
  /**
   * Lead-authored allowlist of uncommitted source files (modified or untracked) the batch builds on. They are captured
   * into the integration branch's base commit (HEAD + exactly these paths, via a temporary index: the user's branch,
   * index and working tree are never touched). Everything else uncommitted stays invisible to workers.
   */
  snapshotPaths: z.array(z.string()).default([]),
  tasks: z.array(taskSpecSchema).min(1),
});
export type BatchPlan = z.output<typeof batchPlanSchema>;
export type BatchPlanInput = z.input<typeof batchPlanSchema>;

export interface SchedulerConfig {
  /**
   * LOGICAL workers: tasks that may be in their execution lifecycle (CLAIMED/CODING/VERIFYING) at once. This is a
   * different limit from model concurrency, which is the machine-wide lease database in src/runtime/capacity
   * (AGENTIC_MODEL_CONCURRENCY) held only around each model call: three logical workers may each prepare a worktree,
   * wait for the model, run verification and so on while a single one owns the inference slot.
   */
  maxConcurrentWorkers: number;
  /** A claim's lease; heartbeats extend it while the worker is alive. */
  workerLeaseTimeoutMs: number;
  /** Hard wall-clock cap per task run (executor is aborted past it). */
  taskTimeoutMs: number;
  /**
   * Cumulative time one task may spend QUEUED for a model permit; it does not count against `taskTimeoutMs` (the active
   * execution budget). Exhausting it fails the task as `capacity_wait_timeout` (RUNTIME_FAILURE, retryable). Total wall
   * clock per run is therefore bounded by taskTimeoutMs + maxCapacityWaitMs. Same value the runner enforces
   * (AGENTIC_MODEL_WAIT_BUDGET_MS).
   */
  maxCapacityWaitMs: number;
  /** Max distinct tasks that may be claimed within one batch (corrections included). */
  maxTasksPerBatch: number;
  maxReviewCorrections: number;
  /** Idle wait between scheduling passes when nothing is claimable but work is in flight. */
  pollMs: number;
  /** Languages the local workers are measured on. */
  workerLanguages: Language[];
}

/** Upper bound on logical workers for this hardware profile (verification runs `go test` / jest in parallel). */
export const MAX_WORKER_CONCURRENCY = 3;

export const DEFAULT_CONFIG: SchedulerConfig = {
  maxConcurrentWorkers: 1,
  workerLeaseTimeoutMs: 5 * 60_000,
  taskTimeoutMs: 30 * 60_000,
  maxCapacityWaitMs: DEFAULT_MODEL_WAIT_BUDGET_MS,
  maxTasksPerBatch: 5,
  maxReviewCorrections: 2,
  pollMs: 2_000,
  workerLanguages: ['go', 'js'],
};

export function resolveConfig(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  const config = { ...DEFAULT_CONFIG, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) } as SchedulerConfig;
  const positive = ['maxConcurrentWorkers', 'workerLeaseTimeoutMs', 'taskTimeoutMs', 'maxCapacityWaitMs', 'maxTasksPerBatch', 'pollMs'] as const;
  for (const key of positive) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`config ${key} must be a positive integer`);
  }
  if (!Number.isInteger(config.maxReviewCorrections) || config.maxReviewCorrections < 0) throw new Error('config maxReviewCorrections must be an integer >= 0');
  if (config.maxConcurrentWorkers > MAX_WORKER_CONCURRENCY) throw new Error(`maxConcurrentWorkers above ${MAX_WORKER_CONCURRENCY} is not supported on this hardware profile`);
  return config;
}

/**
 * Scheduler settings taken from the environment. AGENTIC_WORKER_CONCURRENCY sets the logical worker pool; a malformed
 * value is an error rather than a silent default, because "I asked for 3 and got 1" is an invisible performance bug.
 * (Model concurrency is deliberately NOT here: it lives in the machine-wide capacity database, AGENTIC_MODEL_CONCURRENCY.)
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<SchedulerConfig> {
  const out: Partial<SchedulerConfig> = {};
  const raw = env.AGENTIC_WORKER_CONCURRENCY?.trim();
  if (raw) {
    if (!/^\d+$/.test(raw)) throw new Error(`AGENTIC_WORKER_CONCURRENCY must be a positive integer, got "${raw}"`);
    out.maxConcurrentWorkers = Number(raw);
  }
  if (env.AGENTIC_MODEL_WAIT_BUDGET_MS?.trim()) out.maxCapacityWaitMs = modelWaitBudgetMs(env); // validated by the same function the runner uses
  return out;
}

/** The task's file-ownership set: the files nobody else may be working on concurrently. */
export function ownedFilesOf(spec: TaskSpec): string[] {
  return [...new Set(spec.request?.contract.allowedFiles ?? spec.ownedFiles)];
}

export function languageOfSpec(spec: TaskSpec): Language | undefined {
  const files = spec.request?.contract.allowedFiles ?? [];
  return files.length > 0 ? languageOf(files) : undefined;
}

/** Failure categories persisted for operations/metrics. Free-form strings are allowed, but prefer these. */
export type FailureCategory =
  | 'coding_attempts_exhausted'
  | 'forbidden_mutation'
  | 'runtime_unavailable'
  | 'task_timeout'
  | 'capacity_wait_timeout'
  | 'executor_error'
  | 'lease_expired'
  | 'review_gate_blocked'
  | 'review_rejected'
  | 'escalated_by_reviewer'
  | 'integration_conflict'
  | 'integration_verification_failed'
  | 'diverged_after_review'
  | 'dependency_failed'
  | 'source_tree_dirty'
  | 'not_eligible'
  | 'cancelled';

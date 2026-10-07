import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { readSchedulerState, resolveSchedulerDbPath, SchedulerStateUnavailable, TASK_STATES } from './scheduler-state.ts';

/**
 * Operational (Prometheus) metrics for the harness. Strictly additive observability: nothing here decides, gates or
 * delays a run.
 *
 *  - Every recorder is synchronous, in-memory and wrapped so it can never throw into the caller; a failure only
 *    increments `metrics_instrumentation_errors_total`.
 *  - Labels are low-cardinality by construction: enum values are clamped to a known set ("other" otherwise) and the
 *    only free-form label (`worker`, a model name) is sanitized and truncated. Task ids, run ids, paths, prompts and
 *    file names are never labels, and no task content is ever recorded.
 *  - Only metrics whose underlying events exist are defined.
 *
 * Two kinds of series, never mixed:
 *  - LIVE: counters/histograms updated by this process (workflow, worker, attempt, retry, verification). They start
 *    at zero when the process restarts, which is normal Prometheus counter behavior.
 *  - PERSISTED: derived at scrape time from the scheduler's SQLite file (read-only), because the scheduler runs in a
 *    separate CLI process: task_queue_depth, active_workers, scheduler_tasks, review_decisions_total. They are never
 *    updated in-process, so they survive restarts of either process and there is no second source of truth.
 */

export const WORKFLOW_STATUSES = ['success', 'failed', 'suspended', 'tripwire', 'canceled', 'bailed'] as const;
export const TASK_OUTCOMES = ['pass', 'fail', 'runtime_failure'] as const;
export const ATTEMPT_OUTCOMES = ['pass', 'fail'] as const;
export const RETRY_KINDS = ['runtime', 'coding'] as const;
export const VERIFY_OUTCOMES = ['pass', 'fail', 'timeout'] as const;
export const REVIEW_DECISIONS = ['APPROVED', 'REJECTED_WITH_FEEDBACK', 'ESCALATED_TO_HUMAN'] as const;
export const INFERENCE_OUTCOMES = ['ok', 'error'] as const;

const MAX_TRACKED_RUNS = 1_000;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | 'other' {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : 'other';
}

/** Free-form but bounded: model/agent names only, no whitespace, no path-like or long values. */
export function sanitizeLabel(value: unknown, fallback = 'unknown'): string {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
  return cleaned || fallback;
}

export interface MetricsOptions {
  registry?: Registry;
  /** Monotonic-ish clock in milliseconds; injectable so durations are deterministic in tests. */
  now?: () => number;
  /** Scheduler SQLite file for the persisted series. Default: resolved from the environment at each scrape. */
  schedulerDbPath?: string | (() => string);
  /** Wall clock (epoch ms) used to judge lease expiry; injectable for tests. */
  wallClock?: () => number;
}

export function createHarnessMetrics(options: MetricsOptions = {}) {
  const registry = options.registry ?? new Registry();
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? Date.now;
  const dbPath = () => (typeof options.schedulerDbPath === 'function' ? options.schedulerDbPath() : (options.schedulerDbPath ?? resolveSchedulerDbPath()));

  const workflowRuns = new Counter({ name: 'workflow_runs_total', help: 'Workflow runs that reached a terminal or suspended status.', labelNames: ['workflow', 'status'], registers: [registry] });
  const workflowDuration = new Histogram({ name: 'workflow_duration_seconds', help: 'Wall-clock duration of workflow runs.', labelNames: ['workflow'], buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600], registers: [registry] });
  const workerTasks = new Counter({ name: 'worker_tasks_total', help: 'Coding tasks completed by a worker, by harness-verified outcome.', labelNames: ['worker', 'outcome'], registers: [registry] });
  const workerInference = new Histogram({ name: 'worker_inference_seconds', help: 'Duration of one worker model invocation.', labelNames: ['worker', 'outcome'], buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 900], registers: [registry] });
  const codingAttempts = new Counter({ name: 'coding_attempts_total', help: 'Coding attempts (runtime-failed invocations excluded), by verification outcome.', labelNames: ['outcome'], registers: [registry] });
  const workerRetries = new Counter({ name: 'worker_retries_total', help: 'Retries inside the coding runner: model-runtime retries vs fresh-context coding retries.', labelNames: ['kind'], registers: [registry] });
  const verificationDuration = new Histogram({ name: 'verification_duration_seconds', help: 'Duration of one harness verification command.', labelNames: ['outcome'], buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120], registers: [registry] });
  // PERSISTED (scheduler SQLite, read at scrape time). Reset and refilled on every scrape; absent when unreadable.
  const reviewDecisions = new Counter({ name: 'review_decisions_total', help: 'PERSISTED. Review decisions recorded in the scheduler database, by decision and reviewer kind (claude = the Claude Engineering Lead).', labelNames: ['decision', 'reviewer'], registers: [registry] });
  const queueDepth = new Gauge({ name: 'task_queue_depth', help: 'PERSISTED. Worker tasks in READY state in the scheduler database, waiting for a worker.', registers: [registry] });
  const activeWorkers = new Gauge({ name: 'active_workers', help: 'PERSISTED. Worker tasks holding an unexpired lease (CLAIMED, CODING or VERIFYING) in the scheduler database.', registers: [registry] });
  const schedulerTasks = new Gauge({ name: 'scheduler_tasks', help: 'PERSISTED. Tasks in the scheduler database by lifecycle state.', labelNames: ['state'], registers: [registry] });
  const schedulerStateUp = new Gauge({ name: 'scheduler_state_up', help: '1 if the scheduler database was read successfully at this scrape, else 0 (missing, locked or unreadable); the PERSISTED series are absent when 0.', registers: [registry] });
  const schedulerReadErrors = new Counter({ name: 'scheduler_state_read_errors_total', help: 'LIVE. Scrapes where the scheduler database existed but could not be read (locked, corrupt, unexpected schema).', registers: [registry] });
  const instrumentationErrors = new Counter({ name: 'metrics_instrumentation_errors_total', help: 'Metric updates that failed and were swallowed.', registers: [registry] });

  const runStarts = new Map<string, number>();

  /** Wraps a recorder so it can never throw into (or slow down) the instrumented code path. */
  function guard<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args) => {
      try {
        fn(...args);
      } catch {
        try {
          instrumentationErrors.inc();
        } catch {
          // nothing left to do; observability must never break a run
        }
      }
    };
  }

  const recorders = {
    workflowStarted: guard((workflowId: string, runId: string) => {
      if (runStarts.size >= MAX_TRACKED_RUNS) runStarts.delete(runStarts.keys().next().value as string);
      runStarts.set(`${workflowId}:${runId}`, now());
    }),
    workflowFinished: guard((workflowId: string, runId: string, status: string) => {
      const workflow = sanitizeLabel(workflowId);
      workflowRuns.inc({ workflow, status: oneOf(status, WORKFLOW_STATUSES) });
      const key = `${workflowId}:${runId}`;
      const started = runStarts.get(key);
      runStarts.delete(key);
      if (started !== undefined) workflowDuration.observe({ workflow }, Math.max(0, now() - started) / 1000);
    }),
    workerTask: guard((worker: string, outcome: string) => {
      workerTasks.inc({ worker: sanitizeLabel(worker), outcome: oneOf(outcome, TASK_OUTCOMES) });
    }),
    workerInference: guard((worker: string, seconds: number, outcome: string) => {
      workerInference.observe({ worker: sanitizeLabel(worker), outcome: oneOf(outcome, INFERENCE_OUTCOMES) }, Math.max(0, seconds));
    }),
    codingAttempt: guard((outcome: string) => {
      codingAttempts.inc({ outcome: oneOf(outcome, ATTEMPT_OUTCOMES) });
    }),
    retry: guard((kind: string) => {
      workerRetries.inc({ kind: oneOf(kind, RETRY_KINDS) });
    }),
    verification: guard((seconds: number, outcome: string) => {
      verificationDuration.observe({ outcome: oneOf(outcome, VERIFY_OUTCOMES) }, Math.max(0, seconds));
    }),
  };

  /**
   * Refreshes the PERSISTED series from the scheduler database. Synchronous, so a scrape sees one consistent snapshot;
   * on any failure the series are simply absent (never stale, never zero-filled) and scheduler_state_up is 0.
   */
  /** prom-client re-emits an unlabelled gauge as 0 after reset(); remove() is what makes the series truly absent. */
  function clearPersisted(): void {
    reviewDecisions.reset();
    schedulerTasks.reset();
    queueDepth.remove();
    activeWorkers.remove();
  }

  function refreshPersisted(): void {
    clearPersisted();
    try {
      const snapshot = readSchedulerState(dbPath(), wallClock());
      queueDepth.set(snapshot.queueDepth);
      activeWorkers.set(snapshot.activeWorkers);
      for (const state of TASK_STATES) schedulerTasks.set({ state }, snapshot.tasksByState[state] ?? 0);
      for (const row of snapshot.reviewDecisions) {
        if (row.count > 0) reviewDecisions.inc({ decision: oneOf(row.decision, REVIEW_DECISIONS), reviewer: /^claude/i.test(row.reviewer) ? 'claude' : 'other' }, row.count);
      }
      schedulerStateUp.set(1);
    } catch (err) {
      clearPersisted();
      schedulerStateUp.set(0);
      if (!(err instanceof SchedulerStateUnavailable)) schedulerReadErrors.inc();
    }
  }

  return {
    registry,
    ...recorders,
    /** Prometheus text exposition (0.0.4). */
    render: async () => {
      try {
        refreshPersisted();
      } catch {
        // observability must never break a scrape
      }
      return registry.metrics();
    },
    contentType: registry.contentType,
  };
}

export type HarnessMetrics = ReturnType<typeof createHarnessMetrics>;

/** Process-wide instance used by the harness; tests build their own with `createHarnessMetrics()`. */
export const harnessMetrics: HarnessMetrics = createHarnessMetrics();

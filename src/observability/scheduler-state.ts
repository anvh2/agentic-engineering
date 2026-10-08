import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../core/paths.ts';
import { DatabaseSync } from 'node:sqlite';

/**
 * Read-only view of the persisted scheduler state, for scrape-time metrics. The scheduler runs in a separate CLI
 * process and SQLite (.workdir/scheduler/scheduler.db) is its only source of truth; this module derives numbers from
 * it and never writes, caches or mirrors anything. Every read opens a fresh read-only connection, so a restarted
 * scheduler, a replaced database file or a locked database can never leave a stale handle behind.
 */

/**
 * Mirrors TASK_STATES / LEASED_STATES in scheduler/types.ts. Deliberately NOT imported: that module pulls in the
 * delegation -> coding-task-runner chain, which imports the metrics module (an import cycle). A test asserts these
 * never drift from the scheduler's own lists.
 */
export const TASK_STATES = ['BACKLOG', 'READY', 'CLAIMED', 'CODING', 'VERIFYING', 'REVIEW_PENDING', 'APPROVED', 'INTEGRATING', 'DONE', 'BLOCKED', 'REVIEW_REJECTED', 'ESCALATED', 'RUNTIME_FAILURE', 'CANCELLED'] as const;
export const LEASED_STATES = ['CLAIMED', 'CODING', 'VERIFYING'] as const;
export type TaskState = (typeof TASK_STATES)[number];
/** Mirrors the integration-owned FailureCategory values in scheduler/types.ts (same import-cycle reason as above). */
export const INTEGRATION_FAILURE_CATEGORIES = ['integration_conflict', 'integration_verification_failed', 'diverged_after_review'] as const;

export interface SchedulerStateSnapshot {
  /** Worker-executor tasks in READY: what a worker could claim next (the scheduler's own claim queue). */
  queueDepth: number;
  /** Worker-executor tasks in a leased state whose lease has not expired. A dead worker's expired lease is not "active". */
  activeWorkers: number;
  tasksByState: Partial<Record<TaskState, number>>;
  /** Tasks BLOCKED because a dependency can never complete (failure_category dependency_failed): the DAG's dead branches. */
  dependencyBlocked: number;
  /** Claims beyond each task's first (lease-expiry / runtime requeues): the retry load the scheduler absorbed. */
  extraClaims: number;
  /** Tasks currently ESCALATED by integration, per failure category (conflict / verification failure / divergence). */
  integrationFailures: { category: string; count: number }[];
  /** Decided reviews. Rows are never deleted, so these are monotonic. */
  reviewDecisions: { decision: string; reviewer: string; count: number }[];
}

/** Same resolution as scripts/lead.ts: AGENTIC_SCHED_DB, else <AGENTIC_SCHED_ROOT|project>/.workdir/scheduler/scheduler.db. */
export function resolveSchedulerDbPath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.AGENTIC_SCHED_DB) return env.AGENTIC_SCHED_DB;
  const project = findProjectRoot(cwd) ?? cwd;
  return join(env.AGENTIC_SCHED_ROOT ?? join(project, '.workdir'), 'scheduler', 'scheduler.db');
}

export class SchedulerStateUnavailable extends Error {}

/** Short on purpose: the read is synchronous, and a held write lock must cost a scrape at most this long. */
const BUSY_TIMEOUT_MS = 250;

export function readSchedulerState(dbPath: string, now: number = Date.now()): SchedulerStateSnapshot {
  if (!existsSync(dbPath)) throw new SchedulerStateUnavailable(`scheduler database not found`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA query_only = ON;`);
    const leased = LEASED_STATES.map(() => '?').join(',');
    const queueDepth = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state = 'READY' AND executor = 'worker'`).get() as { n: number }).n;
    const activeWorkers = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE executor = 'worker' AND state IN (${leased}) AND lease_expires_at IS NOT NULL AND lease_expires_at >= ?`)
        .get(...LEASED_STATES, now) as { n: number }
    ).n;
    const tasksByState: SchedulerStateSnapshot['tasksByState'] = {};
    for (const row of db.prepare('SELECT state, COUNT(*) AS n FROM tasks GROUP BY state').all() as { state: string; n: number }[]) {
      if ((TASK_STATES as readonly string[]).includes(row.state)) tasksByState[row.state as TaskState] = row.n;
    }
    const dependencyBlocked = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state = 'BLOCKED' AND failure_category = 'dependency_failed'`).get() as { n: number }).n;
    const extraClaims = (db.prepare('SELECT COALESCE(SUM(MAX(claims - 1, 0)), 0) AS n FROM tasks').get() as { n: number }).n;
    const integrationFailures = (
      db
        .prepare(`SELECT failure_category AS category, COUNT(*) AS n FROM tasks WHERE state = 'ESCALATED' AND failure_category IN (${INTEGRATION_FAILURE_CATEGORIES.map(() => '?').join(',')}) GROUP BY failure_category`)
        .all(...INTEGRATION_FAILURE_CATEGORIES) as { category: string; n: number }[]
    ).map((r) => ({ category: r.category, count: r.n }));
    const reviewDecisions = (
      db.prepare('SELECT decision, reviewer, COUNT(*) AS n FROM reviews WHERE decision IS NOT NULL GROUP BY decision, reviewer').all() as {
        decision: string;
        reviewer: string | null;
        n: number;
      }[]
    ).map((r) => ({ decision: r.decision, reviewer: r.reviewer ?? '', count: r.n }));
    return { queueDepth, activeWorkers, tasksByState, dependencyBlocked, extraClaims, integrationFailures, reviewDecisions };
  } finally {
    try {
      db.close();
    } catch {
      // closing a failed connection must not mask the original error
    }
  }
}

export interface ModelCapacitySnapshot {
  /** Machine-wide permit count (the model-concurrency limit). */
  permits: number;
  /** Unexpired leases: permits currently held. A crashed holder is counted until its lease expires (at most leaseMs). */
  inUse: number;
}

/** Read-only view of the machine-wide model-capacity database (src/runtime/capacity). Never creates or writes it. */
export function readModelCapacity(dbPath: string, now: number = Date.now(), resource = 'ollama'): ModelCapacitySnapshot {
  if (!existsSync(dbPath)) throw new SchedulerStateUnavailable('model capacity database not found');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA query_only = ON;`);
    const row = db.prepare('SELECT permits FROM capacity WHERE resource = ?').get(resource) as { permits: number } | undefined;
    if (!row) throw new SchedulerStateUnavailable('model capacity has no permit row yet');
    const inUse = (db.prepare('SELECT COUNT(*) AS n FROM leases WHERE resource = ? AND expires_at > ?').get(resource, now) as { n: number }).n;
    return { permits: row.permits, inUse };
  } finally {
    try {
      db.close();
    } catch {
      // closing a failed connection must not mask the original error
    }
  }
}

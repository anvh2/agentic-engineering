import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

export interface SchedulerStateSnapshot {
  /** Worker-executor tasks in READY: what a worker could claim next (the scheduler's own claim queue). */
  queueDepth: number;
  /** Worker-executor tasks in a leased state whose lease has not expired. A dead worker's expired lease is not "active". */
  activeWorkers: number;
  tasksByState: Partial<Record<TaskState, number>>;
  /** Decided reviews. Rows are never deleted, so these are monotonic. */
  reviewDecisions: { decision: string; reviewer: string; count: number }[];
}

/** Same resolution as scripts/lead-sched.ts: HARNESS_SCHED_DB, else <HARNESS_SCHED_ROOT|project>/.workdir/scheduler/scheduler.db. */
export function resolveSchedulerDbPath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.HARNESS_SCHED_DB) return env.HARNESS_SCHED_DB;
  let project = cwd;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'lead')) && existsSync(join(dir, 'package.json'))) {
      project = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  return join(env.HARNESS_SCHED_ROOT ?? join(project, '.workdir'), 'scheduler', 'scheduler.db');
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
    const reviewDecisions = (
      db.prepare('SELECT decision, reviewer, COUNT(*) AS n FROM reviews WHERE decision IS NOT NULL GROUP BY decision, reviewer').all() as {
        decision: string;
        reviewer: string | null;
        n: number;
      }[]
    ).map((r) => ({ decision: r.decision, reviewer: r.reviewer ?? '', count: r.n }));
    return { queueDepth, activeWorkers, tasksByState, reviewDecisions };
  } finally {
    try {
      db.close();
    } catch {
      // closing a failed connection must not mask the original error
    }
  }
}

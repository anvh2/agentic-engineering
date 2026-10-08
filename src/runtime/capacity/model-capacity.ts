import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * One machine-wide limit on concurrent local-model (Ollama) calls, shared by every process that can start one:
 * the Mastra server's coding-task workflow (reached through the lead CLI scheduler), in-process runners
 * (bench), and any second server or checkout. The model is a single machine resource, so the lease database lives
 * outside any checkout: ~/.agentic-engineering/model-capacity.db (override: AGENTIC_MODEL_LOCK_DB). The directory name is a persisted compatibility name: it predates the rename to agentic-engineering and is kept so existing leases stay valid.
 *
 * LEASES. A permit is a row in `leases` with an expiry. Holders renew while their call runs (a renewal of an already
 * expired lease is refused: once expired it is lost, even if nobody has reaped it yet); a crashed holder stops renewing
 * and its permit expires after `leaseMs`, or immediately once its pid is known dead on this host. The permit count is
 * stored in the database (first writer sets it from AGENTIC_MODEL_CONCURRENCY, default 1), so every process enforces
 * the same limit even if their environments differ.
 *
 * FIFO ADMISSION. A caller that cannot be served immediately takes a TICKET: a row in `waiters` whose
 * `INTEGER PRIMARY KEY AUTOINCREMENT` id is assigned by SQLite under its write lock, so ticket order is one total order
 * across every process (and never reused). Admission is one IMMEDIATE transaction (reap dead/expired leases and waiters
 * -> count free permits -> admit):
 *
 *     a waiter is admitted iff  (live waiters with a smaller ticket)  <  (permits - held leases)
 *
 * i.e. the `free` OLDEST live waiters get the `free` available permits. This is strict FIFO and work-conserving at once:
 * a newer waiter can never take a permit while an older live waiter is still queued (no overtaking, hence no starvation),
 * yet every free permit is granted to somebody when permits > 1. The only idle time is bounded polling: an older waiter
 * that has not polled yet delays a free permit by at most `pollMs`. `tryAcquire` (non-blocking) joins the same order: it
 * succeeds only if a permit is free after every live waiter has been served.
 *
 * WAITERS ARE LEASED TOO. A waiter row expires after `waiterLeaseMs` unless its owner renews it (every poll, plus a
 * keepalive timer), and is dropped at once when its pid is dead on this host. A cancelled waiter withdraws its row; a
 * crashed one is reaped by the next admission, so it can block the queue for at most `waiterLeaseMs` (same host: not at
 * all). A live waiter whose row was reaped during a long stall re-inserts itself under its ORIGINAL ticket and keeps its
 * place. A wait can be bounded (`maxWaitMs` -> CapacityWaitTimeout) and cancelled (AbortSignal).
 *
 * Schema note: `waiters` was added by CREATE TABLE IF NOT EXISTS (no migration). A process running pre-FIFO code on the
 * same database still honours the permit count (it only ever counts `leases`) but ignores the queue, so it can overtake;
 * run one version at a time.
 */

/** Default cumulative time one task run may spend queued for model permits (AGENTIC_MODEL_WAIT_BUDGET_MS overrides). */
export const DEFAULT_MODEL_WAIT_BUDGET_MS = 30 * 60_000;

export function modelWaitBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTIC_MODEL_WAIT_BUDGET_MS?.trim();
  if (!raw) return DEFAULT_MODEL_WAIT_BUDGET_MS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`AGENTIC_MODEL_WAIT_BUDGET_MS must be a positive integer (milliseconds), got "${raw}"`);
  return Number(raw);
}

/** The wait for a model permit exceeded its budget. An explicit, recoverable condition, not a model or coding failure. */
export class CapacityWaitTimeout extends Error {
  readonly code = 'capacity_wait_timeout';
  readonly waitedMs: number;
  readonly budgetMs: number;
  constructor(waitedMs: number, budgetMs: number) {
    super(`capacity_wait_timeout: waited ${waitedMs}ms for a model permit (budget ${budgetMs}ms)`);
    this.name = 'CapacityWaitTimeout';
    this.waitedMs = waitedMs;
    this.budgetMs = budgetMs;
  }
}

export interface CapacityLease {
  readonly id: string;
  /** Extends the lease; false means it was lost (expired, reaped or reclaimed): the permit is no longer this holder's. */
  renew(): boolean;
  /** True once a renewal was refused: the holder must stop using the model. */
  readonly lost?: boolean;
  /** Frees the permit. Releasing a lost lease frees nothing (only this lease's own row is ever deleted). */
  release(): void;
}

export interface AcquireOptions {
  /** Identifies the work waiting (the task's contract id), so the scheduler can tell which task is queued. */
  tag?: string;
  /** Upper bound on this wait; exceeding it withdraws the waiter and throws CapacityWaitTimeout. */
  maxWaitMs?: number;
}

export interface ModelCapacityOptions {
  resource?: string;
  /** Used only when the database has no permit count yet. */
  permits?: number;
  leaseMs?: number;
  /** How long a waiter row stays valid without being renewed (a crashed waiter blocks the queue at most this long). */
  waiterLeaseMs?: number;
  pollMs?: number;
  now?: () => number;
  /** pid liveness check (tests inject one). */
  isAlive?: (pid: number) => boolean;
  busyTimeoutMs?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS capacity (resource TEXT PRIMARY KEY, permits INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY, resource TEXT NOT NULL, holder TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL,
  acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leases_resource ON leases(resource);
CREATE TABLE IF NOT EXISTS waiters (
  ticket INTEGER PRIMARY KEY AUTOINCREMENT, resource TEXT NOT NULL, holder TEXT NOT NULL, tag TEXT,
  pid INTEGER NOT NULL, host TEXT NOT NULL, enqueued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS waiters_resource ON waiters(resource, ticket);
`;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}

export class ModelCapacity {
  readonly path: string;
  readonly resource: string;
  readonly leaseMs: number;
  readonly waiterLeaseMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly db: DatabaseSync;
  private readonly host = process.env.HOSTNAME ?? 'localhost';

  constructor(path: string, options: ModelCapacityOptions = {}) {
    this.path = path;
    this.resource = options.resource ?? 'ollama';
    this.leaseMs = options.leaseMs ?? 60_000;
    this.waiterLeaseMs = options.waiterLeaseMs ?? 15_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.isAlive = options.isAlive ?? defaultIsAlive;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 10_000};`);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    const permits = options.permits ?? (Number(process.env.AGENTIC_MODEL_CONCURRENCY) || 1);
    if (!Number.isInteger(permits) || permits < 1) throw new Error('model capacity permits must be a positive integer');
    this.db.prepare('INSERT OR IGNORE INTO capacity (resource, permits) VALUES (?, ?)').run(this.resource, permits);
  }

  get permits(): number {
    return (this.db.prepare('SELECT permits FROM capacity WHERE resource = ?').get(this.resource) as { permits: number }).permits;
  }

  /** Operator action: change the machine-wide limit. */
  setPermits(permits: number): void {
    if (!Number.isInteger(permits) || permits < 1) throw new Error('model capacity permits must be a positive integer');
    this.db.prepare('INSERT INTO capacity (resource, permits) VALUES (?, ?) ON CONFLICT(resource) DO UPDATE SET permits = excluded.permits').run(this.resource, permits);
  }

  /** Currently held, unexpired leases (for status / metrics). */
  holders(): { id: string; holder: string; pid: number; expiresAt: number }[] {
    return (this.db.prepare('SELECT id, holder, pid, expires_at FROM leases WHERE resource = ? AND expires_at > ? ORDER BY acquired_at').all(this.resource, this.now()) as Record<string, any>[]).map((r) => ({ id: r.id, holder: r.holder, pid: r.pid, expiresAt: r.expires_at }));
  }

  /** The live queue, oldest ticket first (for status / metrics / tests). Read-only: does not reap. */
  queue(): { ticket: number; holder: string; tag: string | null; pid: number; enqueuedAt: number }[] {
    return (this.db.prepare('SELECT ticket, holder, tag, pid, enqueued_at FROM waiters WHERE resource = ? AND expires_at > ? ORDER BY ticket').all(this.resource, this.now()) as Record<string, any>[]).map((r) => ({ ticket: r.ticket, holder: r.holder, tag: r.tag, pid: r.pid, enqueuedAt: r.enqueued_at }));
  }

  /** True while work tagged `tag` is queued for a permit (not while it holds one). The scheduler uses this to keep queue time out of a task's execution budget. */
  isWaiting(tag: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM waiters WHERE resource = ? AND tag = ? AND expires_at > ? LIMIT 1').get(this.resource, tag, this.now()));
  }

  /**
   * Permits held, or queue entries waiting, on behalf of work tagged `tag` (the task's contract id). The runner names its
   * holder `<model>:<taskId>:pid<pid>`. Used to confirm that a cancelled run really released the model.
   */
  engagedBy(tag: string): { kind: 'lease' | 'waiter'; holder: string; pid: number }[] {
    const marker = `:${tag}:pid`;
    return [
      ...this.holders().filter((h) => h.holder.includes(marker)).map((h) => ({ kind: 'lease' as const, holder: h.holder, pid: h.pid })),
      ...this.queue().filter((w) => w.tag === tag || w.holder.includes(marker)).map((w) => ({ kind: 'waiter' as const, holder: w.holder, pid: w.pid })),
    ];
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
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
    }
  }

  /** Inside a transaction: drops expired leases/waiters and those of processes known dead on this host. */
  private reap(now: number): void {
    for (const table of ['leases', 'waiters'] as const) {
      this.db.prepare(`DELETE FROM ${table} WHERE resource = ? AND expires_at <= ?`).run(this.resource, now);
      const rows = this.db.prepare(`SELECT ${table === 'leases' ? 'id' : 'ticket AS id'}, pid, host FROM ${table} WHERE resource = ?`).all(this.resource) as { id: string | number; pid: number; host: string }[];
      for (const r of rows) {
        if (r.host === this.host && r.pid !== process.pid && !this.isAlive(r.pid)) this.db.prepare(`DELETE FROM ${table} WHERE ${table === 'leases' ? 'id' : 'ticket'} = ?`).run(r.id);
      }
    }
  }

  private grant(holder: string, now: number): CapacityLease {
    const id = randomUUID();
    this.db.prepare('INSERT INTO leases (id, resource, holder, pid, host, acquired_at, expires_at) VALUES (?,?,?,?,?,?,?)').run(id, this.resource, holder, process.pid, this.host, now, now + this.leaseMs);
    return this.lease(id);
  }

  /**
   * One non-blocking attempt that respects the queue: succeeds only when a permit would still be free after every live
   * waiter has been served. Reclaims expired leases and leases of dead local processes first.
   */
  tryAcquire(holder: string): CapacityLease | undefined {
    const now = this.now();
    return this.tx(() => {
      this.reap(now);
      const held = (this.db.prepare('SELECT COUNT(*) AS n FROM leases WHERE resource = ?').get(this.resource) as { n: number }).n;
      const waiting = (this.db.prepare('SELECT COUNT(*) AS n FROM waiters WHERE resource = ?').get(this.resource) as { n: number }).n;
      return held + waiting < this.permits ? this.grant(holder, now) : undefined;
    });
  }

  /** Takes the next ticket. The ticket's position in the queue is fixed from this moment on. */
  enqueue(holder: string, tag?: string): { ticket: number; enqueuedAt: number } {
    const now = this.now();
    const r = this.withBusyRetry(() =>
      this.db.prepare('INSERT INTO waiters (resource, holder, tag, pid, host, enqueued_at, expires_at) VALUES (?,?,?,?,?,?,?)').run(this.resource, holder, tag ?? null, process.pid, this.host, now, now + this.waiterLeaseMs),
    );
    return { ticket: Number(r.lastInsertRowid), enqueuedAt: now };
  }

  /** Leaves the queue (cancel, timeout, or cleanup after admission). Idempotent. */
  withdraw(ticket: number): void {
    try {
      this.withBusyRetry(() => this.db.prepare('DELETE FROM waiters WHERE ticket = ?').run(ticket));
    } catch {
      /* if this fails the waiter row simply expires (waiterLeaseMs) or is reaped with its pid */
    }
  }

  /** One admission attempt for a ticket: grants a lease iff the ticket is among the `free` oldest live waiters. */
  admit(ticket: number, holder: string, enqueuedAt: number, tag?: string): CapacityLease | undefined {
    const now = this.now();
    return this.tx(() => {
      this.reap(now);
      const mine = this.db.prepare('UPDATE waiters SET expires_at = ? WHERE ticket = ?').run(now + this.waiterLeaseMs, ticket);
      if (Number(mine.changes) === 0) {
        // reaped during a stall although its owner is alive: re-enter under the ORIGINAL ticket, so its place in line is kept
        this.db.prepare('INSERT INTO waiters (ticket, resource, holder, tag, pid, host, enqueued_at, expires_at) VALUES (?,?,?,?,?,?,?,?)').run(ticket, this.resource, holder, tag ?? null, process.pid, this.host, enqueuedAt, now + this.waiterLeaseMs);
      }
      const held = (this.db.prepare('SELECT COUNT(*) AS n FROM leases WHERE resource = ?').get(this.resource) as { n: number }).n;
      const free = this.permits - held;
      if (free <= 0) return undefined;
      const ahead = (this.db.prepare('SELECT COUNT(*) AS n FROM waiters WHERE resource = ? AND ticket < ?').get(this.resource, ticket) as { n: number }).n;
      if (ahead >= free) return undefined;
      this.db.prepare('DELETE FROM waiters WHERE ticket = ?').run(ticket);
      return this.grant(holder, now);
    });
  }

  /**
   * Queues for a permit (FIFO across all processes), then keeps it alive with a heartbeat until released. Abortable:
   * cancelling withdraws the waiter at once. `maxWaitMs` bounds the wait (CapacityWaitTimeout). A transiently locked
   * database delays the wait instead of failing it.
   */
  async acquire(holder: string, signal?: AbortSignal, options: AcquireOptions = {}): Promise<CapacityLease> {
    if (signal?.aborted) throw new Error(`waiting for model capacity aborted: ${String(signal.reason?.message ?? signal.reason ?? '')}`);
    const { ticket, enqueuedAt } = this.enqueue(holder, options.tag);
    const realStart = Date.now();
    const keepalive = setInterval(() => {
      try {
        this.db.prepare('UPDATE waiters SET expires_at = ? WHERE ticket = ?').run(this.now() + this.waiterLeaseMs, ticket);
      } catch {
        /* busy database: the next tick retries before the waiter lease (3 ticks) can expire */
      }
    }, Math.max(50, Math.floor(this.waiterLeaseMs / 3)));
    keepalive.unref?.();
    let admitted = false;
    try {
      for (;;) {
        if (signal?.aborted) throw new Error(`waiting for model capacity aborted: ${String(signal.reason?.message ?? signal.reason ?? '')}`);
        let lease: CapacityLease | undefined;
        try {
          lease = this.admit(ticket, holder, enqueuedAt, options.tag);
        } catch (err) {
          if (!/database is locked|SQLITE_BUSY/i.test((err as Error).message)) throw err;
        }
        if (lease) {
          admitted = true;
          return this.keepAlive(lease);
        }
        const waited = Date.now() - realStart;
        if (options.maxWaitMs !== undefined && waited >= options.maxWaitMs) throw new CapacityWaitTimeout(waited, options.maxWaitMs);
        const sleepMs = options.maxWaitMs === undefined ? this.pollMs : Math.max(1, Math.min(this.pollMs, options.maxWaitMs - waited));
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, sleepMs);
          function done() {
            clearTimeout(t);
            signal?.removeEventListener('abort', done);
            resolve();
          }
          signal?.addEventListener('abort', done, { once: true });
        });
      }
    } finally {
      clearInterval(keepalive);
      if (!admitted) this.withdraw(ticket); // cancelled / timed out / failed: leave the queue so nobody waits behind a dead entry
    }
  }

  private withBusyRetry<T>(fn: () => T): T {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (err) {
        if (attempt >= 20 || !/database is locked|SQLITE_BUSY/i.test((err as Error).message)) throw err;
      }
    }
  }

  private lease(id: string): CapacityLease {
    return {
      id,
      // refused once the lease has expired (even if not yet reaped) or its row is gone: a lost permit stays lost
      renew: () => Number(this.db.prepare('UPDATE leases SET expires_at = ? WHERE id = ? AND expires_at > ?').run(this.now() + this.leaseMs, id, this.now()).changes) === 1,
      release: () => {
        this.db.prepare('DELETE FROM leases WHERE id = ?').run(id);
      },
    };
  }

  private keepAlive(lease: CapacityLease): CapacityLease {
    let lost = false;
    const timer = setInterval(() => {
      try {
        if (!lease.renew()) lost = true;
      } catch {
        /* busy database: the next tick retries before the lease (3 ticks) can expire */
      }
    }, Math.max(50, Math.floor(this.leaseMs / 3)));
    timer.unref?.();
    let released = false;
    return {
      id: lease.id,
      renew: lease.renew,
      get lost() {
        return lost;
      },
      release: () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        try {
          lease.release();
        } catch {
          /* if this fails the lease simply expires */
        }
      },
    };
  }

  close(): void {
    this.db.close();
  }
}

/** Where the machine-wide lease database lives. Under `node --test`, a temp file, so test runs never wait on real model work. */
export function defaultModelCapacityPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTIC_MODEL_LOCK_DB) return env.AGENTIC_MODEL_LOCK_DB;
  if (env.NODE_TEST_CONTEXT) return join(tmpdir(), 'agentic-test-model-capacity.db');
  return join(homedir(), '.agentic-engineering', 'model-capacity.db');
}

let shared: ModelCapacity | undefined;
/** The process-wide handle on the machine-wide limit. */
export function sharedModelCapacity(): ModelCapacity {
  shared ??= new ModelCapacity(defaultModelCapacityPath());
  return shared;
}

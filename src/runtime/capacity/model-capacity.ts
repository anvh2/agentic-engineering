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
 * A permit is a row in `leases` with an expiry. Holders renew while their call runs; a crashed holder stops renewing
 * and its permit expires after `leaseMs`, or immediately once its pid is known dead on this host. Acquisition is one
 * IMMEDIATE transaction (reap expired/dead -> count -> insert), so two processes can never both take the last permit.
 * The permit count is stored in the database (first writer sets it from AGENTIC_MODEL_CONCURRENCY, default 1), so every
 * process enforces the same limit even if their environments differ.
 */

export interface CapacityLease {
  readonly id: string;
  /** Extends the lease; false means it was lost (expired and reclaimed). */
  renew(): boolean;
  release(): void;
}

export interface ModelCapacityOptions {
  resource?: string;
  /** Used only when the database has no permit count yet. */
  permits?: number;
  leaseMs?: number;
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
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly db: DatabaseSync;
  private readonly host = process.env.HOSTNAME ?? 'localhost';

  constructor(path: string, options: ModelCapacityOptions = {}) {
    this.path = path;
    this.resource = options.resource ?? 'ollama';
    this.leaseMs = options.leaseMs ?? 60_000;
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

  /** One non-blocking attempt. Reclaims expired leases and leases of dead local processes first. */
  tryAcquire(holder: string): CapacityLease | undefined {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM leases WHERE resource = ? AND expires_at <= ?').run(this.resource, now);
      const live = this.db.prepare('SELECT id, pid, host FROM leases WHERE resource = ?').all(this.resource) as { id: string; pid: number; host: string }[];
      for (const l of live) if (l.host === this.host && l.pid !== process.pid && !this.isAlive(l.pid)) this.db.prepare('DELETE FROM leases WHERE id = ?').run(l.id);
      const held = (this.db.prepare('SELECT COUNT(*) AS n FROM leases WHERE resource = ?').get(this.resource) as { n: number }).n;
      const permits = (this.db.prepare('SELECT permits FROM capacity WHERE resource = ?').get(this.resource) as { permits: number }).permits;
      if (held >= permits) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO leases (id, resource, holder, pid, host, acquired_at, expires_at) VALUES (?,?,?,?,?,?,?)').run(id, this.resource, holder, process.pid, this.host, now, now + this.leaseMs);
      this.db.exec('COMMIT');
      return this.lease(id);
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  /**
   * Waits for a permit (polling; abortable), then keeps it alive with a heartbeat until released. A transiently locked
   * database delays the wait instead of failing it.
   */
  async acquire(holder: string, signal?: AbortSignal): Promise<CapacityLease> {
    for (;;) {
      if (signal?.aborted) throw new Error(`waiting for model capacity aborted: ${String(signal.reason?.message ?? signal.reason ?? '')}`);
      let lease: CapacityLease | undefined;
      try {
        lease = this.tryAcquire(holder);
      } catch (err) {
        if (!/database is locked|SQLITE_BUSY/i.test((err as Error).message)) throw err;
      }
      if (lease) return this.keepAlive(lease);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.pollMs);
        signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }

  private lease(id: string): CapacityLease {
    return {
      id,
      renew: () => Number(this.db.prepare('UPDATE leases SET expires_at = ? WHERE id = ?').run(this.now() + this.leaseMs, id).changes) === 1,
      release: () => {
        this.db.prepare('DELETE FROM leases WHERE id = ?').run(id);
      },
    };
  }

  private keepAlive(lease: CapacityLease): CapacityLease {
    const timer = setInterval(() => {
      try {
        lease.renew();
      } catch {
        /* busy database: the next tick retries before the lease (3 ticks) can expire */
      }
    }, Math.max(50, Math.floor(this.leaseMs / 3)));
    timer.unref?.();
    let released = false;
    return {
      id: lease.id,
      renew: lease.renew,
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

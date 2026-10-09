import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readModelCapacity, TASK_STATES, LEASED_STATES } from '../../observability/scheduler-state.ts';
import {
  CONTRACT_VERSION,
  eventNames,
  snapshotSchema,
  unknownUsage,
  type ControlAgent,
  type ControlEvent,
  type ControlTask,
  type Snapshot,
} from './contract.ts';

type Row = Record<string, any>;
export interface ReaderOptions {
  dbPath: string;
  capacityDbPath?: string;
  studioOrigin?: string;
  now?: () => number;
}
const limitations = [
  'Activity is evidence-based. CODING and historical success do not prove active inference or online presence.',
  'Provider probes, live model spans, per-call usage, retry usage, quota and task-linked permits are not exposed by Core. These fields are UNKNOWN.',
  'Objectives are scheduler batches, not a separate objective lifecycle. Select one batch to scope all task and usage views.',
  'Capacity counts are machine-wide and sampled separately; they cannot identify an active task or worker.',
  'Timeline contains the latest 200 persisted scheduler events. Provider and inner verification events require a Core read model.',
];
const supported = new Set([
  'task.claimed',
  'task.queued',
  'verification.started',
  'task.review_pending',
  'task.failed',
  'task.cancelled',
  'task.transition',
  'task.audit',
]);
export const eventSupport = Object.fromEntries(eventNames.map((n) => [n, supported.has(n)]));
const roster = [
  ['claude', 'Claude Engineering Lead', 'lead'],
  ['ollama', 'Qwen', 'worker'],
  ['codex', 'Codex', 'worker'],
  ['gemini', 'Gemini', 'worker'],
] as const;
function agents(tasks: ControlTask[]): ControlAgent[] {
  const entries: { id: string; name: string; role: 'lead' | 'worker' }[] = roster.map(([id, name, role]) => ({ id, name, role }));
  for (const provider of new Set(tasks.map((t) => t.provider)))
    if (!entries.some((a) => a.id === provider)) entries.push({ id: provider, name: provider, role: 'worker' });
  return entries.map(({ id, name, role }) => {
    const own = tasks.filter((t) => t.provider === id).sort((a, b) => b.updatedAt - a.updatedAt);
    const assigned = own.filter((t) => (LEASED_STATES as readonly string[]).includes(t.state) && !t.stale);
    const last = own.find((t) => !['BACKLOG', 'READY', 'CLAIMED', 'CODING', 'VERIFYING'].includes(t.state));
    return {
      id,
      name,
      role,
      parentId: role === 'lead' ? null : 'claude',
      provider: id,
      modelId: null,
      activity: assigned.some((t) => t.activity === 'VERIFYING')
        ? 'VERIFYING'
        : assigned.length
          ? 'UNKNOWN'
          : own.some((t) => t.state === 'READY')
            ? 'QUEUED'
            : 'UNKNOWN',
      configured: null,
      availability: 'UNKNOWN',
      historicallyVerified: own.some(
        (t) => ['REVIEW_PENDING', 'APPROVED', 'INTEGRATING', 'DONE'].includes(t.state) && t.provider !== 'claude',
      ),
      assignmentIds: assigned.map((t) => t.id),
      lastOutcome: last?.state ?? null,
      lastEventAt: own.reduce<number | null>((max, t) => (t.lastEventAt === null ? max : Math.max(max ?? 0, t.lastEventAt)), null),
      usage: unknownUsage(),
    };
  });
}
export function emptySnapshot(now: number, objectiveId: string | null): Snapshot {
  return {
    version: CONTRACT_VERSION,
    observedAt: now,
    source: 'disconnected',
    databaseId: null,
    cursor: null,
    objectiveId,
    objectives: [],
    tasks: [],
    agents: agents([]),
    events: [],
    reviews: [],
    calls: [],
    usage: unknownUsage(),
    providers: ['ollama', 'codex', 'gemini'].map((id) => ({ id, usage: unknownUsage(), quota: null, permits: null, permitsInUse: null })),
    eventSupport,
    limitations,
  };
}
function mapEvent(r: Row, databaseId: string): ControlEvent {
  let type: ControlEvent['type'] = 'task.transition';
  if (r.from_state === r.to_state) type = 'task.audit';
  else if (r.to_state === 'CLAIMED') type = 'task.claimed';
  else if (r.to_state === 'READY') type = 'task.queued';
  else if (r.to_state === 'VERIFYING') type = 'verification.started';
  else if (r.to_state === 'REVIEW_PENDING') type = 'task.review_pending';
  else if (r.to_state === 'CANCELLED') type = 'task.cancelled';
  else if (['RUNTIME_FAILURE', 'REVIEW_REJECTED'].includes(r.to_state)) type = 'task.failed';
  return {
    id: `${databaseId}:${r.seq}`,
    sequence: r.seq,
    at: r.at,
    taskId: r.task_id,
    type,
    from: r.from_state,
    to: r.to_state,
    source: 'scheduler.events',
  };
}
/** No SchedulerStore constructor, provider registry, workflow client or write-capable runtime import. */
export function createReader(options: ReaderOptions) {
  const now = options.now ?? Date.now;
  const studio = new URL(options.studioOrigin ?? 'http://localhost:4111');
  if (
    !['http:', 'https:'].includes(studio.protocol) ||
    studio.username ||
    studio.password ||
    studio.search ||
    studio.hash ||
    studio.pathname !== '/'
  )
    throw new Error('Studio must be an HTTP(S) origin without credentials, path or query');
  function transaction<T>(read: (db: DatabaseSync, databaseId: string) => T): T {
    if (!existsSync(options.dbPath)) throw new Error('unavailable');
    const stat = statSync(options.dbPath);
    const db = new DatabaseSync(options.dbPath, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 250; PRAGMA query_only = ON; BEGIN;');
      const first = db.prepare('SELECT seq, task_id, at FROM events ORDER BY seq LIMIT 1').get();
      const databaseId = createHash('sha256')
        .update(JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs, first ?? null]))
        .digest('hex')
        .slice(0, 20);
      const result = read(db, databaseId);
      db.exec('COMMIT;');
      return result;
    } finally {
      db.close();
    }
  }
  return {
    snapshot(objectiveId: string | null = null): Snapshot {
      const at = now();
      try {
        const snapshot = transaction((db, databaseId) => {
          const out = emptySnapshot(at, objectiveId);
          out.source = 'connected';
          out.databaseId = databaseId;
          const head = (db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as Row).seq;
          out.cursor = `${databaseId}:${head}`;
          out.objectives = (db.prepare('SELECT id, project, created_at FROM batches ORDER BY created_at DESC, id').all() as Row[]).map(
            (r) => ({ id: r.id, label: r.project, createdAt: r.created_at, kind: 'scheduler-batch' as const }),
          );
          if (objectiveId === null) return out;
          const rows = db
            .prepare(
              `SELECT t.id, t.batch_id, t.title, t.executor, t.state, t.assigned_worker, t.lease_expires_at, t.claimed_at, t.updated_at, t.run_id, t.run_ids,
            json_extract(t.spec, '$.dependsOn') AS dependencies, json_extract(t.spec, '$.request.provider') AS provider,
            (SELECT MAX(e.at) FROM events e WHERE e.task_id=t.id) AS last_event_at
            FROM tasks t WHERE t.batch_id=? ORDER BY t.created_at, t.id`,
            )
            .all(objectiveId) as Row[];
          out.tasks = rows.map((r) => {
            if (!(TASK_STATES as readonly string[]).includes(r.state)) throw new Error('unsupported state');
            const leased = (LEASED_STATES as readonly string[]).includes(r.state);
            const validLease = leased && r.lease_expires_at !== null && r.lease_expires_at > at;
            const task: ControlTask = {
              id: r.id,
              objectiveId: r.batch_id,
              title: r.title,
              provider: r.executor === 'claude' ? 'claude' : (r.provider ?? 'ollama'),
              workerId: r.assigned_worker,
              state: r.state,
              activity: validLease && r.state === 'VERIFYING' ? 'VERIFYING' : r.state === 'READY' ? 'QUEUED' : 'UNKNOWN',
              stage: r.state,
              dependsOn: JSON.parse(r.dependencies ?? '[]'),
              runId: r.run_id,
              runIds: JSON.parse(r.run_ids),
              traceUrl: r.run_id ? `${studio.origin}/workflows/coding-task-workflow/graph/${encodeURIComponent(r.run_id)}` : null,
              claimedAt: r.claimed_at,
              leaseExpiresAt: r.lease_expires_at,
              updatedAt: r.updated_at,
              lastEventAt: r.last_event_at,
              activeSince: validLease ? r.claimed_at : null,
              elapsedMs: validLease && r.claimed_at !== null ? Math.max(0, at - r.claimed_at) : null,
              stale: leased && !validLease,
              queuePosition: null,
              usage: unknownUsage(),
            };
            return task;
          });
          out.events = (
            db
              .prepare(
                'SELECT e.seq,e.task_id,e.at,e.from_state,e.to_state FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.batch_id=? ORDER BY e.seq DESC LIMIT 200',
              )
              .all(objectiveId) as Row[]
          )
            .reverse()
            .map((r) => mapEvent(r, databaseId));
          out.reviews = (
            db
              .prepare(
                `SELECT r.id,r.task_id,r.created_at,r.round FROM reviews r JOIN tasks t ON t.id=r.task_id WHERE t.batch_id=? AND r.decision IS NULL AND t.state='REVIEW_PENDING' ORDER BY r.created_at`,
              )
              .all(objectiveId) as Row[]
          ).map((r) => ({ id: r.id, taskId: r.task_id, createdAt: r.created_at, round: r.round }));
          out.agents = agents(out.tasks);
          out.providers = out.agents
            .filter((a) => a.role === 'worker')
            .map((a) => ({ id: a.provider, usage: unknownUsage(), quota: null, permits: null, permitsInUse: null }));
          return out;
        });
        if (options.capacityDbPath)
          for (const provider of snapshot.providers) {
            try {
              const cap = readModelCapacity(options.capacityDbPath, at, provider.id);
              provider.permits = cap.permits;
              provider.permitsInUse = cap.inUse;
            } catch {
              /* independent missing capacity stays unknown */
            }
          }
        return snapshotSchema.parse(snapshot);
      } catch {
        return emptySnapshot(at, objectiveId);
      }
    },
    eventsAfter(objectiveId: string, cursor: string): { reset: boolean; cursor: string; events: ControlEvent[] } {
      return transaction((db, databaseId) => {
        const match = /^([a-f0-9]{20}):(\d+)$/.exec(cursor);
        const head = (db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as Row).seq as number;
        if (!match || match[1] !== databaseId || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > head)
          return { reset: true, cursor: `${databaseId}:${head}`, events: [] };
        const rows = db
          .prepare(
            'SELECT e.seq,e.task_id,e.at,e.from_state,e.to_state FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.batch_id=? AND e.seq>? ORDER BY e.seq LIMIT 201',
          )
          .all(objectiveId, Number(match[2])) as Row[];
        if (rows.length > 200) return { reset: true, cursor: `${databaseId}:${head}`, events: [] };
        return { reset: false, cursor: `${databaseId}:${head}`, events: rows.map((r) => mapEvent(r, databaseId)) };
      });
    },
  };
}
export type Reader = ReturnType<typeof createReader>;

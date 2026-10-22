import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readModelCapacity, TASK_STATES, LEASED_STATES } from '../../observability/scheduler-state.ts';
import { z } from 'zod';
import { summarizeUsage } from './usage.ts';
import {
  CONTRACT_VERSION,
  eventNames,
  snapshotSchema,
  unknownUsage,
  type ControlAgent,
  type ControlEvent,
  type ControlTask,
  type ModelCall,
  type Snapshot,
  type Usage,
} from './contract.ts';
import type { FailureCategory } from '../../runtime/scheduler/types.ts';
import type { FindingCode } from '../../runtime/review/change-review.ts';

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
// Closed vocabulary only: never expose free-form state reasons, feedback or artifacts.
const failureCategories = new Set<string>(['coding_attempts_exhausted', 'forbidden_mutation', 'runtime_unavailable', 'task_timeout', 'capacity_wait_timeout', 'executor_error', 'lease_expired', 'review_gate_blocked', 'review_rejected', 'escalated_by_reviewer', 'integration_conflict', 'integration_verification_failed', 'diverged_after_review', 'dependency_failed', 'source_tree_dirty', 'not_eligible', 'provider_not_authorized', 'provider_unavailable', 'cancelled'] satisfies FailureCategory[]);
const findingCodes = new Set<string>(['out_of_scope_file', 'eof_newline', 'whitespace_only_change', 'whitespace_reindent', 'too_large', 'capacity_exceeded', 'security_block', 'security_warn', 'comment_removed', 'allowed_file_deleted', 'evidence_incomplete', 'no_change'] satisfies FindingCode[]);
const reviewOutcomes = new Set(['APPROVED', 'REJECTED_WITH_FEEDBACK', 'ESCALATED_TO_HUMAN']);
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
/** Closed shape of `tasks.artifacts.modelCalls` as the scheduler persists it (mergeModelCalls). Anything else is dropped. */
const persistedCall = z.object({
  runId: z.string().min(1).max(200),
  workerId: z.string().min(1).max(200),
  attempt: z.number().int().positive(),
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  startedAt: z.number().int().nonnegative().nullable(),
  inferenceMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  usageSupport: z.enum(['tokens', 'tokens-and-cost', 'none', 'unknown']),
});
/**
 * Worker invocations recorded by the runner and persisted at completion. Each is one attempt's provider-reported totals
 * (possibly several agent steps), attributed to a run the task actually recorded. Cost is never projected: the runner's
 * local-free 0 is a policy, not a measurement. Returns the calls and whether any persisted entry was rejected.
 */
function taskCalls(raw: string | null, taskId: string, objectiveId: string, runIds: readonly string[]): { calls: ModelCall[]; rejected: boolean } {
  const entries: unknown = raw === null ? [] : JSON.parse(raw);
  const calls: ModelCall[] = [];
  let rejected = false;
  for (const entry of Array.isArray(entries) ? entries.slice(0, 100) : []) {
    const c = persistedCall.safeParse(entry);
    // A call for a run this task never recorded, or without a measured start, cannot be attributed: drop it, never repair it.
    if (!c.success || !runIds.includes(c.data.runId) || c.data.startedAt === null) { rejected = true; continue; }
    const { runId, workerId, attempt, provider, model, startedAt, inferenceMs, inputTokens, outputTokens, usageSupport } = c.data;
    const id = `${taskId}:${runId}:${attempt}`;
    // The scheduler keys entries by (run, attempt); a duplicate means damaged data and is counted once.
    if (calls.some((x) => x.id === id)) { rejected = true; continue; }
    calls.push({
      id, objectiveId, taskId, runId, workerId, provider, modelId: model, attempt,
      startedAt, finishedAt: startedAt + inferenceMs, status: 'COMPLETED', usageSupport,
      usage: { ...unknownUsage(), inputTokens, outputTokens, latencyMs: inferenceMs, source: 'core.model-call', completeness: inputTokens !== null && outputTokens !== null ? 'complete' : 'partial' },
    });
  }
  // The scheduler keeps at most 100 entries by dropping the oldest, which can remove part of a run: a list at the cap may
  // be truncated, so its coverage is never presented as complete.
  return { calls, rejected: rejected || (Array.isArray(entries) && entries.length >= 100) };
}
/** A total over incomplete coverage is reported, but never as complete. */
const coverage = (usage: Usage, gap: boolean): Usage => (gap && usage.completeness === 'complete' ? { ...usage, completeness: 'partial' } : usage);
/**
 * Execution lanes, one per provider that persisted tasks in scope actually name. No static roster:
 * provider ids are not agent identities, model names are not workers, and a lane exists only
 * when the scheduler database records work for it. Role is not inferred from a provider name.
 */
function agents(tasks: ControlTask[]): ControlAgent[] {
  return [...new Set(tasks.map((t) => t.provider))].sort().map((id) => {
    const own = tasks.filter((t) => t.provider === id).sort((a, b) => b.updatedAt - a.updatedAt);
    const assigned = own.filter((t) => (LEASED_STATES as readonly string[]).includes(t.state) && !t.stale);
    const last = own.find((t) => !['BACKLOG', 'READY', 'CLAIMED', 'CODING', 'VERIFYING'].includes(t.state));
    return {
      id,
      name: id,
      role: null,
      parentId: null,
      provider: id,
      modelId: null,
      evidence: assigned.length ? ('ACTIVE' as const) : ('OBSERVED' as const),
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
    providers: [],
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
    operation: r.from_state === r.to_state && r.reason === 'workflow run started' ? 'workflow.started'
      : r.to_state === 'READY' && (r.reason === 'lease expired; requeued' || /^lease expired; requeued \(claim refunded \d+\/\d+\)$/.test(r.reason ?? '')) ? 'lease.requeued'
      : r.from_state === r.to_state && /^claim budget raised \d+ -> \d+: /.test(r.reason ?? '') ? 'claims.extended'
      : null,
  };
}
/** No SchedulerStore constructor, provider registry, workflow client or write-capable runtime import. */
/** Shared scope: a project (batches.project) and optionally one of its scheduler batches. Never inferred from names. */
export interface Scope {
  project?: string | null;
  objectiveId?: string | null;
}
const scopeOf = (scope: Scope | string | null | undefined): { project: string | null; objectiveId: string | null } =>
  typeof scope === 'string' ? { project: null, objectiveId: scope } : { project: scope?.project ?? null, objectiveId: scope?.objectiveId ?? null };
/**
 * The batches a scope covers, from the scheduler's own batch -> project column. One batch: it must exist and, when a project is
 * also given, belong to it (otherwise the scope is empty, never silently widened). A project alone: all of its batches.
 */
function batchesInScope(db: DatabaseSync, scope: { project: string | null; objectiveId: string | null }): { project: string | null; ids: string[] } {
  if (scope.objectiveId !== null) {
    const batch = db.prepare('SELECT id, project FROM batches WHERE id = ?').get(scope.objectiveId) as Row | undefined;
    if (!batch || (scope.project !== null && batch.project !== scope.project)) return { project: scope.project, ids: [] };
    return { project: batch.project, ids: [batch.id] };
  }
  if (scope.project === null) return { project: null, ids: [] };
  return { project: scope.project, ids: (db.prepare('SELECT id FROM batches WHERE project = ? ORDER BY created_at, id').all(scope.project) as Row[]).map((r) => r.id) };
}
const placeholders = (ids: readonly string[]) => ids.map(() => '?').join(',');
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
    snapshot(requested: Scope | string | null = null): Snapshot {
      const at = now();
      const { project, objectiveId } = scopeOf(requested);
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
          const scope = batchesInScope(db, { project, objectiveId });
          out.scope = { project: scope.project, objectiveId, objectiveIds: scope.ids };
          if (!scope.ids.length) return out;
          const rows = db
            .prepare(
              `SELECT t.id, t.batch_id, t.title, t.executor, t.state, t.assigned_worker, t.lease_expires_at, t.claimed_at, t.updated_at, t.run_id, t.run_ids, t.attempts, t.runtime_retries, t.runtime_requeues, t.created_at, t.finished_at, t.failure_category, t.review_outcome,
            json_extract(t.result, '$.verifier.exitCode') AS verifier_exit_code, CASE WHEN json_type(t.result, '$.findings')='array' THEN json_extract(t.result, '$.findings') END AS findings,
            json_extract(t.spec, '$.dependsOn') AS dependencies, json_extract(t.spec, '$.request.provider') AS provider,
            CASE WHEN json_type(t.artifacts, '$.modelCalls')='array' THEN json_extract(t.artifacts, '$.modelCalls') END AS model_calls,
            (SELECT MAX(e.at) FROM events e WHERE e.task_id=t.id) AS last_event_at
            FROM tasks t WHERE t.batch_id IN (${placeholders(scope.ids)}) ORDER BY t.created_at, t.id`,
            )
            .all(...scope.ids) as Row[];
          const gaps = new Set<string>();
          out.tasks = rows.map((r) => {
            if (!(TASK_STATES as readonly string[]).includes(r.state)) throw new Error('unsupported state');
            const leased = (LEASED_STATES as readonly string[]).includes(r.state);
            const validLease = leased && r.lease_expires_at !== null && r.lease_expires_at > at;
            const rawFindings: unknown = r.findings === null ? null : JSON.parse(r.findings);
            const findings = Array.isArray(rawFindings) ? rawFindings.filter(f => f && findingCodes.has(f.code) && ['block', 'warn'].includes(f.severity)).slice(0, 50).map(f => ({ code: f.code, severity: f.severity })) : null;
            const task: ControlTask = {
              id: r.id,
              objectiveId: r.batch_id,
              title: r.title,
              provider: r.executor === 'claude' ? 'claude' : (r.provider ?? 'ollama'),
              workerId: r.assigned_worker,
              state: r.state,
              activity: validLease && r.state === 'VERIFYING' ? 'VERIFYING' : r.state === 'READY' ? 'QUEUED' : 'UNKNOWN',
              stage: r.state,
              execution: {
                attempts: r.attempts, runtimeRetries: r.runtime_retries, runtimeRequeues: r.runtime_requeues,
                createdAt: r.created_at, finishedAt: r.finished_at,
                failureCategory: failureCategories.has(r.failure_category) ? r.failure_category : null,
                reviewOutcome: reviewOutcomes.has(r.review_outcome) ? r.review_outcome : null,
                verifierExitCode: Number.isInteger(r.verifier_exit_code) ? r.verifier_exit_code : null,
                findings,
                findingsOmitted: Array.isArray(rawFindings) ? rawFindings.length - (findings?.length ?? 0) : 0,
              },
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
            const recorded = taskCalls(r.model_calls, task.id, task.objectiveId, task.runIds);
            const runsWithCalls = new Set(recorded.calls.map((c) => c.runId));
            // Coverage gap: a run with no recorded invocation (in flight, crashed, older runtime, or no model call), failed
            // runtime retries (no usage reported), or a rejected entry. The total stays visible but is never 'complete'.
            if (recorded.rejected || task.runIds.some((id) => !runsWithCalls.has(id)) || r.runtime_retries > 0) gaps.add(task.id);
            out.calls.push(...recorded.calls);
            task.usage = coverage(summarizeUsage(recorded.calls, { objectiveId: task.objectiveId, taskId: task.id }), gaps.has(task.id));
            return task;
          });
          // out.calls already holds only this scope's tasks; each task's calls carry that task's own batch.
          out.usage = coverage(summarizeUsage(out.calls, {}), gaps.size > 0);
          out.events = (
            db
              .prepare(
                `SELECT e.seq,e.task_id,e.at,e.from_state,e.to_state,e.reason FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.batch_id IN (${placeholders(scope.ids)}) ORDER BY e.seq DESC LIMIT 200`,
              )
              .all(...scope.ids) as Row[]
          )
            .reverse()
            .map((r) => mapEvent(r, databaseId));
          out.reviews = (
            db
              .prepare(
                `SELECT r.id,r.task_id,r.created_at,r.round FROM reviews r JOIN tasks t ON t.id=r.task_id WHERE t.batch_id IN (${placeholders(scope.ids)}) AND r.decision IS NULL AND t.state='REVIEW_PENDING' ORDER BY r.created_at`,
              )
              .all(...scope.ids) as Row[]
          ).map((r) => ({ id: r.id, taskId: r.task_id, createdAt: r.created_at, round: r.round }));
          out.agents = agents(out.tasks);
          // Provider totals use the provider each call actually ran on; a lane whose calls name another provider is incomplete.
          const laneUsage = (lane: string): Usage => {
            const laneTasks = out.tasks.filter((t) => t.provider === lane);
            const gap = laneTasks.some((t) => gaps.has(t.id)) || out.calls.some((c) => c.provider !== lane && laneTasks.some((t) => t.id === c.taskId));
            return coverage(summarizeUsage(out.calls, { provider: lane }), gap);
          };
          for (const lane of out.agents) lane.usage = laneUsage(lane.provider);
          out.providers = out.agents.map((a) => ({ id: a.provider, usage: a.usage, quota: null, permits: null, permitsInUse: null }));
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
    eventsAfter(requested: Scope | string, cursor: string): { reset: boolean; cursor: string; events: ControlEvent[] } {
      return transaction((db, databaseId) => {
        const scope = batchesInScope(db, scopeOf(requested));
        const match = /^([a-f0-9]{20}):(\d+)$/.exec(cursor);
        const head = (db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as Row).seq as number;
        if (!match || match[1] !== databaseId || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > head)
          return { reset: true, cursor: `${databaseId}:${head}`, events: [] };
        const rows = db
          .prepare(
            `SELECT e.seq,e.task_id,e.at,e.from_state,e.to_state,e.reason FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.batch_id IN (${placeholders(scope.ids)}) AND e.seq>? ORDER BY e.seq LIMIT 201`,
          )
          .all(...scope.ids, Number(match[2])) as Row[];
        if (rows.length > 200) return { reset: true, cursor: `${databaseId}:${head}`, events: [] };
        return { reset: false, cursor: `${databaseId}:${head}`, events: rows.map((r) => mapEvent(r, databaseId)) };
      });
    },
  };
}
export type Reader = ReturnType<typeof createReader>;

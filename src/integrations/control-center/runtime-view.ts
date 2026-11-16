import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { computeAgentMetrics, type AgentMetrics } from '../../runtime/agents/metrics.ts';

/**
 * Read model for the runtime: project and target repository, GitHub issues (as last synchronized), objectives with their task
 * DAG, the Engineering Lead and the SPAWNED agent processes with their live state, recent agent events and metrics. Read-only
 * over the scheduler database; it constructs no runtime, scheduler or provider and writes nothing.
 *
 * Live state is derived only from recorded evidence. A RUNNING agent whose heartbeat is stale, or whose process cannot be found
 * on this host, is shown as UNKNOWN with the reason, never as working. Nothing is inferred from IDE or chat sessions.
 */

export const RUNTIME_VIEW_SCHEMA = 'agentic.runtime-view/1';
export const STALE_HEARTBEAT_MS = 30_000;

export type LiveState =
  | 'SPAWNING' | 'PROCESS_ALIVE' | 'WAITING_FOR_MODEL_PERMIT' | 'MODEL_INFERENCE' | 'TOOL_EXECUTION' | 'VERIFICATION'
  | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'SUPERSEDED' | 'LOST' | 'SPAWN_FAILED' | 'UNKNOWN';

export interface RuntimeView {
  schema: typeof RUNTIME_VIEW_SCHEMA;
  observedAt: number;
  source: 'connected' | 'disconnected';
  scope: { project: string | null; objectiveId: string | null };
  projects: { projectId: string; repositoryId: string; canonicalRoot: string; gitCommonDir: string; githubRepo: string | null; origin: string | null; worktreeRoot: string; isFramework: boolean }[];
  issues: { number: number; title: string; state: string; url: string; labels: string[]; milestone: string | null; syncedAt: number; linkedObjectives: string[] }[];
  objectives: {
    id: string; project: string; description: string; createdAt: number; issues: number[];
    target: { repositoryId: string; canonicalRoot: string; worktreeRoot: string } | null;
    lifecycle: { phase: string; updatedAt: number } | null;
    progress: { total: number; done: number; failed: number; inFlight: number; waiting: number };
    tasks: { id: string; title: string; state: string; stateReason: string | null; dependsOn: string[]; blockedBy: string[]; executor: string; failureCategory: string | null; worktree: string | null; branch: string | null; headCommit: string | null; reviewOutcome: string | null; runId: string | null; traceUrl: string | null; routedModel: string | null; routingReason: string | null; verifierExitCode: number | null; integratedCommit: string | null }[];
  }[];
  lead: { identity: 'engineering-lead'; supervisedProcess: false; note: string; plannedObjectives: number; reviewDecisions: number; lastActivityAt: number | null };
  agents: {
    executionId: string; agentId: string; role: string; project: string | null; objectiveId: string | null; taskId: string; claimEpoch: number | null;
    runId: string | null; traceUrl: string | null; pid: number | null; host: string; provider: string; assignedModel: string | null; reportedModel: string | null;
    worktree: string; status: string; liveState: LiveState; liveDetail: string | null; spawnedAt: number; startedAt: number | null; endedAt: number | null;
    heartbeatAt: number | null; exitCode: number | null; outcome: string | null; failure: string | null; permitWaitMs: number; inferenceMs: number;
    toolCalls: number; inputTokens: number | null; outputTokens: number | null; logPath: string | null;
  }[];
  agentEvents: { seq: number; executionId: string; at: number; type: string; detail: Record<string, unknown> | null }[];
  metrics: AgentMetrics | null;
  limitations: string[];
}

type Row = Record<string, any>;
const hasTable = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

function pidAlive(pid: number | null): boolean | null {
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The live state of one execution row, from its own evidence. */
export function liveStateOf(row: { status: string; activity: string | null; activity_detail?: string | null; heartbeat_at: number | null; pid: number | null; host: string }, now: number, localHost = hostname()): { state: LiveState; detail: string | null } {
  if (row.status === 'SPAWNING') return { state: 'SPAWNING', detail: null };
  if (row.status !== 'RUNNING') return { state: row.status as LiveState, detail: null };
  if (row.host === localHost && pidAlive(row.pid) === false) return { state: 'UNKNOWN', detail: `process ${row.pid} not found on this host; no exit was recorded (run: lead agents reconcile)` };
  if (row.heartbeat_at === null || now - row.heartbeat_at > STALE_HEARTBEAT_MS) return { state: 'UNKNOWN', detail: `no heartbeat for ${row.heartbeat_at === null ? 'ever' : `${Math.round((now - row.heartbeat_at) / 1000)}s`}` };
  const byActivity: Record<string, LiveState> = { WAITING_PERMIT: 'WAITING_FOR_MODEL_PERMIT', INFERENCE: 'MODEL_INFERENCE', TOOL: 'TOOL_EXECUTION', VERIFYING: 'VERIFICATION' };
  return { state: byActivity[row.activity ?? ''] ?? 'PROCESS_ALIVE', detail: row.activity_detail ?? row.activity ?? null };
}

export function createRuntimeReader(options: { dbPath: string; studioOrigin?: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const studio = new URL(options.studioOrigin ?? 'http://localhost:4111').origin;
  const empty = (at: number, scope: RuntimeView['scope'], reason: string): RuntimeView => ({
    schema: RUNTIME_VIEW_SCHEMA, observedAt: at, source: 'disconnected', scope, projects: [], issues: [], objectives: [],
    lead: { identity: 'engineering-lead', supervisedProcess: false, note: 'UNKNOWN', plannedObjectives: 0, reviewDecisions: 0, lastActivityAt: null },
    agents: [], agentEvents: [], metrics: null, limitations: [reason],
  });
  return {
    view(scope: { project: string | null; objectiveId: string | null }): RuntimeView {
      const at = now();
      if (!existsSync(options.dbPath)) return empty(at, scope, 'scheduler database not found');
      const db = new DatabaseSync(options.dbPath, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 250; PRAGMA query_only = ON; BEGIN;');
        const limitations: string[] = [];
        const batches = (db.prepare('SELECT * FROM batches ORDER BY created_at').all() as Row[]).filter((b) => (!scope.project || b.project === scope.project) && (!scope.objectiveId || b.id === scope.objectiveId));
        const batchIds = new Set(batches.map((b) => b.id as string));
        const projectIds = new Set(batches.map((b) => b.project as string));
        if (scope.project) projectIds.add(scope.project);
        const unscoped = !scope.project && !scope.objectiveId;

        const projects = hasTable(db, 'projects')
          ? (db.prepare('SELECT * FROM projects ORDER BY project_id').all() as Row[]).filter((p) => unscoped || projectIds.has(p.project_id)).map((p) => {
              const id = JSON.parse(p.identity);
              return { projectId: p.project_id, repositoryId: p.repository_id, canonicalRoot: p.canonical_root, gitCommonDir: p.git_common_dir, githubRepo: p.github_repo, origin: id.origin ?? null, worktreeRoot: id.worktreeRoot, isFramework: !!id.isFramework };
            })
          : [];
        if (!projects.length) limitations.push('No registered project in scope (lead project add <id> --repo <path>): repository identity comes only from batch records.');

        const batchIssues = hasTable(db, 'batch_issues') ? (db.prepare('SELECT batch_id, number FROM batch_issues').all() as Row[]) : [];
        const issues = hasTable(db, 'project_issues')
          ? (db.prepare('SELECT * FROM project_issues ORDER BY project_id, number').all() as Row[]).filter((i) => unscoped || projectIds.has(i.project_id)).map((i) => ({
              number: i.number, title: i.title, state: i.state, url: i.url, labels: JSON.parse(i.labels), milestone: i.milestone, syncedAt: i.synced_at,
              linkedObjectives: batchIssues.filter((l) => l.number === i.number && batchIds.has(l.batch_id)).map((l) => l.batch_id as string),
            }))
          : [];
        if (!issues.length) limitations.push('No synchronized GitHub issues in scope (lead project sync-issues <id>). GitHub remains the source of truth.');

        const targets = hasTable(db, 'batch_targets') ? new Map((db.prepare('SELECT batch_id, identity FROM batch_targets').all() as Row[]).map((r) => [r.batch_id, JSON.parse(r.identity)])) : new Map();
        const lifecycle = hasTable(db, 'objective_lifecycle') ? new Map((db.prepare('SELECT batch_id, phase, updated_at FROM objective_lifecycle').all() as Row[]).map((r) => [r.batch_id, { phase: r.phase, updatedAt: r.updated_at }])) : new Map();
        const failedStates = ['ESCALATED', 'RUNTIME_FAILURE', 'BLOCKED', 'CANCELLED', 'REVIEW_REJECTED'];
        const objectives = batches.map((b) => {
          const tasks = db.prepare('SELECT * FROM tasks WHERE batch_id = ? ORDER BY created_at, id').all(b.id) as Row[];
          const state = new Map(tasks.map((t) => [t.id, t.state]));
          const target = targets.get(b.id);
          return {
            id: b.id, project: b.project, description: b.description, createdAt: b.created_at, issues: batchIssues.filter((l) => l.batch_id === b.id).map((l) => l.number as number),
            target: target ? { repositoryId: target.repositoryId, canonicalRoot: target.canonicalRoot, worktreeRoot: target.worktreeRoot } : null,
            lifecycle: lifecycle.get(b.id) ?? null,
            progress: {
              total: tasks.length,
              done: tasks.filter((t) => t.state === 'DONE').length,
              failed: tasks.filter((t) => failedStates.includes(t.state)).length,
              inFlight: tasks.filter((t) => ['CLAIMED', 'CODING', 'VERIFYING', 'INTEGRATING'].includes(t.state)).length,
              waiting: tasks.filter((t) => ['BACKLOG', 'READY', 'REVIEW_PENDING', 'APPROVED'].includes(t.state)).length,
            },
            tasks: tasks.map((t) => {
              const spec = JSON.parse(t.spec);
              const artifacts = JSON.parse(t.artifacts);
              const result = t.result ? JSON.parse(t.result) : null;
              const routing = artifacts.modelRouting as { selected?: { providerId: string; modelId: string } | null; reason?: string } | undefined;
              const dependsOn: string[] = spec.dependsOn ?? [];
              return {
                id: t.id, title: t.title, state: t.state, stateReason: t.state_reason, dependsOn,
                blockedBy: dependsOn.filter((d) => state.get(d) !== 'DONE'),
                executor: t.executor, failureCategory: t.failure_category, worktree: t.worktree_path, branch: t.branch, headCommit: t.head_commit,
                reviewOutcome: t.review_outcome, runId: t.run_id,
                traceUrl: t.run_id ? `${studio}/workflows/coding-task-workflow/graph/${encodeURIComponent(t.run_id)}` : null,
                routedModel: routing?.selected ? `${routing.selected.providerId}/${routing.selected.modelId}` : null,
                routingReason: routing?.reason ?? null,
                verifierExitCode: Number.isInteger(result?.verifier?.exitCode) ? result.verifier.exitCode : null,
                integratedCommit: typeof artifacts.integration?.integratedCommit === 'string' ? artifacts.integration.integratedCommit : null,
              };
            }),
          };
        });

        const taskIds = new Set(objectives.flatMap((o) => o.tasks.map((t) => t.id)));
        const reviews = (db.prepare('SELECT decided_at, task_id FROM reviews WHERE decision IS NOT NULL').all() as Row[]).filter((r) => taskIds.has(r.task_id));
        const planned = (db.prepare("SELECT task_id, at FROM events WHERE from_state IS NULL").all() as Row[]).filter((e) => taskIds.has(e.task_id));
        const lead: RuntimeView['lead'] = {
          identity: 'engineering-lead',
          supervisedProcess: false,
          note: 'The Engineering Lead plans, reviews and decides; it is not a runtime-spawned worker process. Its actions appear here only as recorded plans and review decisions.',
          plannedObjectives: batches.length,
          reviewDecisions: reviews.length,
          lastActivityAt: Math.max(0, ...planned.map((e) => e.at), ...reviews.map((r) => r.decided_at ?? 0)) || null,
        };

        let agents: RuntimeView['agents'] = [];
        let agentEvents: RuntimeView['agentEvents'] = [];
        if (hasTable(db, 'agent_executions')) {
          const rows = (db.prepare('SELECT * FROM agent_executions ORDER BY spawned_at DESC LIMIT 500').all() as Row[]).filter((r) => unscoped || (r.batch_id && batchIds.has(r.batch_id)));
          agents = rows.map((r) => {
            const live = liveStateOf(r as never, at);
            return {
              executionId: r.execution_id, agentId: r.agent_id, role: r.role, project: r.project, objectiveId: r.batch_id, taskId: r.task_id, claimEpoch: r.claim_epoch,
              runId: r.run_id, traceUrl: r.run_id ? `${studio}/workflows/coding-task-workflow/graph/${encodeURIComponent(r.run_id)}` : null,
              pid: r.pid, host: r.host, provider: r.provider, assignedModel: r.assigned_model, reportedModel: r.reported_model, worktree: r.worktree,
              status: r.status, liveState: live.state, liveDetail: live.detail, spawnedAt: r.spawned_at, startedAt: r.started_at, endedAt: r.ended_at,
              heartbeatAt: r.heartbeat_at, exitCode: r.exit_code, outcome: r.outcome, failure: r.failure, permitWaitMs: r.permit_wait_ms, inferenceMs: r.inference_ms,
              toolCalls: r.tool_calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens, logPath: r.log_path,
            };
          });
          const ids = agents.map((a) => a.executionId);
          if (ids.length) {
            agentEvents = (db.prepare(`SELECT * FROM agent_events WHERE execution_id IN (${ids.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 300`).all(...ids) as Row[])
              .reverse()
              .map((e) => ({ seq: e.seq, executionId: e.execution_id, at: e.at, type: e.type, detail: e.detail ? JSON.parse(e.detail) : null }));
          }
        } else limitations.push('No agent process has ever been spawned on this database.');

        const metrics = computeAgentMetrics(db, { ...(scope.project ? { project: scope.project } : {}), ...(scope.objectiveId ? { batchId: scope.objectiveId } : {}) });
        db.exec('COMMIT;');
        return { schema: RUNTIME_VIEW_SCHEMA, observedAt: at, source: 'connected', scope, projects, issues, objectives, lead, agents, agentEvents, metrics, limitations };
      } catch (err) {
        return empty(at, scope, `runtime view unavailable: ${(err as Error).message}`);
      } finally {
        db.close();
      }
    },
  };
}
export type RuntimeReader = ReturnType<typeof createRuntimeReader>;

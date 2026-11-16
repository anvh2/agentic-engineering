import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { AGENT_STATUSES } from './agent-store.ts';

/**
 * Is the multi-agent architecture actually working? Measured only from persisted records: agent_executions (spawned
 * processes), tasks/events (logical work and its outcomes) and objective_lifecycle_events (acceptance). Nothing is
 * estimated; a quantity without data is null (UNKNOWN), never 0.
 */

export interface AgentMetrics {
  scope: { project: string | null; batchId: string | null };
  /** Logical worker claims (scheduler leases) versus agent processes actually spawned for them. */
  logicalClaims: number;
  distinctLogicalWorkers: number;
  agentsSpawned: number;
  agentSpawnSuccessRate: number | null;
  agentsByStatus: Record<string, number>;
  /** Executions per evidence class: a provider-reported model identity, or none (UNKNOWN: e.g. a CLI that does not say). */
  executionsByEvidence: { providerReportedModel: number; modelUnknown: number };
  workerTasks: number;
  acceptedTasks: number;
  workerTaskAcceptanceRate: number | null;
  firstPassAcceptanceRate: number | null;
  retryRate: number | null;
  escalationRate: number | null;
  permitWaitMs: number;
  inferenceMs: number;
  /** Per assigned model: executions, inference time, tokens and cost (local-free models cost 0; other cost is UNKNOWN). */
  models: { assignedModel: string; reportedModels: string[]; executions: number; inferenceMs: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }[];
  humanInterventions: number;
  humanInterventionRate: number | null;
  failureTaxonomy: { category: string; count: number }[];
  worktrees: { created: number; stillPresent: number; removed: number };
  objectives: { id: string; acceptedAfterMs: number | null; phase: string }[];
}

const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
const hasTable = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export function computeAgentMetrics(db: DatabaseSync, scope: { project?: string; batchId?: string } = {}): AgentMetrics {
  const taskWhere = scope.batchId ? 'WHERE batch_id = ?' : scope.project ? 'WHERE project = ?' : '';
  const taskArgs = scope.batchId ? [scope.batchId] : scope.project ? [scope.project] : [];
  const tasks = db.prepare(`SELECT id, batch_id, state, executor, claims, attempts, corrections, correction_of, superseded_by, failure_category, worktree_path, implemented_by FROM tasks ${taskWhere}`).all(...taskArgs) as Record<string, any>[];
  const ids = new Set(tasks.map((t) => t.id as string));
  const batches = new Set(tasks.map((t) => t.batch_id as string));
  const events = (db.prepare('SELECT task_id, to_state, actor FROM events').all() as Record<string, any>[]).filter((e) => ids.has(e.task_id));
  const agents = hasTable(db, 'agent_executions') ? (db.prepare('SELECT * FROM agent_executions').all() as Record<string, any>[]).filter((r) => ids.has(r.task_id)) : [];

  const workerTasks = tasks.filter((t) => t.executor === 'worker');
  const started = workerTasks.filter((t) => t.claims > 0);
  const accepted = workerTasks.filter((t) => t.state === 'DONE' && t.implemented_by !== 'claude');
  const firstPass = accepted.filter((t) => !t.correction_of && !t.superseded_by && t.corrections === 0 && t.claims <= 1 && t.attempts <= 1);
  const retried = started.filter((t) => t.claims > 1 || t.attempts > 1 || t.correction_of);
  const escalated = new Set(events.filter((e) => e.to_state === 'ESCALATED').map((e) => e.task_id));
  const human = events.filter((e) => e.actor === 'human').length;

  const byStatus: Record<string, number> = Object.fromEntries(AGENT_STATUSES.map((s) => [s, 0]));
  for (const a of agents) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
  const spawned = agents.filter((a) => a.status !== 'SPAWN_FAILED' && a.pid !== null).length;

  const models = new Map<string, AgentMetrics['models'][number]>();
  for (const a of agents) {
    const key = (a.assigned_model as string | null) ?? 'UNKNOWN';
    const m = models.get(key) ?? { assignedModel: key, reportedModels: [], executions: 0, inferenceMs: 0, inputTokens: null, outputTokens: null, costUsd: key.startsWith('ollama/') ? 0 : null };
    m.executions += 1;
    m.inferenceMs += a.inference_ms;
    if (a.reported_model && !m.reportedModels.includes(a.reported_model)) m.reportedModels.push(a.reported_model);
    if (a.input_tokens !== null) m.inputTokens = (m.inputTokens ?? 0) + a.input_tokens;
    if (a.output_tokens !== null) m.outputTokens = (m.outputTokens ?? 0) + a.output_tokens;
    models.set(key, m);
  }

  const failures = new Map<string, number>();
  for (const t of tasks) if (t.failure_category) failures.set(`task:${t.failure_category}`, (failures.get(`task:${t.failure_category}`) ?? 0) + 1);
  for (const a of agents) if (!['COMPLETED', 'RUNNING', 'SPAWNING'].includes(a.status)) failures.set(`agent:${a.status}`, (failures.get(`agent:${a.status}`) ?? 0) + 1);

  const withWorktree = tasks.filter((t) => t.worktree_path);
  const present = withWorktree.filter((t) => existsSync(t.worktree_path)).length;

  const objectives: AgentMetrics['objectives'] = [];
  if (hasTable(db, 'objective_lifecycle')) {
    for (const o of db.prepare('SELECT objective_id, batch_id, phase, created_at FROM objective_lifecycle').all() as Record<string, any>[]) {
      if ((scope.batchId || scope.project) && !batches.has(o.batch_id)) continue;
      const accept = db.prepare("SELECT MIN(at) AS at FROM objective_lifecycle_events WHERE objective_id = ? AND to_phase = 'ACCEPTED'").get(o.objective_id) as { at: number | null };
      objectives.push({ id: o.objective_id, phase: o.phase, acceptedAfterMs: accept.at ? accept.at - o.created_at : null });
    }
  }

  return {
    scope: { project: scope.project ?? null, batchId: scope.batchId ?? null },
    logicalClaims: tasks.reduce((a, t) => a + t.claims, 0),
    distinctLogicalWorkers: new Set(events.filter((e) => /^worker-/.test(e.actor)).map((e) => e.actor)).size,
    agentsSpawned: spawned,
    agentSpawnSuccessRate: ratio(spawned, agents.length),
    agentsByStatus: byStatus,
    executionsByEvidence: { providerReportedModel: agents.filter((a) => a.reported_model).length, modelUnknown: agents.filter((a) => !a.reported_model).length },
    workerTasks: workerTasks.length,
    acceptedTasks: accepted.length,
    workerTaskAcceptanceRate: ratio(accepted.length, started.length),
    firstPassAcceptanceRate: ratio(firstPass.length, started.filter((t) => !t.correction_of).length),
    retryRate: ratio(retried.length, started.length),
    escalationRate: ratio(started.filter((t) => escalated.has(t.id)).length, started.length),
    permitWaitMs: agents.reduce((a, r) => a + r.permit_wait_ms, 0),
    inferenceMs: agents.reduce((a, r) => a + r.inference_ms, 0),
    models: [...models.values()],
    humanInterventions: human,
    humanInterventionRate: ratio(human, events.length),
    failureTaxonomy: [...failures].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    worktrees: { created: withWorktree.length, stillPresent: present, removed: withWorktree.length - present },
    objectives,
  };
}

import { SpanType } from '@mastra/core/observability';
import { AgentStore } from '../../../runtime/agents/agent-store.ts';
import { AGENT_SPEC_SCHEMA, agentIdFor, newExecutionId, spawnAgent, type AgentExit, type AgentMessage, type AgentSpec } from '../../../runtime/agents/supervisor.ts';
import type { EngineeringResult } from '../../../runtime/execution/delegation.ts';
import type { TraceEvent } from '../../../runtime/execution/coding-task-trace.ts';
import { resolveSchedulerDbPath } from '../../../observability/scheduler-state.ts';

/**
 * The `run-coding-worker` step in production: the worker runs as an independent, runtime-supervised OS process (see
 * src/runtime/agents), not inside this Mastra server. The step stays the Studio-visible record: the agent's lifecycle and its
 * permit wait, inference, tool calls and verification become phase updates and child spans of the step's trace, and its
 * row in `agent_executions` is what the Organization view reads. No coding, retry or verification logic lives here.
 */

/** What the scheduler tells the workflow about the execution context (all optional: a run started from Studio has none). */
export interface ExecutionContextInput {
  project?: string | null;
  batchId?: string | null;
  claimEpoch?: number | null;
  model?: { providerId: string; modelId: string } | null;
  target?: { repositoryId: string; gitCommonDir: string; worktreeRoot: string } | null;
}

export interface AgentProcessStepInput {
  taskId: string;
  repository: string;
  provider: string;
  request: Record<string, unknown>;
  execution: ExecutionContextInput | undefined;
  artifactDir: string;
  runId: string;
  abortSignal?: AbortSignal;
  modelTimeoutMs: number;
  tracingContext?: { currentSpan?: SpanLike };
  onTrace(event: TraceEvent): void;
  store?: AgentStore;
  entry?: string;
  timeoutMs?: number;
  allowedTools: string[];
}

interface SpanLike {
  createChildSpan(options: { type: SpanType; name: string; input?: unknown; metadata?: Record<string, unknown> }): SpanLike;
  end(options?: { output?: unknown; metadata?: Record<string, unknown> }): void;
  update?(options: { metadata?: Record<string, unknown> }): void;
}

export interface AgentProcessOutcome {
  result: EngineeringResult;
  agent: { executionId: string; agentId: string; pid: number | null; status: string; exitCode: number | null; logPath: string; reportedModel: string | null; assignedModel: string | null };
}

export async function runAgentProcessStep(input: AgentProcessStepInput): Promise<AgentProcessOutcome> {
  const store = input.store ?? new AgentStore(resolveSchedulerDbPath());
  const owned = !input.store;
  const executionId = newExecutionId(input.taskId);
  const spec: AgentSpec = {
    schema: AGENT_SPEC_SCHEMA,
    executionId,
    agentId: agentIdFor('coding-worker', input.taskId),
    role: 'coding-worker',
    project: input.execution?.project ?? null,
    batchId: input.execution?.batchId ?? null,
    taskId: input.taskId,
    claimEpoch: input.execution?.claimEpoch ?? null,
    runId: input.runId,
    provider: input.provider,
    model: input.provider === 'ollama' ? (input.execution?.model ?? null) : null,
    worktree: input.repository,
    target: input.execution?.target ?? null,
    request: input.request,
    allowedTools: input.allowedTools,
    artifactDir: input.artifactDir,
    modelTimeoutMs: input.modelTimeoutMs,
  };

  const root = input.tracingContext?.currentSpan;
  let agentSpan: SpanLike | undefined;
  try {
    agentSpan = root?.createChildSpan({
      type: SpanType.GENERIC,
      name: `agent process ${spec.agentId}`,
      input: { worktree: spec.worktree, provider: spec.provider, model: spec.model, allowedTools: spec.allowedTools },
      metadata: { projectId: spec.project, objectiveId: spec.batchId, taskId: spec.taskId, agentId: spec.agentId, executionId, runId: spec.runId, provider: spec.provider, assignedModel: spec.model ? `${spec.model.providerId}/${spec.model.modelId}` : 'UNKNOWN' },
    });
  } catch {
    agentSpan = undefined; // tracing never decides anything
  }
  const open = new Map<string, SpanLike>();
  const child = (key: string, name: string, metadata: Record<string, unknown>) => {
    try {
      const span = agentSpan?.createChildSpan({ type: SpanType.GENERIC, name, metadata });
      if (span) open.set(key, span);
    } catch {
      /* ignore */
    }
  };
  const close = (key: string, output?: unknown) => {
    const span = open.get(key);
    open.delete(key);
    try {
      span?.end({ output });
    } catch {
      /* ignore */
    }
  };

  const onMessage = (message: AgentMessage) => {
    if (message.type === 'tool') {
      if (message.phase === 'started') child(`tool:${message.name}`, `tool ${message.name}`, { tool: message.name });
      else close(`tool:${message.name}`, { ok: message.ok ?? null });
      return;
    }
    if (message.type === 'model_identity') {
      try {
        agentSpan?.update?.({ metadata: { reportedModel: message.reported ?? 'UNKNOWN' } });
      } catch {
        /* ignore */
      }
      return;
    }
    if (message.type !== 'trace') return;
    const { type, data } = message.event;
    if (type === 'permit_wait_started') child('permit', 'model permit wait', { resource: data.resource });
    if (type === 'model_started') {
      close('permit', { waitedMs: data.capacityWaitMs });
      child('inference', `model inference (attempt ${String(data.attempt)})`, { model: data.providerModel ?? data.model, provider: data.provider });
    }
    if (type === 'model_finished') close('inference', { durationMs: data.durationMs, inputTokens: data.inputTokens, outputTokens: data.outputTokens, error: data.error });
    if (type === 'verification_started') child('verify', 'runtime verification (sandbox)', { command: data.command });
    if (type === 'verification_finished') close('verify', { exitCode: data.exitCode, passed: data.passed });
    input.onTrace({ seq: 0, ts: message.event.ts ?? new Date().toISOString(), type: type as TraceEvent['type'], data });
  };

  let exit: AgentExit;
  try {
    exit = await spawnAgent(spec, { store, signal: input.abortSignal, timeoutMs: input.timeoutMs ?? 60 * 60_000, onMessage, entry: input.entry });
  } finally {
    for (const key of [...open.keys()]) close(key, { closedBy: 'agent exit' });
  }
  const row = store.get(executionId);
  if (owned) store.close();
  const agent = { executionId, agentId: spec.agentId, pid: exit.pid, status: exit.status, exitCode: exit.exitCode, logPath: exit.logPath, reportedModel: row?.reportedModel ?? null, assignedModel: row?.assignedModel ?? null };
  try {
    agentSpan?.end({ output: { status: exit.status, exitCode: exit.exitCode, signal: exit.signal, failure: exit.failure, outcome: (exit.result as { status?: string } | null)?.status ?? null }, metadata: { pid: exit.pid, reportedModel: agent.reportedModel ?? 'UNKNOWN' } });
  } catch {
    /* ignore */
  }
  if (exit.status === 'COMPLETED' && exit.result) return { result: exit.result as EngineeringResult, agent };
  // The process did not complete with a verdict: a runtime failure of the agent, never a coding verdict and never a PASS.
  return {
    result: { taskId: input.taskId, status: 'RUNTIME_FAILURE', reasons: [`agent_${exit.status.toLowerCase()}: ${exit.failure ?? 'no result'} (execution ${executionId}, log ${exit.logPath})`], diff: '', restored: false, artifactDir: input.artifactDir },
    agent,
  };
}

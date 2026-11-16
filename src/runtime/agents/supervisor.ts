import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { findProjectRoot } from '../../core/paths.ts';
import { TERMINAL_AGENT_STATUSES, type AgentActivity, type AgentExecutionRow, type AgentStatus, type AgentStore } from './agent-store.ts';

/**
 * Runtime-owned agent processes. `spawnAgent` starts ONE independent OS process for one worker execution and supervises it
 * to the end: identity, spec file, log file, live events (IPC), heartbeat, timeout, cancellation and exit evidence. The
 * process is the leader of its own process group, so stopping it stops everything it started, and only groups this runtime
 * spawned (proven by the execution id on their command line) are ever signalled. It is never an IDE or chat session.
 *
 * The supervisor is the single writer of the agent's lifecycle row. If the supervisor dies, the agent sees its IPC channel
 * disconnect and aborts (no unsupervised worker keeps editing a worktree); the row is later reconciled as LOST.
 */

export const AGENT_SPEC_SCHEMA = 'agentic.agent-spec/1';

export interface AgentSpec {
  schema: typeof AGENT_SPEC_SCHEMA;
  executionId: string;
  /** Stable identity of the agent (`<role>.<task>`): the same across retries of a task; executions differ. */
  agentId: string;
  role: 'coding-worker';
  project: string | null;
  batchId: string | null;
  taskId: string;
  claimEpoch: number | null;
  runId: string | null;
  provider: string;
  /** The model the runtime routed this execution to; null when the provider picks its own (reported as UNKNOWN unless it says). */
  model: { providerId: string; modelId: string } | null;
  worktree: string;
  target: { repositoryId: string; gitCommonDir: string; worktreeRoot: string } | null;
  /** The delegation request (contract + assessment + provider): the task contract and its bounded context. */
  request: Record<string, unknown>;
  /** The only tools the agent is given (enforced by the worker definition; recorded for evidence). */
  allowedTools: string[];
  artifactDir: string;
  modelTimeoutMs: number;
}

/** Messages an agent process sends to its supervisor over IPC. */
export type AgentMessage =
  | { type: 'started'; pid: number }
  | { type: 'heartbeat' }
  | { type: 'trace'; event: { type: string; data: Record<string, unknown>; ts?: string } }
  | { type: 'tool'; phase: 'started' | 'finished'; name: string; ok?: boolean }
  | { type: 'model_identity'; reported: string | null }
  | { type: 'result'; result: unknown };

export interface AgentExit {
  executionId: string;
  agentId: string;
  pid: number | null;
  status: AgentStatus;
  exitCode: number | null;
  signal: string | null;
  /** The agent's own result file (the runner's verdict summary); null when the process ended without one. */
  result: unknown;
  failure: string | null;
  logPath: string;
}

export interface SpawnAgentOptions {
  store: AgentStore;
  /** Aborting cancels the agent: SIGTERM to its group, SIGKILL after `killGraceMs`. */
  signal?: AbortSignal;
  /** Wall-clock bound for the whole process; exceeded = TIMED_OUT. */
  timeoutMs: number;
  killGraceMs?: number;
  onMessage?: (message: AgentMessage, row: AgentExecutionRow | undefined) => void;
  /** Node entry file (default: src/workers/agent/main.ts of this framework checkout). */
  entry?: string;
  env?: NodeJS.ProcessEnv;
}

export const newExecutionId = (taskId: string): string => `agx-${taskId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}-${randomUUID().slice(0, 8)}`;
export const agentIdFor = (role: string, taskId: string): string => `${role}.${taskId}`;

export function defaultAgentEntry(): string {
  const root = findProjectRoot(import.meta.dirname) ?? findProjectRoot(process.cwd());
  if (!root) throw new Error('cannot locate the framework checkout to start an agent process');
  return join(root, 'src', 'workers', 'agent', 'main.ts');
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True only if `pid` leads its own group AND its command line carries `executionId`: a process this runtime spawned. */
export function ownsProcess(pid: number, executionId: string): boolean {
  try {
    const out = execFileSync('ps', ['-o', 'pgid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }).trim();
    const [pgid, ...command] = out.split(/\s+/);
    return Number(pgid) === pid && command.join(' ').includes(executionId);
  } catch {
    return false;
  }
}

/** Signals the agent's whole process group, but only after proving it is ours. Returns whether a signal was sent. */
export function signalAgent(pid: number | null, executionId: string, sig: NodeJS.Signals): boolean {
  if (!pid || !isAlive(pid) || !ownsProcess(pid, executionId)) return false;
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Activity derived from the agent's own runtime events; undefined = no change. */
export function activityOf(type: string): AgentActivity | 'RUNTIME_CHECKS' | undefined {
  switch (type) {
    case 'permit_wait_started':
      return 'WAITING_PERMIT';
    case 'model_started':
      return 'INFERENCE';
    case 'verification_started':
      return 'VERIFYING';
    case 'model_finished':
    case 'verification_finished':
      return 'RUNTIME_CHECKS';
    case 'task_passed':
    case 'task_failed':
      return 'FINISHING';
    default:
      return undefined;
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Before a task's new execution starts: any earlier execution of the same task that is still alive belongs to an older claim
 * (a lease that expired while the machine slept, a supervisor that died) and must never write into the worktree again. It is
 * stopped (SUPERSEDED). Rows whose process is already gone on this host are marked LOST. Returns what was done.
 */
export async function reapStaleAgents(store: AgentStore, taskId: string, options: { keep?: string; killGraceMs?: number } = {}): Promise<{ superseded: string[]; lost: string[] }> {
  const out = { superseded: [] as string[], lost: [] as string[] };
  for (const row of store.list({ taskId, statuses: ['SPAWNING', 'RUNNING'] })) {
    if (row.executionId === options.keep || row.host !== hostname()) continue;
    if (row.pid && isAlive(row.pid) && ownsProcess(row.pid, row.executionId)) {
      // The fence first: once SUPERSEDED is recorded, nothing the dying process (or its supervisor) reports can change it.
      store.update(row.executionId, { status: 'SUPERSEDED', endedAt: store.now(), failure: 'superseded by a newer execution of the same task' }, { type: 'superseded', detail: { pid: row.pid } });
      signalAgent(row.pid, row.executionId, 'SIGTERM');
      const deadline = Date.now() + (options.killGraceMs ?? 5_000);
      while (isAlive(row.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      if (isAlive(row.pid)) signalAgent(row.pid, row.executionId, 'SIGKILL');
      out.superseded.push(row.executionId);
    } else {
      store.update(row.executionId, { status: 'LOST', endedAt: store.now(), failure: 'process is gone and its supervisor never recorded an exit' }, { type: 'lost', detail: { pid: row.pid } });
      out.lost.push(row.executionId);
    }
  }
  return out;
}

/** Marks every RUNNING/SPAWNING row on this host whose process and supervisor are both gone as LOST (restart recovery). */
export function reconcileAgents(store: AgentStore): string[] {
  const lost: string[] = [];
  for (const row of store.list({ statuses: ['SPAWNING', 'RUNNING'] })) {
    if (row.host !== hostname() || isAlive(row.pid)) continue;
    // A row whose supervisor is still alive is not ours to judge: it is about to record the exit itself.
    const supervisorPid = Number(row.supervisor.split(':').pop());
    if (supervisorPid && supervisorPid !== process.pid && isAlive(supervisorPid)) continue;
    store.update(row.executionId, { status: 'LOST', endedAt: store.now(), failure: 'process is gone and its supervisor never recorded an exit' }, { type: 'lost', detail: { pid: row.pid } });
    lost.push(row.executionId);
  }
  return lost;
}

/** Spawns one agent process for `spec` and supervises it until it has exited (or could not be confirmed stopped). */
export async function spawnAgent(spec: AgentSpec, options: SpawnAgentOptions): Promise<AgentExit> {
  const { store } = options;
  mkdirSync(spec.artifactDir, { recursive: true });
  const specPath = join(spec.artifactDir, 'agent-spec.json');
  const logPath = join(spec.artifactDir, 'agent.log');
  const resultPath = join(spec.artifactDir, 'agent-result.json');
  const specText = JSON.stringify(spec, null, 2);
  writeFileSync(specPath, specText);
  const specHash = createHash('sha256').update(specText).digest('hex');

  await reapStaleAgents(store, spec.taskId, { keep: spec.executionId });
  store.create({
    executionId: spec.executionId, agentId: spec.agentId, role: spec.role, project: spec.project, batchId: spec.batchId, taskId: spec.taskId,
    claimEpoch: spec.claimEpoch, runId: spec.runId, provider: spec.provider, assignedModel: spec.model ? `${spec.model.providerId}/${spec.model.modelId}` : null,
    worktree: spec.worktree, repositoryId: spec.target?.repositoryId ?? null, logPath, artifactDir: spec.artifactDir,
  });
  store.event(spec.executionId, 'spec_written', { path: specPath, sha256: specHash, allowedTools: spec.allowedTools });

  const finish = (exit: Omit<AgentExit, 'executionId' | 'agentId' | 'logPath'>): AgentExit => {
    store.update(spec.executionId, { status: exit.status, endedAt: store.now(), exitCode: exit.exitCode, signal: exit.signal, failure: exit.failure, activity: null, activityDetail: null, outcome: outcomeOf(exit.result) },
      { type: 'exited', detail: { status: exit.status, exitCode: exit.exitCode, signal: exit.signal, failure: exit.failure } });
    return { ...exit, executionId: spec.executionId, agentId: spec.agentId, logPath };
  };

  if (options.signal?.aborted) return finish({ pid: null, status: 'CANCELLED', exitCode: null, signal: null, result: null, failure: 'cancelled before spawn' });

  const log = openSync(logPath, 'a');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', options.entry ?? defaultAgentEntry(), specPath, `--execution=${spec.executionId}`], {
      cwd: spec.worktree,
      detached: true, // its own process group: a stop reaches every process it started, and nothing else
      stdio: ['ignore', log, log, 'ipc'],
      env: { ...(options.env ?? process.env), AGENTIC_AGENT_EXECUTION_ID: spec.executionId },
    });
  } catch (err) {
    closeSync(log);
    return finish({ pid: null, status: 'SPAWN_FAILED', exitCode: null, signal: null, result: null, failure: (err as Error).message });
  }
  closeSync(log);
  const pid = child.pid ?? null;

  return await new Promise<AgentExit>((resolve) => {
    let ending: AgentStatus | null = null;
    let reason: string | null = null;
    let lastHeartbeatWrite = 0;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (status: AgentStatus, why: string) => {
      if (ending) return;
      ending = status;
      reason = why;
      store.event(spec.executionId, 'stop_requested', { status, reason: why });
      signalAgent(pid, spec.executionId, 'SIGTERM');
      killTimer = setTimeout(() => signalAgent(pid, spec.executionId, 'SIGKILL'), options.killGraceMs ?? 10_000);
    };
    const timer = setTimeout(() => stop('TIMED_OUT', `agent exceeded its ${options.timeoutMs}ms budget`), options.timeoutMs);
    const onAbort = () => stop('CANCELLED', String((options.signal?.reason as Error | undefined)?.message ?? options.signal?.reason ?? 'cancelled'));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.once('spawn', () => {
      store.update(spec.executionId, { status: 'RUNNING', pid, startedAt: store.now(), heartbeatAt: store.now(), activity: 'STARTING' }, { type: 'spawned', detail: { pid } });
    });
    child.once('error', (err) => {
      if (!pid) {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(finish({ pid: null, status: 'SPAWN_FAILED', exitCode: null, signal: null, result: null, failure: err.message }));
      }
    });
    child.on('message', (raw) => {
      const message = raw as AgentMessage;
      let row: AgentExecutionRow | undefined;
      try {
        row = applyMessage(store, spec.executionId, message, () => {
          const now = Date.now();
          if (now - lastHeartbeatWrite < 2_000) return false;
          lastHeartbeatWrite = now;
          return true;
        });
      } catch {
        /* observability must never break supervision */
      }
      try {
        options.onMessage?.(message, row);
      } catch {
        /* same */
      }
    });
    child.once('exit', (code, sig) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      let result: unknown = null;
      try {
        if (existsSync(resultPath)) result = JSON.parse(readFileSync(resultPath, 'utf8'));
      } catch {
        result = null;
      }
      const status: AgentStatus = ending ?? (code === 0 && result ? 'COMPLETED' : 'FAILED');
      const failure = ending ? reason : code === 0 && result ? null : `agent process exited with ${sig ? `signal ${sig}` : `code ${code}`}${result ? '' : ' and wrote no result'}`;
      resolve(finish({ pid, status, exitCode: code, signal: sig, result: status === 'COMPLETED' ? result : null, failure }));
    });
  });
}

function outcomeOf(result: unknown): string | null {
  const s = (result as { status?: unknown } | null)?.status;
  return typeof s === 'string' ? s : null;
}

/** Applies one IPC message to the lifecycle row and the event log. Returns the updated row. */
export function applyMessage(store: AgentStore, executionId: string, message: AgentMessage, heartbeatDue: () => boolean = () => true): AgentExecutionRow | undefined {
  switch (message.type) {
    case 'heartbeat':
      return heartbeatDue() ? store.update(executionId, { heartbeatAt: store.now() }) : undefined;
    case 'started':
      return store.update(executionId, { heartbeatAt: store.now() }, { type: 'agent_started', detail: { pid: message.pid } });
    case 'model_identity':
      return store.update(executionId, { reportedModel: message.reported }, { type: 'model_identity', detail: { reported: message.reported } });
    case 'tool': {
      if (message.phase === 'started') return store.update(executionId, { activity: 'TOOL', activityDetail: message.name, heartbeatAt: store.now() }, { type: 'tool_started', detail: { name: message.name } });
      const row = store.get(executionId);
      return store.update(executionId, { activity: 'INFERENCE', activityDetail: null, toolCalls: (row?.toolCalls ?? 0) + 1, heartbeatAt: store.now() }, { type: 'tool_finished', detail: { name: message.name, ok: message.ok ?? null } });
    }
    case 'result':
      return store.update(executionId, { activity: 'FINISHING' }, { type: 'result_reported', detail: { status: outcomeOf(message.result) } });
    case 'trace': {
      const { type, data } = message.event;
      const row = store.get(executionId);
      if (!row || TERMINAL_AGENT_STATUSES.includes(row.status)) return row;
      const activity = activityOf(type);
      const patch: Partial<AgentExecutionRow> = { heartbeatAt: store.now() };
      if (activity) {
        patch.activity = activity === 'RUNTIME_CHECKS' ? null : activity;
        patch.activityDetail = activity === 'RUNTIME_CHECKS' ? 'runtime checks' : type === 'verification_started' ? String((data.command as string[] | undefined)?.join(' ') ?? '') : type === 'model_started' ? String(data.providerModel ?? data.model ?? '') : null;
      }
      if (type === 'model_started') patch.permitWaitMs = row.permitWaitMs + num(data.capacityWaitMs);
      if (type === 'model_finished') {
        patch.inferenceMs = row.inferenceMs + num(data.durationMs);
        if (typeof data.inputTokens === 'number') patch.inputTokens = (row.inputTokens ?? 0) + data.inputTokens;
        if (typeof data.outputTokens === 'number') patch.outputTokens = (row.outputTokens ?? 0) + data.outputTokens;
      }
      // Diagnostic model text and per-file hashes stay in the agent's trace.jsonl; the event log keeps lifecycle evidence only.
      const keep = !['worker_status', 'file_read', 'file_hash', 'tool_call_started', 'tool_call_finished'].includes(type);
      return store.update(executionId, patch, keep ? { type: `trace.${type}`, detail: summarize(data) } : undefined);
    }
  }
}

function summarize(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'telemetry' || k === 'text') continue;
    out[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  }
  return out;
}

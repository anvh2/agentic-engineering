import { randomUUID } from 'node:crypto';
import type { DelegationRequest } from '../../runtime/execution/delegation.ts';

/**
 * Starts `coding-task-workflow` on a running Mastra server so the run is recorded and visible in Studio
 * (http://<server>/workflows/coding-task-workflow/graph/<runId>). create-run + start (returns immediately) + poll:
 * a long Qwen run must not depend on one open HTTP request. This is the ONLY place the Lead talks to the workflow.
 */
export interface WorkflowRunResult {
  runId: string;
  studioUrl: string;
  status: string | undefined;
  /** The workflow's `codingTaskResultSchema` output (status, diff, attempts, artifactDir, ...). Undefined if the run itself failed. */
  result: Record<string, any> | undefined;
  error?: string;
}

export interface RunWorkflowOptions {
  server?: string;
  pollMs?: number;
  /** Consecutive failed polls before giving up (server down/restarted). Default 24 (~2 min at 5 s). */
  maxPollFailures?: number;
  timeoutMs?: number;
  onStart?: (info: { runId: string; studioUrl: string }) => void;
  onProgress?: (line: string) => void;
  /** Stops polling (the workflow run itself is NOT cancelled; it is identified by its run id for later reconciliation). */
  signal?: AbortSignal;
}

export async function runCodingTaskWorkflow(request: DelegationRequest, repository: string, options: RunWorkflowOptions = {}): Promise<WorkflowRunResult> {
  const server = (options.server ?? process.env.MASTRA_URL ?? 'http://localhost:4111').replace(/\/$/, '');
  const runId = randomUUID();
  const studioUrl = `${server}/workflows/coding-task-workflow/graph/${runId}`;
  const api = `${server}/api/workflows/coding-task-workflow`;
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${api}${path}`, { ...init, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json() as Promise<Record<string, any>>;
  };

  try {
    await call(`/create-run?runId=${runId}`, { method: 'POST', body: '{}' });
    await call(`/start?runId=${runId}`, { method: 'POST', body: JSON.stringify({ inputData: { ...request, repository } }) });
  } catch (err) {
    return { runId, studioUrl, status: undefined, result: undefined, error: `Cannot start the workflow on ${server} (${(err as Error).message}). Is the server running? Start it with: npm run dev` };
  }
  options.onStart?.({ runId, studioUrl });

  return awaitRun(call, runId, studioUrl, options);
}

type Call = (path: string, init?: RequestInit) => Promise<Record<string, any>>;

async function awaitRun(call: Call, runId: string, studioUrl: string, options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  let body: { status?: string; result?: Record<string, any>; error?: unknown; steps?: Record<string, { status?: string }> } = {};
  let lastLine = '';
  let pollFailures = 0;
  const maxPollFailures = options.maxPollFailures ?? 24;
  const deadline = Date.now() + (options.timeoutMs ?? 2 * 60 * 60 * 1000);
  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { runId, studioUrl, status: undefined, result: undefined, error: 'polling aborted' };
    await new Promise((r) => setTimeout(r, options.pollMs ?? 5_000));
    try {
      body = (await call(`/runs/${runId}`)) as typeof body;
      pollFailures = 0;
    } catch (err) {
      pollFailures += 1;
      options.onProgress?.(`poll failed (${(err as Error).message}); ${pollFailures}/${maxPollFailures}`);
      if (pollFailures >= maxPollFailures) {
        // A restarted/killed Mastra server loses the in-flight run: report infrastructure failure instead of hanging for hours.
        return { runId, studioUrl, status: undefined, result: undefined, error: `Mastra server unreachable for ${pollFailures} consecutive polls; the in-flight run ${runId} is presumed lost (server restarted?)` };
      }
      continue;
    }
    const active = Object.entries(body.steps ?? {}).filter(([k, v]) => k !== 'input' && v?.status === 'running').map(([k]) => k).join(',');
    const line = `[${body.status}] ${active}`;
    if (line !== lastLine) options.onProgress?.(line);
    lastLine = line;
    if (body.status && !['running', 'pending', 'waiting'].includes(body.status)) break;
  }
  if (body.status !== 'success' || !body.result) {
    return { runId, studioUrl, status: body.status, result: undefined, error: `workflow run did not complete successfully: status=${body.status} ${JSON.stringify(body.error ?? '').slice(0, 600)}` };
  }
  return { runId, studioUrl, status: body.status, result: body.result };
}

/** Attaches to a run that was started earlier (crash recovery): waits for it to reach a terminal state. */
export async function attachToCodingTaskRun(runId: string, options: RunWorkflowOptions = {}): Promise<WorkflowRunResult> {
  const server = (options.server ?? process.env.MASTRA_URL ?? 'http://localhost:4111').replace(/\/$/, '');
  const api = `${server}/api/workflows/coding-task-workflow`;
  const call: Call = async (path, init) => {
    const res = await fetch(`${api}${path}`, { ...init, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json() as Promise<Record<string, any>>;
  };
  return awaitRun(call, runId, `${server}/workflows/coding-task-workflow/graph/${runId}`, options);
}

/**
 * Cancels a run (Mastra marks it `canceled` in storage and aborts it if this server process is executing it). Used for
 * runs the scheduler has given up on, including runs orphaned by a server restart, which otherwise stay "running" forever.
 */
export async function cancelCodingTaskRun(runId: string, options: { server?: string } = {}): Promise<void> {
  const server = (options.server ?? process.env.MASTRA_URL ?? 'http://localhost:4111').replace(/\/$/, '');
  const res = await fetch(`${server}/api/workflows/coding-task-workflow/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`POST cancel ${runId} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export interface ConfirmedCancel {
  run: 'terminal' | 'still_active' | 'unreachable';
  runStatus?: string;
  detail?: string;
}

/**
 * Cancels a run and verifies the server's view of it. The cancel request is not trusted to have worked: the run's status
 * is polled until it is terminal (Mastra marks it `canceled` immediately and aborts the step if this server is executing
 * it), a run the server no longer knows (restart) counts as terminal, and a run still `running` after `graceMs` is
 * reported as still active. A failed cancel request is reported, not thrown, so the caller can record what is unknown.
 */
export async function cancelCodingTaskRunConfirmed(runId: string, options: { server?: string; graceMs?: number; pollMs?: number } = {}): Promise<ConfirmedCancel> {
  const server = (options.server ?? process.env.MASTRA_URL ?? 'http://localhost:4111').replace(/\/$/, '');
  const base = `${server}/api/workflows/coding-task-workflow/runs/${encodeURIComponent(runId)}`;
  let requestError: string | undefined;
  try {
    await cancelCodingTaskRun(runId, { server });
  } catch (err) {
    requestError = (err as Error).message; // the run may already be terminal (cancel of a finished run is refused): the probe below decides
  }
  const deadline = Date.now() + (options.graceMs ?? 15_000);
  const pollMs = options.pollMs ?? 500;
  let lastStatus: string | undefined;
  let reached = false;
  for (;;) {
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) return { run: 'terminal', runStatus: 'not_found', detail: 'the server does not know this run (restarted or evicted): nothing is executing under it' };
      if (res.ok) {
        reached = true;
        lastStatus = ((await res.json()) as { status?: string }).status;
        if (lastStatus && !['running', 'pending', 'waiting'].includes(lastStatus)) return { run: 'terminal', runStatus: lastStatus, ...(requestError ? { detail: `cancel request refused (${requestError}) but the run is terminal` } : {}) };
      }
    } catch {
      /* unreachable this poll; retried until the deadline */
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!reached) return { run: 'unreachable', detail: `Mastra server at ${server} did not answer${requestError ? ` (${requestError})` : ''}; the run may still be executing` };
  return { run: 'still_active', runStatus: lastStatus, detail: `run still ${lastStatus} ${options.graceMs ?? 15_000}ms after the cancel request${requestError ? ` (${requestError})` : ''}` };
}

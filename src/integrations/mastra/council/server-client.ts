import { randomUUID } from 'node:crypto';
import type { CouncilWorkflowInput, CouncilWorkflowResult } from './council-workflow.ts';

/**
 * Starts engineering-council-workflow on a RUNNING Mastra server, so the run and its agent/tool spans are recorded and visible in
 * Studio. create-run, start (returns at once), then poll: a live council takes minutes and must not hold one HTTP request open.
 * Same protocol as client.ts uses for the coding workflow; kept separate so that file stays untouched.
 */
export interface CouncilServerRun {
  runId: string;
  studioUrl: string;
  status: string | undefined;
  result: CouncilWorkflowResult | undefined;
  error?: string;
  /** True when the server could not be reached at all (nothing started), as opposed to a run that failed. */
  unreachable?: boolean;
}

export interface CouncilServerOptions {
  server?: string;
  pollMs?: number;
  timeoutMs?: number;
  /** Consecutive failed polls before the run is presumed lost (server restarted). The MEETING survives; resume it with the same id. */
  maxPollFailures?: number;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}

export async function runCouncilOnServer(input: CouncilWorkflowInput, options: CouncilServerOptions = {}): Promise<CouncilServerRun> {
  const server = (options.server ?? process.env.MASTRA_URL ?? 'http://localhost:4111').replace(/\/$/, '');
  const runId = randomUUID();
  const studioUrl = `${server}/workflows/engineering-council-workflow/graph/${runId}`;
  const api = `${server}/api/workflows/engineering-council-workflow`;
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${api}${path}`, { ...init, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json() as Promise<Record<string, any>>;
  };
  try {
    await call(`/create-run?runId=${runId}`, { method: 'POST', body: '{}' });
    await call(`/start?runId=${runId}`, { method: 'POST', body: JSON.stringify({ inputData: input }) });
  } catch (err) {
    return { runId, studioUrl, status: undefined, result: undefined, unreachable: true, error: `Cannot start the council on ${server} (${(err as Error).message}). Is the Mastra server running? Start it with: npm run dev` };
  }

  let body: { status?: string; result?: CouncilWorkflowResult; error?: unknown; steps?: Record<string, { status?: string }> } = {};
  let last = '';
  let failures = 0;
  const deadline = Date.now() + (options.timeoutMs ?? 45 * 60_000);
  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { runId, studioUrl, status: undefined, result: undefined, error: 'polling aborted; the run itself was not cancelled' };
    await new Promise((r) => setTimeout(r, options.pollMs ?? 2_000));
    try {
      body = (await call(`/runs/${runId}`)) as typeof body;
      failures = 0;
    } catch (err) {
      failures += 1;
      options.onProgress?.(`poll failed (${(err as Error).message}); ${failures}/${options.maxPollFailures ?? 24}`);
      if (failures >= (options.maxPollFailures ?? 24)) return { runId, studioUrl, status: undefined, result: undefined, error: `Mastra server unreachable for ${failures} polls; run ${runId} is presumed lost. The meeting is durable: re-run with the same --meeting-id to resume it.` };
      continue;
    }
    const active = Object.entries(body.steps ?? {}).filter(([k, v]) => k !== 'input' && v?.status === 'running').map(([k]) => k).join(',');
    const line = `[${body.status}] ${active}`;
    if (line !== last) options.onProgress?.(line);
    last = line;
    if (body.status && !['running', 'pending', 'waiting'].includes(body.status)) break;
  }
  if (body.status !== 'success' || !body.result) return { runId, studioUrl, status: body.status, result: undefined, error: `council run did not complete: status=${body.status} ${JSON.stringify(body.error ?? '').slice(0, 600)}` };
  return { runId, studioUrl, status: body.status, result: body.result };
}

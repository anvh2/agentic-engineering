import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A request-filtering guard between the Gemini CLI and the Gemini API, for the free-tier smoke.
 *
 * Why it exists: `--model` only governs the main chat. The CLI has a dozen internal helper aliases (classifier, loop detection and its
 * double check, web search/fetch, summarizers, edit fixer, ...) that name OTHER models, one of them `gemini-3-pro-preview`, and for
 * its own `flash-lite` a silent fallback chain (flash, then 2.5 Pro). None is reachable in a headless, 8-turn, file-tools-only run, but
 * "not reachable" is an argument about code, not a guarantee. This guard makes it a guarantee at the only place that matters, the wire:
 *
 *  - the CLI is pointed at http://127.0.0.1:<port> (GOOGLE_GEMINI_BASE_URL, accepted by the CLI for loopback);
 *  - ONLY `POST /v1beta/models/<pinned model>:{streamGenerateContent|generateContent|countTokens}` is forwarded to the real API;
 *    any other model, alias, path or method is answered 403 locally and never leaves the machine (fail closed, never substituted);
 *  - at most `maxForwarded` requests are forwarded, whatever the CLI wants to retry;
 *  - the first upstream 4xx (404 model not available to the project, 429 quota, 401/403 key or permission) TRIPS the guard: every later
 *    request is answered locally with a non-retryable 403 that names the original status, so a quota or access failure ends the
 *    experiment at once (the CLI retries a 429 for minutes, and would otherwise keep the run alive until its deadline).
 *
 * It records, per request, only: method, the path's model id, a decision and the status. It never stores or logs headers (the API key
 * travels in one), bodies (the task) or response content. It listens on loopback only.
 */

export type GuardDecision = 'forwarded' | 'blocked-model' | 'blocked-route' | 'blocked-cap' | 'blocked-tripped' | 'blocked-size';

export interface GuardEntry {
  n: number;
  method: string;
  /** The model id taken from the path, or null when the path is not a model route. */
  model: string | null;
  action: string | null;
  decision: GuardDecision;
  /** Status returned by the real API (forwarded requests only). */
  upstreamStatus?: number;
  /** Status the CLI was given. */
  status: number;
}

export interface GuardReport {
  pinnedModel: string;
  maxForwarded: number;
  entries: GuardEntry[];
  forwarded: number;
  blocked: number;
  /** Distinct model ids the CLI asked for, whether or not they were allowed. */
  modelsRequested: string[];
  /** Set by the first upstream 4xx. After this nothing is forwarded. */
  tripped?: { status: number; atRequest: number; model: string };
}

export interface ModelGuard {
  url: string;
  report(): GuardReport;
  stop(): Promise<void>;
}

const ROUTE = /^\/v1beta\/models\/([^/:?]+):(streamGenerateContent|generateContent|countTokens)(\?[^#]*)?$/;
const MAX_BODY_BYTES = 4_000_000;
const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'accept-encoding', 'upgrade', 'proxy-authorization', 'te', 'trailer']);

const json = (res: ServerResponse, status: number, message: string) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { code: status, message, status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'PERMISSION_DENIED' } }));
};

export async function startModelGuard(options: { pinnedModel: string; upstream: string; maxForwarded: number; port?: number }): Promise<ModelGuard> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.pinnedModel)) throw new Error(`guard: "${options.pinnedModel}" is not a plain model id`);
  const upstream = options.upstream.replace(/\/$/, '');
  const entries: GuardEntry[] = [];
  const inflight = new Set<AbortController>();
  const models = new Set<string>();
  let forwarded = 0;
  let tripped: GuardReport['tripped'];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const n = entries.length + 1;
    const method = req.method ?? '';
    const m = ROUTE.exec(req.url ?? '');
    const model = m ? decodeURIComponent(m[1]) : null;
    const action = m ? m[2] : null;
    if (model) models.add(model);
    const done = (decision: GuardDecision, status: number, upstreamStatus?: number) => entries.push({ n, method, model, action, decision, status, ...(upstreamStatus !== undefined ? { upstreamStatus } : {}) });

    if (!m || method !== 'POST') {
      done('blocked-route', 403);
      return json(res, 403, 'blocked by the agentic model guard: only generateContent routes of the pinned model are allowed');
    }
    if (model !== options.pinnedModel) {
      done('blocked-model', 403);
      return json(res, 403, `blocked by the agentic model guard: model "${model}" is not the pinned model`);
    }
    if (tripped) {
      done('blocked-tripped', 403);
      return json(res, 403, `the agentic model guard has stopped this run: the API refused an earlier request with HTTP ${tripped.status}`);
    }
    if (forwarded >= options.maxForwarded) {
      done('blocked-cap', 429);
      return json(res, 429, 'blocked by the agentic model guard: the request ceiling for this run is reached');
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        done('blocked-size', 413);
        return json(res, 413, 'blocked by the agentic model guard: request too large');
      }
      chunks.push(c as Buffer);
    }
    forwarded += 1;
    const ctl = new AbortController();
    inflight.add(ctl);
    res.on('close', () => ctl.abort()); // the CLI went away (cancel, deadline): stop the upstream request too
    try {
      const headers: Record<string, string> = { 'accept-encoding': 'identity' };
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === 'string') headers[k] = v;
      const up = await fetch(`${upstream}${req.url}`, { method: 'POST', headers, body: Buffer.concat(chunks), signal: ctl.signal });
      if (up.status >= 400 && up.status < 500) tripped ??= { status: up.status, atRequest: n, model };
      done('forwarded', up.status, up.status);
      res.statusCode = up.status;
      for (const [k, v] of up.headers) if (!HOP.has(k) && k !== 'content-encoding') res.setHeader(k, v);
      if (!up.body) return res.end();
      for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      res.end();
    } catch (err) {
      if (!entries.some((e) => e.n === n)) done('forwarded', 502, undefined);
      if (!res.headersSent) json(res, 502, 'the agentic model guard could not reach the API');
      else res.destroy();
      void err;
    } finally {
      inflight.delete(ctl);
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, 'guard error');
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    report: () => ({
      pinnedModel: options.pinnedModel,
      maxForwarded: options.maxForwarded,
      entries: entries.map((e) => ({ ...e })),
      forwarded,
      blocked: entries.filter((e) => e.decision !== 'forwarded').length,
      modelsRequested: [...models].sort(),
      ...(tripped ? { tripped: { ...tripped } } : {}),
    }),
    async stop() {
      for (const c of inflight) c.abort();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** The smoke is clean only if the CLI asked for nothing but the pinned model, nothing was refused, and the API never refused us. */
export function guardVerdict(report: GuardReport): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (report.modelsRequested.some((m) => m !== report.pinnedModel)) reasons.push(`the CLI asked for other models: ${report.modelsRequested.filter((m) => m !== report.pinnedModel).join(', ')}`);
  if (report.blocked > 0) reasons.push(`${report.blocked} request(s) were blocked by the guard`);
  if (report.tripped) reasons.push(`the API refused with ${report.tripped.status} at request ${report.tripped.atRequest}: stop and do not rerun`);
  if (report.forwarded > report.maxForwarded) reasons.push('more requests were forwarded than the ceiling allows');
  if (report.forwarded === 0) reasons.push('no request reached the API');
  return { ok: reasons.length === 0, reasons };
}

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { guardVerdict, startModelGuard, type ModelGuard } from '../provider-smoke/gemini-model-guard.ts';

/** The guard against a LOCAL stand-in for the Gemini API. Nothing here reaches Google. */

const PIN = 'gemini-3.5-flash-lite';
const KEY = 'DUMMY-KEY-MUST-NOT-APPEAR-ANYWHERE';
const BODY_MARKER = 'PRIVATE-TASK-TEXT-MUST-NOT-APPEAR-ANYWHERE';

interface Seen {
  method: string;
  url: string;
  key: string | undefined;
  body: string;
}

async function upstream(respond: (n: number, req: IncomingMessage) => { status: number; body: string } = () => ({ status: 200, body: 'data: {"ok":true}\n\n' })) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', key: req.headers['x-goog-api-key'] as string | undefined, body: Buffer.concat(chunks).toString('utf8') });
      const r = respond(seen.length, req);
      res.statusCode = r.status;
      res.setHeader('content-type', 'text/event-stream');
      res.end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

const post = (guard: ModelGuard, path: string, method = 'POST') =>
  fetch(guard.url + path, { method, headers: { 'x-goog-api-key': KEY, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ contents: [{ parts: [{ text: BODY_MARKER }] }] }) : undefined });

async function withGuard(test: (g: ModelGuard, up: Awaited<ReturnType<typeof upstream>>) => Promise<void>, opts: { maxForwarded?: number; respond?: Parameters<typeof upstream>[0] } = {}) {
  const up = await upstream(opts.respond);
  const guard = await startModelGuard({ pinnedModel: PIN, upstream: up.url, maxForwarded: opts.maxForwarded ?? 12 });
  try {
    await test(guard, up);
  } finally {
    await guard.stop();
    await up.close();
  }
}

describe('model guard: exact outbound model', () => {
  it('forwards the pinned model on every generate/count route, with the key header intact, and records it', async () => {
    await withGuard(async (g, up) => {
      for (const action of ['streamGenerateContent?alt=sse', 'generateContent', 'countTokens']) {
        const r = await post(g, `/v1beta/models/${PIN}:${action}`);
        assert.equal(r.status, 200, action);
        await r.text();
      }
      assert.equal(up.seen.length, 3);
      assert.ok(up.seen.every((s) => s.key === KEY), 'the key reaches the API');
      assert.ok(up.seen.every((s) => s.url.startsWith(`/v1beta/models/${PIN}:`)));
      const rep = g.report();
      assert.deepEqual([rep.forwarded, rep.blocked, rep.modelsRequested], [3, 0, [PIN]]);
      assert.deepEqual(guardVerdict(rep), { ok: true, reasons: [] });
    });
  });

  it('blocks every other model locally, never forwards it and never substitutes the pinned one', async () => {
    await withGuard(async (g, up) => {
      for (const model of ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'flash', 'flash-lite', 'auto', 'gemini-3.5-flash-lite-preview', 'GEMINI-3.5-FLASH-LITE', `${PIN}x`]) {
        const r = await post(g, `/v1beta/models/${model}:streamGenerateContent?alt=sse`);
        assert.equal(r.status, 403, model);
        assert.match(await r.text(), /not the pinned model/);
      }
      assert.equal(up.seen.length, 0, 'not one request left the machine');
      const rep = g.report();
      assert.equal(rep.forwarded, 0);
      assert.equal(rep.blocked, 14);
      assert.equal(guardVerdict(rep).ok, false);
      assert.ok(guardVerdict(rep).reasons.some((r) => /other models/.test(r)));
    });
  });

  it('blocks anything that is not a generate/count route of a model: other paths, other actions, other API versions, other methods', async () => {
    await withGuard(async (g, up) => {
      const paths = ['/v1beta/models', '/v1beta/models/' + PIN, `/v1beta/models/${PIN}`, `/v1beta/models/${PIN}:embedContent`, `/v1beta/models/${PIN}:streamGenerateContent/extra`, `/v1/models/${PIN}:generateContent`, `/v1beta/tunedModels/${PIN}:generateContent`, `/upload/v1beta/files`, '/', `//v1beta/models/${PIN}:generateContent`, `/v1beta/models/%2e%2e/${PIN}:generateContent`];
      for (const p of paths) assert.equal((await post(g, p)).status, 403, p);
      assert.equal((await post(g, `/v1beta/models/${PIN}:generateContent`, 'GET')).status, 403, 'GET');
      assert.equal((await post(g, `/v1beta/models/${PIN}:generateContent`, 'DELETE')).status, 403, 'DELETE');
      assert.equal(up.seen.length, 0);
    });
  });

  it('a percent-encoded different model does not slip past the exact comparison', async () => {
    await withGuard(async (g, up) => {
      const r = await post(g, `/v1beta/models/gemini-3.5-flash-lit%65:generateContent`); // decodes to the pinned id: allowed, and the upstream URL is unchanged
      assert.equal(r.status, 200);
      const evil = await post(g, `/v1beta/models/gemini-3-pro-preview%3AgenerateContent:generateContent`);
      assert.equal(evil.status, 403);
      assert.equal(up.seen.length, 1);
      assert.equal(g.report().entries[0].model, PIN);
    });
  });
});

describe('model guard: ceilings and stop conditions', () => {
  it('forwards at most maxForwarded requests, whatever the CLI wants to retry', async () => {
    await withGuard(async (g, up) => {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await post(g, `/v1beta/models/${PIN}:generateContent`)).status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
      assert.equal(up.seen.length, 3);
      assert.equal(g.report().entries.filter((e) => e.decision === 'blocked-cap').length, 2);
    }, { maxForwarded: 3 });
  });

  it('the first upstream 4xx (404 model unavailable, 429 quota, 403/401 key) trips it: nothing more is forwarded and later requests get a non-retryable 403 naming the original status', async () => {
    for (const status of [404, 429, 403, 401, 400]) {
      await withGuard(async (g, up) => {
        assert.equal((await post(g, `/v1beta/models/${PIN}:streamGenerateContent`)).status, status);
        for (let i = 0; i < 3; i++) {
          const later = await post(g, `/v1beta/models/${PIN}:streamGenerateContent`);
          assert.equal(later.status, 403, 'answered locally, and not a retryable status');
          assert.match(await later.text(), new RegExp(`HTTP ${status}`));
        }
        assert.equal(up.seen.length, 1, `HTTP ${status}: exactly one request reached the API`);
        const rep = g.report();
        assert.deepEqual(rep.tripped && { status: rep.tripped.status, atRequest: rep.tripped.atRequest }, { status, atRequest: 1 });
        const v = guardVerdict(rep);
        assert.equal(v.ok, false);
        assert.ok(v.reasons.some((r) => /stop and do not rerun/.test(r)));
      }, { respond: () => ({ status, body: '{"error":{"message":"refused"}}' }) });
    }
  });

  it('the CLI\'s own fallback chain is blocked on the wire: after a 404 for the pinned model, a request for flash or Pro never reaches the API', async () => {
    await withGuard(async (g, up) => {
      assert.equal((await post(g, `/v1beta/models/${PIN}:streamGenerateContent?alt=sse`)).status, 404);
      for (const fallback of ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview']) assert.equal((await post(g, `/v1beta/models/${fallback}:streamGenerateContent?alt=sse`)).status, 403, fallback);
      assert.equal((await post(g, `/v1beta/models/${PIN}:streamGenerateContent?alt=sse`)).status, 403, 'and not even the pinned model again');
      assert.equal(up.seen.length, 1, 'exactly one request ever reached the API');
      const rep = g.report();
      assert.deepEqual(rep.entries.map((e) => e.decision), ['forwarded', 'blocked-model', 'blocked-model', 'blocked-model', 'blocked-model', 'blocked-tripped']);
      const v = guardVerdict(rep);
      assert.equal(v.ok, false);
      assert.match(v.reasons.join(' '), /other models: gemini-2\.5-flash, gemini-2\.5-pro, gemini-3-flash-preview, gemini-3\.8-flash/);
      assert.match(v.reasons.join(' '), /refused with 404/);
    }, { respond: () => ({ status: 404, body: '{"error":{"code":404,"message":"This model is no longer available to new users."}}' }) });
  });

  it('a transient 5xx does not trip it (the CLI may retry, within the ceiling)', async () => {
    await withGuard(async (g, up) => {
      assert.equal((await post(g, `/v1beta/models/${PIN}:generateContent`)).status, 503);
      assert.equal((await post(g, `/v1beta/models/${PIN}:generateContent`)).status, 200);
      assert.equal(up.seen.length, 2);
      assert.equal(g.report().tripped, undefined);
    }, { respond: (n) => (n === 1 ? { status: 503, body: '{}' } : { status: 200, body: 'ok' }) });
  });

  it('a verdict needs at least one forwarded request and flags an over-limit count', () => {
    const empty = { pinnedModel: PIN, maxForwarded: 12, entries: [], forwarded: 0, blocked: 0, modelsRequested: [] };
    assert.equal(guardVerdict(empty).ok, false);
    assert.equal(guardVerdict({ ...empty, forwarded: 2, modelsRequested: [PIN] }).ok, true);
    assert.equal(guardVerdict({ ...empty, forwarded: 13, modelsRequested: [PIN] }).ok, false);
  });
});

describe('model guard: privacy and cleanup', () => {
  it('the report never contains the key, the request body, a header or any response content', async () => {
    await withGuard(async (g) => {
      await (await post(g, `/v1beta/models/${PIN}:generateContent`)).text();
      await post(g, `/v1beta/models/gemini-3-pro-preview:generateContent`);
      const text = JSON.stringify(g.report());
      assert.ok(!text.includes(KEY) && !text.includes(BODY_MARKER) && !/x-goog|authorization|content-type|"ok"/i.test(text), text);
      assert.deepEqual(Object.keys(g.report().entries[0]).sort(), ['action', 'decision', 'method', 'model', 'n', 'status', 'upstreamStatus']);
    });
  });

  it('it listens on loopback only and stop() releases the port and aborts an in-flight upstream request', async () => {
    let upstreamClosed = false;
    const hang = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: start\n\n');
      req.on('close', () => (upstreamClosed = true));
      res.on('close', () => (upstreamClosed = true));
    });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const guard = await startModelGuard({ pinnedModel: PIN, upstream: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`, maxForwarded: 4 });
    assert.match(guard.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const inflight = post(guard, `/v1beta/models/${PIN}:streamGenerateContent`).then((r) => r.text()).catch(() => 'aborted');
    await new Promise((r) => setTimeout(r, 300));
    await guard.stop();
    await inflight;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(upstreamClosed, true, 'the upstream request was cancelled with the guard');
    await assert.rejects(fetch(guard.url + '/x'), 'the port is released');
    hang.closeAllConnections();
    await new Promise<void>((r) => hang.close(() => r()));
  });

  it('a client that disconnects (cancel, deadline) aborts the upstream request', async () => {
    let upstreamAborted = false;
    const hang = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: start\n\n');
      res.on('close', () => (upstreamAborted = true));
    });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const guard = await startModelGuard({ pinnedModel: PIN, upstream: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`, maxForwarded: 4 });
    try {
      const ctl = new AbortController();
      const req = fetch(guard.url + `/v1beta/models/${PIN}:streamGenerateContent`, { method: 'POST', body: '{}', signal: ctl.signal }).then((r) => r.text()).catch(() => 'aborted');
      await new Promise((r) => setTimeout(r, 300));
      ctl.abort();
      await req;
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(upstreamAborted, true);
    } finally {
      await guard.stop();
      hang.closeAllConnections();
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });

  it('refuses to start for a pinned id that is not a plain model name', async () => {
    for (const bad of ['', 'a b', '../x', 'x:y', '-x']) await assert.rejects(startModelGuard({ pinnedModel: bad, upstream: 'http://127.0.0.1:1', maxForwarded: 1 }), /plain model id/, bad);
  });
});

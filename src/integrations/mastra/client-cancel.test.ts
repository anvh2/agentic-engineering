import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { cancelCodingTaskRunConfirmed } from './client.ts';

/** In-process fake of the two Mastra endpoints cancellation uses: POST .../cancel and GET .../runs/:id. */
async function fakeMastra(handler: (method: string, path: string) => { status: number; body?: unknown }) {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const r = handler(req.method ?? 'GET', req.url ?? '');
    res.statusCode = r.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(r.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('cancelCodingTaskRunConfirmed', () => {
  it('requests the cancel, then polls until the run is terminal', async () => {
    let polls = 0;
    const m = await fakeMastra((method) => (method === 'POST' ? { status: 200 } : { status: 200, body: { status: ++polls < 3 ? 'running' : 'canceled' } }));
    const r = await cancelCodingTaskRunConfirmed('r1', { server: m.url, pollMs: 5, graceMs: 2_000 });
    await m.close();
    assert.equal(r.run, 'terminal');
    assert.equal(r.runStatus, 'canceled');
    assert.ok(m.calls[0].startsWith('POST') && m.calls[0].endsWith('/runs/r1/cancel'));
    assert.equal(polls, 3, 'it did not trust the cancel request: it waited for the status');
  });

  it('a run that stays running after the grace period is reported as still active', async () => {
    const m = await fakeMastra((method) => (method === 'POST' ? { status: 200 } : { status: 200, body: { status: 'running' } }));
    const r = await cancelCodingTaskRunConfirmed('r1', { server: m.url, pollMs: 5, graceMs: 60 });
    await m.close();
    assert.equal(r.run, 'still_active');
    assert.equal(r.runStatus, 'running');
  });

  it('a refused cancel of an already-finished run is still terminal (idempotent)', async () => {
    const m = await fakeMastra((method) => (method === 'POST' ? { status: 409, body: { error: 'already finished' } } : { status: 200, body: { status: 'success' } }));
    const r = await cancelCodingTaskRunConfirmed('r1', { server: m.url, pollMs: 5, graceMs: 200 });
    await m.close();
    assert.equal(r.run, 'terminal');
    assert.match(r.detail ?? '', /refused/);
  });

  it('a run the server does not know (restart) has nothing executing under it', async () => {
    const m = await fakeMastra((method) => (method === 'POST' ? { status: 404 } : { status: 404 }));
    const r = await cancelCodingTaskRunConfirmed('gone', { server: m.url, pollMs: 5, graceMs: 200 });
    await m.close();
    assert.equal(r.run, 'terminal');
    assert.equal(r.runStatus, 'not_found');
  });

  it('an unreachable server is unreachable, never terminal', async () => {
    const m = await fakeMastra(() => ({ status: 200 }));
    const url = m.url;
    await m.close();
    const r = await cancelCodingTaskRunConfirmed('r1', { server: url, pollMs: 5, graceMs: 60 });
    assert.equal(r.run, 'unreachable');
    assert.match(r.detail ?? '', /may still be executing/);
  });
});

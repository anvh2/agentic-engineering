import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { attachToCodingTaskRun } from './client.ts';

describe('mastra-client run polling', () => {
  it('gives up on a run the server no longer knows (restart) instead of waiting for the full timeout', async () => {
    const server = createServer((_, res) => {
      res.statusCode = 404;
      res.end('run not found');
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const started = Date.now();
    const r = await attachToCodingTaskRun('gone', { server: `http://127.0.0.1:${port}`, pollMs: 5, maxPollFailures: 3, timeoutMs: 60_000 });
    server.close();
    assert.equal(r.result, undefined);
    assert.match(r.error ?? '', /unreachable for 3 consecutive polls/);
    assert.ok(Date.now() - started < 5000);
  });

  it('returns the result of a finished run', async () => {
    const server = createServer((_, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'success', result: { status: 'PASS' } }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const r = await attachToCodingTaskRun('ok', { server: `http://127.0.0.1:${port}`, pollMs: 5 });
    server.close();
    assert.equal(r.result?.status, 'PASS');
  });
});

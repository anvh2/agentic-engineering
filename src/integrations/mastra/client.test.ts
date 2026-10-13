import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { attachToCodingTaskRun, runCodingTaskWorkflow } from './client.ts';

const request = {
  contract: { taskId: 't', objective: 'test', allowedFiles: ['x.ts'], verificationCommands: [['true']] },
  assessment: { complexity: 'small' as const, risk: 'low' as const, ambiguity: 'none' as const, rationale: 'fixture' },
};

describe('mastra-client run polling', () => {
  it('publishes the run id after creation and before execution starts', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url?.includes('/runs/') ? { status: 'success', result: { status: 'PASS' } } : {}));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const result = await runCodingTaskWorkflow(request, '/repo', {
      server: `http://127.0.0.1:${port}`,
      pollMs: 5,
      onStart: () => assert.deepEqual(requests.map((p) => p.split('?')[0]), ['/api/workflows/coding-task-workflow/create-run']),
    });
    server.close();
    assert.equal(result.result?.status, 'PASS');
    assert.match(requests[1], /\/start\?/);
  });

  it('does not start execution when the run identity cannot be persisted', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const result = await runCodingTaskWorkflow(request, '/repo', {
      server: `http://127.0.0.1:${port}`,
      onStart: () => { throw new Error('stale fence'); },
    });
    server.close();
    assert.deepEqual(requests.map((p) => p.split('?')[0]), ['/api/workflows/coding-task-workflow/create-run']);
    assert.match(result.error ?? '', /stale fence/);
  });

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

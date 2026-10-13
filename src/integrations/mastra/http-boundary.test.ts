import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ModelCapacity } from '../../runtime/capacity/model-capacity.ts';
import { Scheduler } from '../../runtime/scheduler/scheduler.ts';
import { makeRepo, makeStore, plan, sleep, tempDir, workerTask } from '../../runtime/scheduler/test-helpers.ts';
import { WorktreeManager } from '../../runtime/worktree/worktree.ts';
import { createMastraExecutor } from './executor.ts';

/**
 * The scheduler against a scripted Mastra HTTP server (real sockets, the production client and executor, a real SQLite store
 * and worktrees). These are the cases a real server cannot be made to produce on demand: a result that arrives after the
 * scheduler gave up, and a server that says "cancelled" without anything having stopped. Success, unreachable/erroring
 * servers and process-level cancellation against a REAL Mastra server are in tests/provider-smoke/codex-http-smoke.test.ts.
 */

const PASS_RESULT = { taskId: 'a', status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0, diff: '', verifier: { command: ['x'], exitCode: 0, output: '' } };

interface Script {
  /** Status the run reports, as a function of time since it started. */
  status(ms: number): { status: string; result?: unknown };
  /** What POST .../cancel answers. */
  cancel(): { status: number };
}

async function scriptedMastra(script: Script) {
  const calls: string[] = [];
  let startedAt = 0;
  const server: Server = createServer((req, res) => {
    calls.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
    const url = req.url ?? '';
    const send = (status: number, body: unknown = {}) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.includes('/start')) {
      startedAt = Date.now();
      return send(200);
    }
    if (req.method === 'POST' && url.includes('/cancel')) return send(script.cancel().status);
    if (req.method === 'GET' && url.includes('/runs/')) return send(200, script.status(Date.now() - startedAt));
    return send(200); // create-run
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function schedulerFor(url: string, options: { taskTimeoutMs?: number; capacity?: ModelCapacity } = {}) {
  const store = makeStore();
  store.createBatch(plan(makeRepo(), [workerTask('a')]));
  store.promote();
  const executor = createMastraExecutor({ server: url, pollMs: 20, taskTimeoutMs: 60_000, cancelGraceMs: 400 });
  const scheduler = new Scheduler({
    store,
    executor,
    workspace: new WorktreeManager(join(tempDir('http-wt-'), 'worktrees')),
    capacity: options.capacity,
    cancelGraceMs: 150,
    config: { pollMs: 20, workerLeaseTimeoutMs: 5_000, taskTimeoutMs: options.taskTimeoutMs ?? 60_000, maxCapacityWaitMs: 60_000 },
  });
  return { store, scheduler };
}
const waitFor = async (cond: () => boolean, what: string, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
};

describe('scheduler <-> Mastra HTTP boundary (scripted server)', () => {
  it('a PASS that the server delivers after the task timed out is fenced out: the task stays failed and nothing goes to review', async () => {
    // Event-driven, not wall-clock: the run stays "running" until the task has been seen failing, THEN the PASS is delivered.
    let release = false;
    let lateServed = 0;
    const m = await scriptedMastra({
      status: () => {
        if (!release) return { status: 'running' };
        lateServed += 1;
        return { status: 'success', result: PASS_RESULT };
      },
      cancel: () => ({ status: release ? 409 : 200 }), // "already finished" if the cancel lands after the late result
    });
    try {
      const { store, scheduler } = schedulerFor(m.url, { taskTimeoutMs: 1_500 });
      const running = scheduler.run();
      await waitFor(() => Boolean(store.requireTask('a').runId), 'run recorded');
      await waitFor(() => store.requireTask('a').state === 'RUNTIME_FAILURE', 'the task to time out', 15_000);
      release = true; // the late PASS arrives now
      const summary = await running;
      const task = store.requireTask('a');
      assert.ok(lateServed >= 1, 'the late PASS really was delivered to the client');
      assert.equal(task.state, 'RUNTIME_FAILURE');
      assert.equal(task.failureCategory, 'task_timeout');
      assert.deepEqual(summary.reviewPending, []);
      assert.equal(task.claims, 1);
      assert.deepEqual(summary.requeued, []);
      assert.equal(store.events('a').some((e) => e.to === 'REVIEW_PENDING' || e.to === 'VERIFYING'), false, 'the late PASS never entered the lifecycle');
      // The run is terminal, but without a capacity probe release cannot be confirmed clean.
      const audit = store.events('a').find((e) => /run cancellation \(task timeout\)/.test(e.reason ?? ''));
      assert.match(audit?.reason ?? '', /unconfirmed/);
      assert.equal(summary.stillActive[0]?.outcome, 'unconfirmed');
      assert.ok(m.calls.some((c) => c.startsWith('POST') && c.endsWith('/cancel')), 'the scheduler cancelled the run over HTTP');
    } finally {
      await m.close();
    }
  });

  it('a server that answers the cancel with 200 but keeps the run running is reported as STILL ACTIVE, never as stopped', async () => {
    const m = await scriptedMastra({ status: () => ({ status: 'running' }), cancel: () => ({ status: 200 }) });
    try {
      const { store, scheduler } = schedulerFor(m.url);
      const running = scheduler.run();
      await waitFor(() => Boolean(store.requireTask('a').runId), 'run recorded');
      scheduler.stop();
      const summary = await running;
      assert.equal(summary.stopReason, 'aborted');
      assert.equal(summary.stillActive.length, 1);
      assert.equal(summary.stillActive[0].outcome, 'still_active');
      assert.match(summary.stillActive[0].detail, /still running/);
      const task = store.requireTask('a');
      assert.equal(task.state, 'RUNTIME_FAILURE');
      const audit = store.events('a').find((e) => /run cancellation \(scheduler stopped\)/.test(e.reason ?? ''));
      assert.match(audit?.reason ?? '', /still_active/, 'the audit trail does not claim a stop that was not confirmed');
    } finally {
      await m.close();
    }
  });

  it('a run the server reports as cancelled while its model permit is still held is NOT confirmed stopped (a successful cancel request proves nothing about the process)', async () => {
    const m = await scriptedMastra({ status: (ms) => (ms < 0 ? { status: 'running' } : { status: 'canceled' }), cancel: () => ({ status: 200 }) });
    const capacity = new ModelCapacity(join(tempDir('http-cap-'), 'cap.db'), { resource: 'codex', permits: 1 });
    const lease = await capacity.acquire('gpt:a:pid4242', undefined, { tag: 'a' }); // what the server's runner holds while the CLI is alive
    try {
      const { store, scheduler } = schedulerFor(m.url, { capacity });
      const running = scheduler.run();
      await waitFor(() => Boolean(store.requireTask('a').runId), 'run recorded');
      scheduler.stop();
      const summary = await running;
      assert.equal(summary.stillActive.length, 1);
      assert.equal(summary.stillActive[0].outcome, 'still_active');
      assert.match(summary.stillActive[0].detail, /run status canceled/);
      assert.match(summary.stillActive[0].detail, /model still engaged/);
      assert.equal(summary.stillActive[0].engaged.length, 1);
      const audit = store.events('a').find((e) => /run cancellation/.test(e.reason ?? ''));
      assert.match(audit?.reason ?? '', /still_active/);
    } finally {
      lease.release();
      capacity.close();
      await m.close();
    }
  });

  it('once the permit really is released the same cancellation is confirmed', async () => {
    const m = await scriptedMastra({ status: () => ({ status: 'canceled' }), cancel: () => ({ status: 200 }) });
    const capacity = new ModelCapacity(join(tempDir('http-cap-'), 'cap.db'), { resource: 'codex', permits: 1 });
    const lease = await capacity.acquire('gpt:a:pid4242', undefined, { tag: 'a' });
    try {
      const { store, scheduler } = schedulerFor(m.url, { capacity });
      const running = scheduler.run();
      await waitFor(() => Boolean(store.requireTask('a').runId), 'run recorded');
      setTimeout(() => lease.release(), 60); // the process exits and the runner lets go of the permit shortly after the cancel
      scheduler.stop();
      const summary = await running;
      assert.deepEqual(summary.stillActive, []);
      assert.match(store.events('a').find((e) => /run cancellation/.test(e.reason ?? ''))?.reason ?? '', /stopped/);
    } finally {
      lease.release();
      capacity.close();
      await m.close();
    }
  });
});

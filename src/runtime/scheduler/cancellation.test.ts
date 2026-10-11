import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cancelTask } from '../../lead/cancel.ts';
import { ModelCapacity } from '../capacity/model-capacity.ts';
import { runCodingTask, type WorkerLike } from '../execution/coding-task-runner.ts';
import { runControlledCommand } from '../../workers/tools/execution-tools.ts';
import { WorktreeManager } from '../worktree/worktree.ts';
import { cancelTaskRun, type CancelReport } from './cancel.ts';
import { Scheduler, type Executor, type ExecutorInput, type ExecutorOutcome } from './scheduler.ts';
import type { SchedulerStore } from './store.ts';
import { makeRepo, makeStore, plan, sleep, tempDir, workerTask } from './test-helpers.ts';

/**
 * Cancellation across CLI -> scheduler -> executor -> run -> model permit -> provider/process. Every test is deterministic:
 * fake executors that block on a gate, an injected clock where expiry matters, a real SQLite store and a real ModelCapacity.
 * M8.1 finding being closed: stopping the scheduler or `lead cancel` left the Mastra run, its inference and its permit alive.
 */

const PASS: ExecutorOutcome = { status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0, verifier: { command: ['x'], exitCode: 0 } };
const CONFIRMED_EMPTY_CAPACITY = { isWaiting: () => false, engagedBy: () => [] };
const waitFor = async (cond: () => boolean, what: string, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(5);
  }
};

/** An executor whose runs block until aborted (like a polling client) and which records every cancel it is asked for. */
function blockingExecutor(options: { cancelReport?: (runId: string) => CancelReport | void | Promise<CancelReport | void>; ignoreAbort?: boolean } = {}) {
  const log = { started: [] as string[], cancelled: [] as { taskId: string; runId: string }[], release: new Map<string, () => void>() };
  const executor: Executor = {
    async run(input: ExecutorInput) {
      const runId = `run-${input.task.id}`;
      log.started.push(input.task.id);
      input.onRunStart({ runId });
      await new Promise<void>((resolve, reject) => {
        log.release.set(input.task.id, resolve);
        if (!options.ignoreAbort) input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      });
      return { runId, ...PASS };
    },
    async cancel({ task, runId }) {
      log.cancelled.push({ taskId: task.id, runId });
      return options.cancelReport ? options.cancelReport(runId) : { run: 'terminal', runStatus: 'canceled' };
    },
  };
  return { executor, log };
}

function setup(ids: string[], options: { executor: Executor; capacity?: ModelCapacity; config?: object; store?: SchedulerStore }) {
  const repo = makeRepo();
  const store = options.store ?? makeStore();
  store.createBatch(plan(repo, ids.map((id) => workerTask(id))));
  store.promote();
  const worktrees = new WorktreeManager(join(tempDir('cancel-wt-'), 'worktrees'));
  const scheduler = new Scheduler({
    store,
    executor: options.executor,
    workspace: worktrees,
    capacity: options.capacity ?? CONFIRMED_EMPTY_CAPACITY,
    cancelGraceMs: 100,
    config: { pollMs: 20, workerLeaseTimeoutMs: 600, taskTimeoutMs: 60_000, maxCapacityWaitMs: 60_000, ...options.config },
  });
  return { repo, store, scheduler };
}
const auditOf = (store: SchedulerStore, id: string) => store.events(id);

describe('scheduler stop', () => {
  it('cancels the in-flight run, confirms it, fails the task through its fence and records an audit event', async () => {
    const { executor, log } = blockingExecutor();
    const { store, scheduler } = setup(['a'], { executor });
    const running = scheduler.run();
    await waitFor(() => log.started.includes('a') && Boolean(store.requireTask('a').runId), 'run recorded');
    scheduler.stop();
    const summary = await running;
    assert.deepEqual(log.cancelled, [{ taskId: 'a', runId: 'run-a' }], 'the run was cancelled, not just abandoned');
    assert.equal(summary.stopReason, 'aborted');
    assert.deepEqual(summary.stillActive, [], 'a confirmed stop is not reported as still active');
    const task = store.requireTask('a');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(task.leaseOwner, null, 'no lease is left behind');
    const events = auditOf(store, 'a').map((e) => e.reason ?? '');
    assert.ok(events.some((r) => r.includes('run cancellation (scheduler stopped): stopped')), `audit trail: ${events.join(' | ')}`);
  });

  it('claims nothing once stop() has been called, even with work and free worker slots', async () => {
    const { executor, log } = blockingExecutor();
    const { store, scheduler } = setup(['a', 'b', 'c'], { executor, config: { maxConcurrentWorkers: 1 } });
    const running = scheduler.run();
    await waitFor(() => log.started.length === 1, 'first task running');
    scheduler.stop();
    assert.equal(scheduler.stopping, true);
    await running;
    assert.deepEqual(log.started, ['a'], 'b and c were never started');
    assert.equal(store.requireTask('b').claims, 0);
    assert.equal(store.requireTask('b').state, 'READY');
    assert.equal(store.requireTask('c').state, 'READY');
    // and a scheduler that is already stopping claims nothing at all
    const again = await scheduler.run();
    assert.deepEqual(again.claimed, []);
    assert.equal(store.requireTask('b').claims, 0);
  });

  it('concurrent shutdown: stop() called repeatedly while several tasks are in flight cancels each run exactly once', async () => {
    const { executor, log } = blockingExecutor();
    const { store, scheduler } = setup(['a', 'b', 'c'], { executor, config: { maxConcurrentWorkers: 3 } });
    const running = scheduler.run();
    await waitFor(() => log.started.length === 3 && ['a', 'b', 'c'].every((id) => store.requireTask(id).runId), 'three runs recorded');
    scheduler.stop();
    scheduler.stop();
    queueMicrotask(() => scheduler.stop());
    await running;
    assert.deepEqual(log.cancelled.map((c) => c.taskId).sort(), ['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) assert.equal(store.requireTask(id).state, 'RUNTIME_FAILURE');
    assert.equal(scheduler.inFlight().length, 0, 'nothing is left tracked as running');
  });

  it('a stop that cannot be confirmed is reported as still active, with the audit trail saying so', async () => {
    const { executor } = blockingExecutor({ cancelReport: () => ({ run: 'still_active', runStatus: 'running', detail: 'run still running 100ms after the cancel request' }) });
    const { store, scheduler } = setup(['a'], { executor });
    const running = scheduler.run();
    await waitFor(() => Boolean(store.requireTask('a').runId), 'run recorded');
    scheduler.stop();
    const summary = await running;
    assert.equal(summary.stillActive.length, 1);
    assert.equal(summary.stillActive[0].outcome, 'still_active');
    assert.equal(summary.stillActive[0].runId, 'run-a');
    assert.ok(auditOf(store, 'a').some((e) => e.reason?.includes('still_active')));
  });

  it('an unreachable server is reported, never mistaken for a clean stop', async () => {
    const { executor } = blockingExecutor({
      cancelReport: () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const { store, scheduler } = setup(['a'], { executor });
    const running = scheduler.run();
    await waitFor(() => Boolean(store.requireTask('a').runId), 'run recorded');
    scheduler.stop();
    const summary = await running;
    assert.equal(summary.stillActive[0]?.outcome, 'unreachable');
    assert.match(summary.stillActive[0].detail, /may still be executing/);
  });
});

describe('operator cancel', () => {
  it('lead cancel writes the fence first, then cancels and confirms the run', async () => {
    const { executor, log } = blockingExecutor();
    const { store, scheduler } = setup(['a'], { executor });
    const running = scheduler.run();
    await waitFor(() => Boolean(store.requireTask('a').runId), 'run recorded');
    const result = await cancelTask(store, { taskId: 'a', reason: 'user stop', executor, capacity: CONFIRMED_EMPTY_CAPACITY });
    assert.equal(result.task.state, 'CANCELLED');
    assert.equal(result.run.outcome, 'stopped');
    assert.equal(result.clean, true);
    assert.ok(log.cancelled.length >= 1);
    await running; // the scheduler notices the lost lease at its next heartbeat and stands down
    assert.equal(store.requireTask('a').state, 'CANCELLED', 'the scheduler did not overwrite the operator decision');
    assert.equal(store.requireTask('a').leaseOwner, null);
  });

  it('a scheduler that only notices the cancel through its lease cancels the run itself (CLI process gone / server down at cancel time)', async () => {
    const { executor, log } = blockingExecutor();
    const { store, scheduler } = setup(['a'], { executor });
    const running = scheduler.run();
    await waitFor(() => Boolean(store.requireTask('a').runId), 'run recorded');
    store.transition('a', 'CANCELLED', { actor: 'human', reason: 'state only, as the old lead cancel did' });
    await running;
    assert.deepEqual(log.cancelled.map((c) => c.runId), ['run-a'], 'lease loss on a CANCELLED task now stops the run');
  });

  it('is idempotent: cancelling an already-cancelled task retries the run cancellation instead of failing', async () => {
    let up = false;
    const { executor } = blockingExecutor({
      cancelReport: () => {
        if (!up) throw new Error('connect ECONNREFUSED');
        return { run: 'terminal', runStatus: 'canceled' };
      },
    });
    const { store, scheduler } = setup(['a'], { executor });
    const running = scheduler.run();
    await waitFor(() => Boolean(store.requireTask('a').runId), 'run recorded');
    const first = await cancelTask(store, { taskId: 'a', executor, capacity: CONFIRMED_EMPTY_CAPACITY });
    assert.equal(first.clean, false, 'server down: not confirmed');
    assert.equal(first.run.outcome, 'unreachable');
    up = true;
    const second = await cancelTask(store, { taskId: 'a', executor, capacity: CONFIRMED_EMPTY_CAPACITY });
    assert.equal(second.alreadyCancelled, true);
    assert.equal(second.clean, true);
    await running;
  });

  it('a task that never started a run is cancelled without touching the executor', async () => {
    const { executor, log } = blockingExecutor();
    const { store } = setup(['a'], { executor });
    const result = await cancelTask(store, { taskId: 'a', executor });
    assert.equal(result.run.outcome, 'no_run');
    assert.equal(result.clean, true);
    assert.deepEqual(log.cancelled, []);
  });
});

describe('timeout and fencing', () => {
  it('a result that arrives after the timeout is discarded (stale results are never recorded), and the run is cancelled', async () => {
    const { executor, log } = blockingExecutor({ ignoreAbort: true });
    // The budget must outlast worktree preparation even on a loaded machine: it is measured from the claim.
    const { store, scheduler } = setup(['a'], { executor, config: { taskTimeoutMs: 1_500, maxCapacityWaitMs: 1_500 } });
    const running = scheduler.run();
    await waitFor(() => log.started.length === 1, 'started', 15_000);
    await sleep(2_000); // past the 1.5 s budget (measured from the claim): the scheduler aborted, but this executor ignores the abort and is still "working"
    log.release.get('a')!(); // ...and now returns a perfectly good PASS
    await running;
    const task = store.requireTask('a');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(task.failureCategory, 'task_timeout');
    assert.notEqual(task.state, 'REVIEW_PENDING');
    assert.deepEqual(log.cancelled.map((c) => c.runId), ['run-a']);
  });

  it('lost lease by expiry (crashed or stalled owner): the run is NOT cancelled, so the next claim can adopt it', async () => {
    let now = 1_000_000;
    const { executor, log } = blockingExecutor();
    const store = makeStore(() => now);
    const { scheduler } = setup(['a'], { executor, store });
    const running = scheduler.run();
    await waitFor(() => Boolean(store.requireTask('a').runId), 'run recorded');
    now += 3_600_000;
    assert.deepEqual(store.reapExpired().requeued, ['a']); // another process reaped the expired lease
    assert.equal(store.requireTask('a').runId, 'run-a', 'the requeued task keeps its run id so the next claim can reconcile against it');
    await waitFor(() => log.started.length === 2, 'the task was re-claimed (epoch 2)');
    await sleep(500); // > one heartbeat: the superseded execution has certainly noticed it lost its lease
    assert.deepEqual(log.cancelled, [], 'an expired lease leaves the run for its successor; it is not cancelled out from under it');
    scheduler.stop();
    await running;
  });

  it('a run that starts after the task already lost its fence is cancelled by id (no row points at it)', async () => {
    const store = makeStore();
    const cancelled: string[] = [];
    const executor: Executor = {
      async run(input) {
        store.transition(input.task.id, 'CANCELLED', { actor: 'human', reason: 'cancelled before the run started' });
        input.onRunStart({ runId: 'late-run' }); // the Mastra run exists, but recordRun is refused by the fence
        await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
        return { runId: 'late-run', ...PASS };
      },
      async cancel({ runId }) {
        cancelled.push(runId);
        return { run: 'terminal' };
      },
    };
    const { scheduler } = setup(['a'], { executor, store });
    await scheduler.run();
    assert.deepEqual(cancelled, ['late-run']);
  });
});

describe('model permit', () => {
  const dbPath = () => join(tempDir('cancel-cap-'), 'capacity.db');

  it('a run that is terminal but still holds the permit is reported as still active, then as stopped once the permit goes', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const { executor } = blockingExecutor();
    const { store } = setup(['a'], { executor });
    const claim = store.claim({ workerId: 'w', languages: ['go', 'js'], leaseMs: 60_000, maxActive: 1 });
    assert.ok(claim);
    store.recordRun('a', claim.fence, 'run-a');
    const lease = await capacity.acquire('qwen3:8b:a:pid1', undefined, { tag: 'a' });
    assert.equal(capacity.engagedBy('a').length, 1, 'colon-bearing model names still match the task');
    const stuck = await cancelTaskRun({ store, executor, capacity, task: store.requireTask('a'), actor: 't', reason: 'test', graceMs: 120, pollMs: 10 });
    assert.equal(stuck.outcome, 'still_active');
    assert.equal(stuck.engaged[0].kind, 'lease');
    setTimeout(() => lease.release(), 60);
    const freed = await cancelTaskRun({ store, executor, capacity, task: store.requireTask('a'), actor: 't', reason: 'test', graceMs: 2_000, pollMs: 10 });
    assert.equal(freed.outcome, 'stopped');
    assert.equal(capacity.engagedBy('a').length, 0);
  });

  it('a terminal run is unconfirmed when the capacity probe is unavailable', async () => {
    const { executor } = blockingExecutor();
    const { store } = setup(['a'], { executor });
    const claim = store.claim({ workerId: 'w', languages: ['go', 'js'], leaseMs: 60_000, maxActive: 1 });
    assert.ok(claim);
    store.recordRun('a', claim.fence, 'run-a');
    const result = await cancelTaskRun({ store, executor, task: store.requireTask('a'), actor: 't', reason: 'test' });
    assert.equal(result.outcome, 'unconfirmed');
    assert.match(result.detail, /capacity probe unavailable/);
  });
});

describe('runner and process termination', () => {
  const repoFiles = { 'src/x.js': 'module.exports = 0;\n', 'tests/x.test.js': 'test("x",()=>{})\n' };
  const task = { taskId: 'x', objective: 'o', allowedFiles: ['src/x.js'], verificationCommands: [['true']] };

  it('a provider that ignores its abort is reported unresponsive and keeps the permit until it really settles', async () => {
    const capacity = new ModelCapacity(join(tempDir('cancel-run-'), 'c.db'), { permits: 1, pollMs: 10 });
    let finish!: () => void;
    const worker: WorkerLike = {
      generate: () => new Promise((resolve) => (finish = () => resolve({ text: 'late', steps: [{}], finishReason: 'stop' }))), // never looks at abortSignal
    };
    const controller = new AbortController();
    const repo = makeRepo(repoFiles);
    const running = runCodingTask(task, { repoRoot: repo, worker, capacity, signal: controller.signal, abortGraceMs: 80, runtimeRetryDelayMs: 1, modelLabel: 'qwen3:8b' });
    await waitFor(() => capacity.engagedBy('x').length === 1, 'permit held while the provider runs');
    controller.abort(new Error('cancelled'));
    const result = await running;
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.runtimeFailed, true);
    assert.ok(result.events.some((e) => e.type === 'provider_unresponsive'), 'reported, not hidden');
    assert.equal(capacity.engagedBy('x').length, 1, 'the orphaned call still holds the permit: no second inference can overlap it');
    finish();
    await waitFor(() => capacity.engagedBy('x').length === 0, 'permit released when the provider finally ended');
    assert.ok(result.events.some((e) => e.type === 'provider_settled_late'));
  });

  it('cancellation while the model call is ending skips verification and never produces a PASS', async () => {
    const controller = new AbortController();
    const worker: WorkerLike = {
      async generate() {
        controller.abort(new Error('cancelled')); // the cancel lands just as the model finishes
        return { text: 'done', steps: [{}], finishReason: 'stop' };
      },
    };
    const repo = makeRepo(repoFiles);
    const result = await runCodingTask(task, { repoRoot: repo, worker, signal: controller.signal, capacity: new ModelCapacity(':memory:', { permits: 1 }) });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.runtimeFailed, true);
    assert.equal(result.attempts, 0, 'a cancelled attempt is not a coding attempt');
    assert.ok(!result.events.some((e) => e.type === 'verification_started'), 'nothing was verified after the cancel');
  });

  it('aborting a running command kills its whole process group promptly and reports it', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runControlledCommand('sh', ['-c', 'sleep 30 & sleep 30; wait'], { cwd: tempDir('cancel-proc-'), timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.equal(result.aborted, true);
    assert.equal(result.success, false);
    assert.ok(Date.now() - started < 5_000, `killed in ${Date.now() - started} ms, not after the 30 s sleep`);
  });

  it('a command given an already-aborted signal never starts', async () => {
    const result = await runControlledCommand('sh', ['-c', 'echo should-not-run'], { cwd: tempDir('cancel-proc-'), timeoutMs: 5_000, signal: AbortSignal.abort() });
    assert.equal(result.aborted, true);
    assert.equal(result.stdout, '');
  });
});

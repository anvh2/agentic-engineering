import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { CapacityWaitTimeout, ModelCapacity } from '../capacity/model-capacity.ts';
import { runCodingTask } from '../execution/coding-task-runner.ts';
import { createTraceSink } from '../execution/coding-task-trace.ts';
import { createMetrics } from '../../observability/metrics.ts';
import { WorktreeManager } from '../worktree/worktree.ts';
import { ExecutionClock } from './execution-clock.ts';
import { Scheduler, type Executor, type ExecutorOutcome } from './scheduler.ts';
import type { SchedulerStore } from './store.ts';
import { barrier, makeRepo, makeStore, plan, sleep, tempDir, workerTask } from './test-helpers.ts';

/**
 * Queue waiting vs execution timeout. Layers, outermost first (all explicit upper bounds):
 *   1. scheduler ExecutionClock   active execution <= taskTimeoutMs (paused while queued) and queueing <= maxCapacityWaitMs
 *                                 => wall clock per run < taskTimeoutMs + maxCapacityWaitMs. THIS governs each phase.
 *   2. runner wait budget         the same queueing bound, enforced where the wait happens (capacity_wait_timeout)
 *   3. runner per-call timeout    modelTimeoutMs, starts only after the permit is held
 *   4. executor poll backstop     taskTimeoutMs + maxCapacityWaitMs (the hard bound, for a server that stops answering)
 *   5. lease + heartbeat          independent of all of the above: ownership stays valid while queued
 */

const dbPath = () => join(tempDir('capto-cap-'), 'capacity.db');

/** Aborts promptly with the signal's reason. */
const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(signal.reason);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** An executor that queues for a permit exactly as the runner does (tagged with the contract id), then "works" while holding it. */
function capacityExecutor(capacity: ModelCapacity, workMs: number) {
  const log = { queuedMs: {} as Record<string, number>, worked: [] as string[], aborted: [] as string[], finishedAt: {} as Record<string, number> };
  const executor: Executor = {
    async run(input) {
      const id = input.task.id;
      const asked = Date.now();
      let lease;
      try {
        lease = await capacity.acquire(`test:${id}`, input.signal, { tag: input.task.spec.request!.contract.taskId });
      } catch (err) {
        log.aborted.push(id);
        throw err;
      }
      try {
        log.queuedMs[id] = Date.now() - asked;
        log.worked.push(id);
        input.onRunStart({ runId: `run-${id}-${log.worked.filter((w) => w === id).length}` });
        await abortableSleep(workMs, input.signal);
        for (const f of input.task.spec.request!.contract.allowedFiles) {
          mkdirSync(dirname(join(input.repository, f)), { recursive: true });
          writeFileSync(join(input.repository, f), `module.exports = "${id}";\n`);
        }
        log.finishedAt[id] = Date.now();
        return { status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0 } satisfies ExecutorOutcome;
      } finally {
        lease.release();
      }
    },
  };
  return { executor, log };
}

function setup(taskIds: string[], options: { capacity?: ModelCapacity; executor: Executor; config?: object; now?: () => number; probe?: boolean }) {
  const repo = makeRepo();
  const store = makeStore(options.now);
  store.createBatch(plan(repo, taskIds.map((id) => workerTask(id)), {}));
  store.promote();
  const worktrees = new WorktreeManager(join(tempDir('capto-wt-'), 'worktrees'));
  const mk = (extra: object = {}) => new Scheduler({ store, executor: options.executor, workspace: worktrees, capacity: options.probe === false ? undefined : options.capacity, config: { pollMs: 20, maxTasksPerBatch: 10, ...options.config, ...extra } });
  return { repo, store, worktrees, scheduler: mk(), mk };
}

const elapsed = (store: SchedulerStore, id: string) => {
  const ev = store.events(id);
  return ev.at(-1)!.at - ev.find((e) => e.to === 'CLAIMED')!.at;
};

describe('ExecutionClock: two budgets that cannot extend each other', () => {
  it('charges queued time to the wait budget only, and working time to the active budget only', () => {
    const c = new ExecutionClock(0, 1_000, 5_000);
    assert.equal(c.tick(400, false), 'running'); // 400 active
    assert.equal(c.tick(3_400, true), 'running'); // 3000 queued
    assert.equal(c.waitedMs, 3_000);
    assert.equal(c.activeMs(), 400);
    assert.equal(c.tick(3_900, false), 'running'); // 900 active
    assert.equal(c.tick(4_000, false), 'active_timeout', 'the active budget is exactly its own 1000 ms, not 4000');
  });

  it('exhausting the queue budget is its own verdict, and elapsed wall clock can never reach active + wait budgets', () => {
    const c = new ExecutionClock(0, 1_000, 2_000);
    assert.equal(c.tick(1_999, true), 'running');
    assert.equal(c.tick(2_000, true), 'wait_budget_exhausted');
    // any interleaving ends before activeBudget + waitBudget has elapsed
    let t = 0;
    const d = new ExecutionClock(0, 1_000, 2_000);
    let verdict = d.tick(t, false);
    for (let i = 0; verdict === 'running'; i++) verdict = d.tick((t += 50), i % 3 === 0);
    assert.ok(t <= 1_000 + 2_000 + 50, `stopped at ${t}`);
  });

  it('time cannot run backwards, and a missed tick is charged by where the task is at its end', () => {
    const c = new ExecutionClock(100, 1_000, 5_000);
    c.tick(50, true);
    assert.equal(c.waitedMs, 0);
    c.tick(1_100, true);
    assert.equal(c.waitedMs, 1_000);
  });
});

describe('active execution budget starts after the permit', () => {
  it('a task queued behind two others still receives its FULL execution budget once it holds the permit (and the legacy single deadline would have killed it)', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const { executor, log } = capacityExecutor(capacity, 2_000);
    const config = { maxConcurrentWorkers: 3, taskTimeoutMs: 5_000, maxCapacityWaitMs: 60_000 };
    const { store, scheduler } = setup(['a', 'b', 'c'], { capacity, executor, config });
    await scheduler.run();

    // worktree preparation is serialised, so the three ask for the permit slightly apart; the last one queues behind both others
    const waited = Object.entries(log.queuedMs).sort((x, y) => x[1] - y[1]);
    const last = waited.at(-1)![0];
    assert.ok(waited.at(-1)![1] >= 2_000, `the last task really queued for at least one whole other task (${JSON.stringify(log.queuedMs)})`);
    assert.ok(elapsed(store, last) > config.taskTimeoutMs, `its total time (${elapsed(store, last)} ms) exceeded the active budget (${config.taskTimeoutMs} ms), so this test is meaningful`);
    for (const id of ['a', 'b', 'c']) assert.equal(store.requireTask(id).state, 'REVIEW_PENDING', id);
    assert.ok((store.requireTask(last).artifacts.capacityWaitMs as number) >= 1_500, 'queue time is recorded on the task, separately from execution');
    assert.equal(capacity.queue().length, 0);
    assert.equal(capacity.holders().length, 0);

    // control: without the capacity probe (legacy single wall-clock deadline) the same task times out while merely queued
    const control = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const legacy = capacityExecutor(control, 2_000);
    const l = setup(['a', 'b', 'c'], { capacity: control, executor: legacy.executor, config, probe: false });
    await l.scheduler.run();
    const failed = l.store.listTasks().filter((t) => t.failureCategory === 'task_timeout');
    assert.ok(failed.length >= 1, `legacy behaviour: queued tasks consumed their execution budget waiting (${failed.length} timed out)`);
    assert.ok(failed.some((t) => t.id === last), 'including the one that queued longest');
  });

  it('the active budget is still enforced after the permit is held: a stuck task times out, with its full remaining budget, having been queued first', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const blocker = capacity.tryAcquire('blocker')!;
    let acquiredAt = 0;
    const stuck: Executor = {
      async run(input) {
        const lease = await capacity.acquire('stuck', input.signal, { tag: input.task.spec.request!.contract.taskId });
        acquiredAt = Date.now();
        try {
          await abortableSleep(60_000, input.signal); // never finishes by itself
          return { status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0 };
        } finally {
          lease.release();
        }
      },
    };
    const { store, scheduler } = setup(['a'], { capacity, executor: stuck, config: { taskTimeoutMs: 1_500, maxCapacityWaitMs: 30_000 } });
    const running = scheduler.run();
    while (!capacity.isWaiting('a')) await sleep(5);
    await sleep(2_000); // queued for longer than the entire active budget
    assert.equal(store.requireTask('a').state, 'CODING', 'still alive after more than taskTimeoutMs of queueing');
    blocker.release();
    await running;
    const t = store.requireTask('a');
    assert.deepEqual([t.state, t.failureCategory], ['RUNTIME_FAILURE', 'task_timeout']);
    assert.match(t.stateReason ?? '', /of active execution \(\d+ms queued for a model permit not counted\)/);
    // The clock was running while the worktree was prepared (before the task queued): that is active time. After the permit
    // the task gets exactly what was left of its budget: 1500 ms minus the preparation, to within one clock sample.
    const events = store.events('a');
    const prepMs = events.find((e) => e.to === 'CODING')!.at - events.find((e) => e.to === 'CLAIMED')!.at;
    const failedAt = events.find((e) => e.to === 'RUNTIME_FAILURE')!.at;
    const afterPermit = failedAt - acquiredAt;
    assert.ok(afterPermit >= 1_500 - prepMs - 150 && afterPermit <= 1_500 - prepMs + 800, `after the permit the task ran ${afterPermit} ms; expected about ${1_500 - prepMs} ms (1500 budget - ${prepMs} ms preparation)`);
    assert.ok(afterPermit < 4_000, 'and the 2 s of queueing was not what ended it');
    assert.equal(capacity.holders().length, 0, 'the timed-out task released its permit');
  });
});

describe('capacity wait is bounded, explicit and recoverable', () => {
  it('scheduler: exhausting maxCapacityWaitMs fails the task as capacity_wait_timeout (not task_timeout), withdraws it from the queue, and a retry succeeds', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const blocker = capacity.tryAcquire('blocker')!;
    const { executor, log } = capacityExecutor(capacity, 50);
    const { store, scheduler } = setup(['a'], { capacity, executor, config: { taskTimeoutMs: 60_000, maxCapacityWaitMs: 400 } });
    const started = Date.now();
    await scheduler.run();
    const t = store.requireTask('a');
    assert.deepEqual([t.state, t.failureCategory], ['RUNTIME_FAILURE', 'capacity_wait_timeout']);
    assert.match(t.stateReason ?? '', /queued for a model permit .* past maxCapacityWaitMs of 400ms/);
    assert.ok(Date.now() - started < 5_000, 'bounded');
    assert.equal(capacity.queue().length, 0, 'the expired wait left the queue');
    assert.deepEqual(log.worked, [], 'the model was never used');
    assert.equal(t.claims, 1);

    // recovery: the Lead retries once the model is free (an ordinary RUNTIME_FAILURE retry, within the claim budget)
    blocker.release();
    store.transition('a', 'READY', { actor: 'human', reason: 'retry', expectFrom: 'RUNTIME_FAILURE' });
    await scheduler.run();
    assert.equal(store.requireTask('a').state, 'REVIEW_PENDING');
    assert.equal(store.requireTask('a').claims, 2);
  });

  it('runner: a spent wait budget is an explicit capacity_wait_timeout runtime failure, without a runtime retry, a model call or a coding attempt', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const blocker = capacity.tryAcquire('blocker')!;
    const root = makeRepo({ 'src/a.txt': 'old\n' });
    let modelCalls = 0;
    const metrics = createMetrics();
    const result = await runCodingTask(
      { taskId: 'T-wait', objective: 'x', allowedFiles: ['src/a.txt'], verificationCommands: [['node', '-e', 'process.exit(0)']], constraints: ['tests are immutable'] },
      { repoRoot: root, worker: { async generate() { modelCalls++; return { text: '', finishReason: 'stop', steps: [{}] }; } }, capacity, metrics, capacityWaitBudgetMs: 200 },
    );
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.runtimeFailed, true);
    assert.equal(result.attempts, 0, 'not a coding attempt');
    assert.equal(result.runtimeRetries, 0, 'a spent budget is not retried inside the runner');
    assert.equal(modelCalls, 0);
    assert.match(result.records.at(-1)!.runtimeError ?? '', /capacity_wait_timeout: waited \d+ms for a model permit \(budget 200ms\)/);
    assert.ok(result.records.at(-1)!.capacityWaitMs >= 190);
    assert.match(await metrics.render(), /model_capacity_wait_seconds_count\{outcome="timeout"\} 1/);
    assert.equal(capacity.queue().length, 0);
    blocker.release();
  });

  it('runner: the budget is cumulative across attempts, so a task cannot queue forever one call at a time', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 5 });
    const root = makeRepo({ 'src/a.txt': 'old\n' });
    const holdFor = (ms: number) => {
      const l = capacity.tryAcquire('other')!;
      setTimeout(() => l.release(), ms);
    };
    holdFor(250); // the first call queues ~250 ms of the 400 ms budget
    let call = 0;
    const result = await runCodingTask(
      { taskId: 'T-cum', objective: 'x', allowedFiles: ['src/a.txt'], verificationCommands: [['node', '-e', 'process.exit(1)']], constraints: ['tests are immutable'] },
      {
        repoRoot: root,
        capacity,
        capacityWaitBudgetMs: 400,
        maxAttempts: 3,
        worker: {
          async generate() {
            call += 1;
            writeFileSync(join(root, 'src/a.txt'), `try ${call}\n`);
            // another worker takes the permit the moment this call releases it, for much longer than what is left of the budget
            setTimeout(() => holdFor(1_500), 0);
            return { text: '', finishReason: 'stop', steps: [{}] };
          },
        },
      },
    );
    assert.equal(call, 1, 'the second attempt never reached the model');
    assert.equal(result.runtimeFailed, true, 'the second queueing crossed the cumulative budget');
    assert.match(result.records.at(-1)!.runtimeError ?? '', /capacity_wait_timeout/);
    const waits = result.records.map((r) => r.capacityWaitMs);
    assert.ok(waits[0] >= 200 && waits[0] < 400, `attempt 1 queued within budget (${waits[0]} ms)`);
    assert.ok(waits.reduce((a, b) => a + b, 0) >= 390, `attempt 2 was only allowed what remained (${JSON.stringify(waits)})`);
  });

  it('trace ordering: a failed model call records model_finished BEFORE its permit is released, so the next holder\'s model_started can never precede it', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 2 });
    const order: string[] = []; // global emission order across both runs
    const sink = (name: string) => {
      const inner = createTraceSink();
      return { events: inner.events, emit: (type: Parameters<typeof inner.emit>[0], data?: Record<string, unknown>) => (order.push(`${name}:${type}`), inner.emit(type, data)) };
    };
    const task = (taskId: string) => ({ taskId, objective: 'x', allowedFiles: ['src/a.txt'], verificationCommands: [['node', '-e', 'process.exit(0)']], constraints: ['tests are immutable'] });
    const started = barrier(2); // both runs are queued before either calls the model
    const run = async (name: string, generate: () => Promise<{ text: string; finishReason: string; steps: unknown[] }>) => {
      const root = makeRepo({ 'src/a.txt': 'old\n' });
      await started.wait();
      return runCodingTask(task(name), { repoRoot: root, capacity, trace: sink(name), maxAttempts: 1, runtimeRetryDelayMs: 0, worker: { generate } });
    };
    await Promise.all([
      run('failing', async () => { await sleep(150); throw new Error('ollama went away'); }),
      run('next', async () => ({ text: 'done', finishReason: 'stop', steps: [{}] })),
    ]);
    const models = order.filter((e) => /model_(started|finished)/.test(e));
    // one permit => the calls are strictly serialised: started, finished, started, finished ... (the failing run also retries once)
    assert.equal(models.length, 6, models.join(' > '));
    models.forEach((e, i) => assert.ok(e.endsWith(i % 2 === 0 ? ':model_started' : ':model_finished'), `a model_started preceded the previous call's model_finished: ${models.join(' > ')}`));
    for (let i = 0; i < models.length; i += 2) assert.equal(models[i].split(':')[0], models[i + 1].split(':')[0], 'each finish belongs to the start before it');
  });

  it('a permit lease that was lost during a model call is reported in the trace (never a silent overlap)', async () => {
    let skew = 0; // the capacity clock jumps past the lease while the call is in flight, as after a long process stall
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 5, leaseMs: 150, now: () => Date.now() + skew });
    const root = makeRepo({ 'src/a.txt': 'old\n' });
    const trace = createTraceSink();
    await runCodingTask(
      { taskId: 'T-lost', objective: 'x', allowedFiles: ['src/a.txt'], verificationCommands: [['node', '-e', 'process.exit(0)']], constraints: ['tests are immutable'] },
      { repoRoot: root, capacity, trace, maxAttempts: 1, worker: { async generate() { skew += 3_600_000; await sleep(120); return { text: '', finishReason: 'stop', steps: [{}] }; } } },
    );
    assert.ok(trace.events.some((e) => e.type === 'worker_status' && /permit lease was lost/.test(String(e.data.text))), 'the lost lease is visible');
    // and the control: an undisturbed call reports nothing
    const quiet = createTraceSink();
    await runCodingTask(
      { taskId: 'T-ok', objective: 'x', allowedFiles: ['src/a.txt'], verificationCommands: [['node', '-e', 'process.exit(0)']], constraints: ['tests are immutable'] },
      { repoRoot: makeRepo({ 'src/a.txt': 'old\n' }), capacity: new ModelCapacity(dbPath(), { permits: 1 }), trace: quiet, maxAttempts: 1, worker: { async generate() { return { text: '', finishReason: 'stop', steps: [{}] }; } } },
    );
    assert.ok(!quiet.events.some((e) => /permit lease was lost/.test(String(e.data?.text ?? ''))));
  });

  it('a runner capacity_wait_timeout reported through the executor is categorised capacity_wait_timeout by the scheduler', async () => {
    const executor: Executor = {
      async run() {
        return { status: 'RUNTIME_FAILURE', reasons: ['model runtime failed after its bounded retry: capacity_wait_timeout: waited 1800000ms for a model permit (budget 1800000ms)'], codingAttempts: 0, runtimeRetries: 0 };
      },
    };
    const { store, scheduler } = setup(['a'], { executor });
    await scheduler.run();
    assert.equal(store.requireTask('a').failureCategory, 'capacity_wait_timeout');
    assert.equal(store.requireTask('a').state, 'RUNTIME_FAILURE');
  });

  it('CapacityWaitTimeout carries the numbers an operator needs', () => {
    const e = new CapacityWaitTimeout(1234, 1000);
    assert.deepEqual([e.code, e.waitedMs, e.budgetMs], ['capacity_wait_timeout', 1234, 1000]);
  });
});

describe('ownership and cancellation while queued', () => {
  it('the lease is kept alive by heartbeats for the whole wait: nothing is reaped or re-claimed while the task is queued', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const blocker = capacity.tryAcquire('blocker')!;
    const { executor, log } = capacityExecutor(capacity, 20);
    const { store, scheduler } = setup(['a'], { capacity, executor, config: { workerLeaseTimeoutMs: 300, taskTimeoutMs: 5_000, maxCapacityWaitMs: 30_000 } });
    const running = scheduler.run();
    const reaped: string[][] = [];
    for (let i = 0; i < 12; i++) {
      await sleep(100); // 1.2 s of queueing = 4 lease lengths
      reaped.push(store.reapExpired().requeued);
    }
    assert.ok(reaped.every((r) => r.length === 0), 'the heartbeat renewed the lease every time');
    assert.equal(store.requireTask('a').claims, 1);
    assert.equal(store.requireTask('a').state, 'CODING');
    blocker.release();
    await running;
    assert.equal(store.requireTask('a').state, 'REVIEW_PENDING');
    assert.equal(store.requireTask('a').claims, 1, 'one claim for the whole queue + run');
    assert.deepEqual(log.worked, ['a']);
  });

  it('cancelling a task that is queued terminates its wait promptly and leaves no queue entry', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const blocker = capacity.tryAcquire('blocker')!;
    const { executor, log } = capacityExecutor(capacity, 20);
    const { store, scheduler } = setup(['a'], { capacity, executor, config: { workerLeaseTimeoutMs: 300, taskTimeoutMs: 60_000, maxCapacityWaitMs: 60_000 } });
    const running = scheduler.run();
    while (!capacity.isWaiting('a')) await sleep(5);
    const cancelledAt = Date.now();
    store.transition('a', 'CANCELLED', { actor: 'human', reason: 'user cancelled' }); // noticed at the next heartbeat (<= lease/3)
    await running;
    assert.ok(Date.now() - cancelledAt < 1_500, `terminated promptly (${Date.now() - cancelledAt} ms)`);
    assert.equal(capacity.queue().length, 0, 'the wait was withdrawn, not left to expire');
    assert.deepEqual(log.worked, [], 'a cancelled task never reached the model');
    assert.equal(store.requireTask('a').state, 'CANCELLED');
    blocker.release();
    assert.ok(capacity.tryAcquire('free'), 'nothing is stuck behind the cancelled task');
  });

  it('stopping the scheduler while a task is queued withdraws the wait', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const blocker = capacity.tryAcquire('blocker')!;
    const { executor } = capacityExecutor(capacity, 20);
    const { store, scheduler } = setup(['a'], { capacity, executor, config: { taskTimeoutMs: 60_000, maxCapacityWaitMs: 60_000 } });
    const running = scheduler.run();
    while (!capacity.isWaiting('a')) await sleep(5);
    scheduler.stop();
    await running;
    assert.equal(capacity.queue().length, 0);
    assert.equal(store.requireTask('a').state, 'RUNTIME_FAILURE');
    blocker.release();
  });

  it('a lease that expires while the task is queued cannot lead to stale execution: the old owner is withdrawn, the new owner runs', async () => {
    let now = 1_000_000;
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const blocker = capacity.tryAcquire('blocker')!;
    const oldSide = capacityExecutor(capacity, 30);
    const newSide = capacityExecutor(capacity, 30);
    const repo = makeRepo();
    const store = makeStore(() => now);
    store.createBatch(plan(repo, [workerTask('a', { maxClaims: 3 })], {}));
    store.promote();
    const worktrees = new WorktreeManager(join(tempDir('capto-wt-'), 'worktrees'));
    // 600 ms lease -> heartbeat every 200 ms of real time; the store clock is injected so expiry is exact
    const config = { pollMs: 20, workerLeaseTimeoutMs: 600, taskTimeoutMs: 60_000, maxCapacityWaitMs: 60_000 };
    const oldSched = new Scheduler({ store, executor: oldSide.executor, workspace: worktrees, capacity, config });
    const newSched = new Scheduler({ store, executor: newSide.executor, workspace: worktrees, capacity, config });

    const oldRun = oldSched.run({ workerPrefix: 'old' });
    while (capacity.queue().length < 1) await sleep(5);
    assert.equal(store.requireTask('a').leaseOwner, 'old-w1');

    // the old owner stalls past its lease: reaped and requeued in the same synchronous step (no heartbeat can interleave)
    now += 3_600_000;
    assert.deepEqual(store.reapExpired().requeued, ['a']);
    const newRun = newSched.run({ workerPrefix: 'new' });
    while (store.requireTask('a').leaseOwner !== 'new-w1') await sleep(5);
    assert.equal(store.requireTask('a').claimEpoch, 2);

    await oldRun; // the old owner notices at its next heartbeat that it no longer owns the task and abandons its wait
    assert.deepEqual(oldSide.log.worked, [], 'the stale owner never reached the model');
    assert.deepEqual(oldSide.log.aborted, ['a']);
    while (capacity.queue().length !== 1) await sleep(5);
    assert.equal(capacity.queue().length, 1, "only the new owner's wait remains queued");

    blocker.release();
    await newRun;
    assert.deepEqual(newSide.log.worked, ['a']);
    const t = store.requireTask('a');
    assert.deepEqual([t.state, t.claimEpoch, t.claims], ['REVIEW_PENDING', 2, 1]); // epoch 2, but the expired claim was refunded
    assert.equal(store.listReviews().length, 1, 'exactly one result was published, by the current owner');
    assert.equal(store.events('a').find((e) => e.to === 'REVIEW_PENDING')!.actor, 'new-w1');
  });

  it('worker concurrency >= 3 with queued tasks: every task is claimed, granted the model in FIFO order, and none is lost or doubled', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const granted: string[] = [];
    const firstThree = barrier(3); // a, b, c are all inside the executor before any of them asks for the permit
    const executor: Executor = {
      async run(input) {
        const id = input.task.id;
        if (id !== 'd') await firstThree.wait();
        const lease = await capacity.acquire(`t:${id}`, input.signal, { tag: id });
        granted.push(id);
        await sleep(30);
        lease.release();
        mkdirSync(join(input.repository, 'src'), { recursive: true });
        writeFileSync(join(input.repository, `src/${id}.js`), 'x\n');
        return { status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0 };
      },
    };
    const { store, scheduler } = setup(['a', 'b', 'c', 'd'], { capacity, executor, config: { maxConcurrentWorkers: 3, taskTimeoutMs: 30_000, maxCapacityWaitMs: 30_000 } });
    const summary = await scheduler.run();
    assert.equal(summary.peakInFlight, 3, 'the pool is bounded at 3 logical workers; the fourth waits for a free slot');
    assert.equal(summary.reviewPending.length, 4);
    assert.equal(new Set(granted).size, 4, 'each task used the model exactly once');
    assert.equal(granted.at(-1), 'd', 'the task claimed last queued last');
    assert.ok(store.listTasks().every((t) => t.claims === 1 && t.state === 'REVIEW_PENDING'));
    assert.equal(capacity.queue().length, 0);
  });
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ModelCapacity } from '../capacity/model-capacity.ts';
import { runCodingTask } from '../execution/coding-task-runner.ts';
import { integrateBatch, type CommandRunner } from '../integration/integrate.ts';
import { reviewDecision } from '../../lead/review.ts';
import { createMetrics } from '../../observability/metrics.ts';
import { WorktreeManager } from '../worktree/worktree.ts';
import { Scheduler, type Executor, type ExecutorOutcome } from './scheduler.ts';
import { SchedulerStore } from './store.ts';
import { configFromEnv, resolveConfig } from './types.ts';
import { barrier, fakeExecutor, makeRepo, makeStore, maxOverlap, plan, sleep, tempDir, workerTask } from './test-helpers.ts';

/**
 * M7: several logical workers over one persistent scheduler. Every test here is deterministic: overlap is proven with
 * barriers (the test deadlocks and fails loudly if the work did NOT overlap), not with timing luck.
 */

const passRunner: CommandRunner = async () => ({ exitCode: 0, output: 'ok', timedOut: false });
const PASS: ExecutorOutcome = { status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0 };

function setup(tasks: ReturnType<typeof workerTask>[], options: { executor?: Executor; config?: object; now?: () => number; planExtra?: object; prefix?: string } = {}) {
  const repo = makeRepo();
  const store = makeStore(options.now);
  store.createBatch(plan(repo, tasks, options.planExtra));
  store.promote();
  const worktrees = new WorktreeManager(join(tempDir('mw-wt-'), 'worktrees'));
  const executor = options.executor ?? fakeExecutor();
  const scheduler = new Scheduler({ store, executor, workspace: worktrees, config: { pollMs: 20, ...options.config } });
  return { repo, store, worktrees, executor: executor as ReturnType<typeof fakeExecutor>, scheduler };
}
const approve = (store: SchedulerStore, id: string) => reviewDecision(store, { maxReviewCorrections: 2 }, { taskId: id, decision: 'APPROVED', feedback: 'lgtm' });

describe('M7 A: independent tasks genuinely run in parallel', () => {
  it('three independent tasks are CODING at the same instant under three distinct leases, in three worktrees', async () => {
    const gate = barrier(3);
    let codingAtBarrier: { id: string; owner: string | null }[] | undefined;
    let store!: SchedulerStore;
    const executor = fakeExecutor({
      gate: async () => {
        await gate.wait(); // opens only when all three executors are inside it
        // the first task to resume samples the persisted rows before ANY task can have completed
        codingAtBarrier ??= store.listTasks({ states: ['CODING'] }).map((t) => ({ id: t.id, owner: t.leaseOwner }));
      },
    });
    const s = setup([workerTask('a'), workerTask('b'), workerTask('c')], { executor, config: { maxConcurrentWorkers: 3 } });
    store = s.store;
    const summary = await s.scheduler.run();

    assert.equal(summary.peakInFlight, 3);
    assert.equal(executor.peak(), 3);
    assert.equal(maxOverlap(executor.intervals), 3, 'the three executor runs overlapped in time');
    assert.deepEqual(codingAtBarrier?.map((c) => c.id).sort(), ['a', 'b', 'c'], 'three tasks were persisted as CODING simultaneously');
    assert.equal(new Set(codingAtBarrier?.map((c) => c.owner)).size, 3, 'each under its own worker lease');
    assert.deepEqual(summary.reviewPending.sort(), ['a', 'b', 'c']);
    assert.equal(new Set(['a', 'b', 'c'].map((id) => store.requireTask(id).worktreePath)).size, 3, 'three distinct worktrees');
  });

  it('the pool never exceeds maxConcurrentWorkers: five tasks on three workers peak at exactly three', async () => {
    const first = barrier(3); // the first three to arrive are held until all three are in flight together
    let arrivals = 0;
    const executor = fakeExecutor({
      gate: async () => {
        if (++arrivals <= 3) await first.wait();
        else await sleep(10);
      },
    });
    const { scheduler } = setup(['a', 'b', 'c', 'd', 'e'].map((id) => workerTask(id)), { executor, config: { maxConcurrentWorkers: 3, maxTasksPerBatch: 10 } });
    const summary = await scheduler.run();
    assert.equal(summary.reviewPending.length, 5);
    assert.equal(executor.peak(), 3);
    assert.equal(maxOverlap(executor.intervals), 3, 'three at once, never four');
    assert.equal(summary.peakInFlight, 3);
  });

  it('with the default pool (1 worker) the same tasks run strictly one at a time', async () => {
    const executor = fakeExecutor({ gate: () => sleep(20) });
    const { scheduler } = setup([workerTask('a'), workerTask('b'), workerTask('c')], { executor });
    await scheduler.run();
    assert.equal(maxOverlap(executor.intervals), 1);
  });
});

describe('M7 B: the plan is a DAG', () => {
  const dag = () => [workerTask('A'), workerTask('B'), workerTask('C'), workerTask('D', { dependsOn: ['A', 'B', 'C'], priority: 99 })];

  it('D never executes until A, B and C are DONE (integrated), however high its priority', async () => {
    const seen: Record<string, string[]> = {};
    const executor = fakeExecutor({
      behavior: (input) => {
        const present = ['A', 'B', 'C'].filter((x) => existsSync(join(input.repository, `src/${x}.js`)));
        seen[input.task.id] = present;
        return undefined;
      },
    });
    const { store, worktrees, scheduler } = setup(dag(), { executor, config: { maxConcurrentWorkers: 3 } });

    await scheduler.run();
    assert.deepEqual([...executor.calls].sort(), ['A', 'B', 'C'], 'independent tasks ran together; D did not');
    assert.equal(store.requireTask('D').state, 'BACKLOG');
    assert.deepEqual(store.dependencyStatus(store.requireTask('D')).waitingOn, [
      { id: 'A', state: 'REVIEW_PENDING' },
      { id: 'B', state: 'REVIEW_PENDING' },
      { id: 'C', state: 'REVIEW_PENDING' },
    ]);

    // two of three prerequisites are not enough, and neither is "approved but not integrated"
    approve(store, 'A');
    approve(store, 'B');
    await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.deepEqual(['A', 'B'].map((id) => store.requireTask(id).state), ['DONE', 'DONE']);
    assert.equal(store.requireTask('D').state, 'BACKLOG');
    await scheduler.run();
    assert.ok(!executor.calls.includes('D'), 'D still has not run: C is only REVIEW_PENDING');

    approve(store, 'C');
    assert.equal(store.requireTask('D').state, 'BACKLOG', 'APPROVED is not enough either');
    await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.equal(store.requireTask('D').state, 'READY');
    await scheduler.run();

    assert.equal(executor.calls.filter((c) => c === 'D').length, 1);
    assert.deepEqual(seen.D, ['A', 'B', 'C'], 'D ran in a worktree that already contains all three prerequisites');
    assert.equal(store.requireTask('D').state, 'REVIEW_PENDING');
    const claimedAt = (id: string) => store.events(id).find((e) => e.to === 'CLAIMED')!.seq;
    const doneAt = (id: string) => store.events(id).find((e) => e.to === 'DONE')!.seq;
    for (const dep of ['A', 'B', 'C']) assert.ok(doneAt(dep) < claimedAt('D'), `${dep} reached DONE before D was ever claimed`);
  });

  it('a dependent is never claimable even when a worker is free and it is the highest-priority task', async () => {
    const { store } = setup(dag());
    const claims = [1, 2, 3, 4].map((i) => store.claim({ workerId: `w${i}`, languages: ['js'], leaseMs: 1000, maxActive: 10 })?.task.id);
    assert.deepEqual(claims.slice(0, 3).sort(), ['A', 'B', 'C']);
    assert.equal(claims[3], undefined);
  });

  it('integrates in dependency order regardless of priority', () => {
    const store = makeStore();
    store.createBatch(plan('/r', [workerTask('zeta', { priority: 99, dependsOn: ['alpha'] }), workerTask('alpha', { priority: 1 }), workerTask('mid', { priority: 50 })]));
    const rows = ['zeta', 'mid', 'alpha'].map((id) => store.requireTask(id));
    return import('../integration/integrate.ts').then(({ integrationOrder }) => {
      const order = integrationOrder(store, rows).map((t) => t.id);
      assert.ok(order.indexOf('alpha') < order.indexOf('zeta'), `alpha before zeta: ${order.join(',')}`);
      assert.deepEqual(order, ['alpha', 'zeta', 'mid'], 'stable: input order otherwise preserved');
    });
  });
});

describe('M7 B: what a failed dependency does to its descendants (never a silent wait)', () => {
  function chain() {
    const store = makeStore();
    store.createBatch(plan('/r', [workerTask('root'), workerTask('mid', { dependsOn: ['root'] }), workerTask('leaf', { dependsOn: ['mid'] }), workerTask('side'), workerTask('join', { dependsOn: ['root', 'side'] })]));
    store.promote();
    return store;
  }
  const claim = (store: SchedulerStore, w = 'w') => store.claim({ workerId: w, languages: ['js'], leaseMs: 1000, maxActive: 10 })!;

  it('ESCALATED root: every transitive descendant becomes BLOCKED(dependency_failed) with the root cause in its reason; unrelated tasks are untouched', () => {
    const store = chain();
    const c = claim(store);
    assert.equal(c.task.id, 'root');
    store.transition('root', 'ESCALATED', { actor: 'w', fence: c.fence, reason: 'attempts exhausted' });
    store.promote();
    store.promote(); // a second pass settles the chain (promote runs every scheduling pass)
    for (const id of ['mid', 'leaf', 'join']) {
      const t = store.requireTask(id);
      assert.equal(t.state, 'BLOCKED', id);
      assert.equal(t.failureCategory, 'dependency_failed', id);
    }
    assert.match(store.requireTask('mid').stateReason ?? '', /dependency root is ESCALATED/);
    assert.match(store.requireTask('leaf').stateReason ?? '', /dependency mid is BLOCKED.*root is ESCALATED/, 'the leaf names the root cause, not only its parent');
    assert.equal(store.requireTask('side').state, 'READY', 'an unrelated branch keeps going');
  });

  it('a failed dependency is detected even when an earlier dependency is merely waiting (no first-wins masking)', () => {
    const store = chain();
    const c = claim(store); // root
    store.transition('root', 'CODING', { actor: 'w', fence: c.fence }); // root: still running
    const s = claim(store, 'w2'); // side
    store.transition('side', 'ESCALATED', { actor: 'w2', fence: s.fence });
    store.promote();
    assert.equal(store.requireTask('join').state, 'BLOCKED', 'join depends on [root (running), side (escalated)]: it can never complete');
  });

  it('CANCELLED dependency blocks descendants (and the cancel path promotes immediately)', () => {
    const store = chain();
    store.transition('root', 'CANCELLED', { actor: 'human' });
    store.promote();
    assert.equal(store.requireTask('mid').state, 'BLOCKED');
    assert.match(store.requireTask('mid').stateReason ?? '', /CANCELLED/);
  });

  it('RUNTIME_FAILURE is waiting while a retry is possible and BLOCKS descendants once the claim budget is spent', () => {
    const store = chain();
    const c = claim(store);
    store.transition('root', 'RUNTIME_FAILURE', { actor: 'w', fence: c.fence, reason: 'ollama down' });
    store.promote();
    assert.equal(store.requireTask('mid').state, 'BACKLOG', 'claims 1/3: `lead retry` can still revive root, so mid waits (and says why)');
    assert.deepEqual(store.dependencyStatus(store.requireTask('mid')).waitingOn, [{ id: 'root', state: 'RUNTIME_FAILURE' }]);

    store.db.prepare('UPDATE tasks SET claims = 3 WHERE id = ?').run('root'); // budget spent
    store.promote();
    assert.equal(store.requireTask('mid').state, 'BLOCKED');
    assert.match(store.requireTask('mid').stateReason ?? '', /claim budget spent/);
  });

  it('recovery unblocks the chain: a taken-over root returns descendants to BACKLOG', () => {
    const store = chain();
    const c = claim(store);
    store.transition('root', 'ESCALATED', { actor: 'w', fence: c.fence });
    store.promote();
    store.promote();
    assert.equal(store.requireTask('leaf').state, 'BLOCKED');
    store.transition('root', 'READY', { actor: 'human', reason: 'retry' });
    store.promote();
    store.promote();
    assert.deepEqual(['mid', 'leaf', 'join'].map((id) => store.requireTask(id).state), ['BACKLOG', 'BACKLOG', 'BACKLOG']);
  });

  it('plans are validated before anything is stored: self-dependency, missing dependency and cycles are rejected', () => {
    const store = makeStore();
    assert.throws(() => store.createBatch(plan('/r', [workerTask('a', { dependsOn: ['a'] })])), /depends on itself/);
    assert.throws(() => store.createBatch(plan('/r', [workerTask('a', { dependsOn: ['ghost'] })])), /unknown task ghost/);
    assert.throws(() => store.createBatch(plan('/r', [workerTask('a', { dependsOn: ['c'] }), workerTask('b', { dependsOn: ['a'] }), workerTask('c', { dependsOn: ['b'] })])), /dependency cycle: .*a.*b.*c|dependency cycle/);
    assert.equal(store.listBatches().length, 0, 'a rejected plan leaves nothing behind');
  });
});

describe('M7 C: claims are atomic under contention', () => {
  const CHILD = join(fileURLToPath(new URL('.', import.meta.url)), 'claim-child.ts');
  const runChild = (db: string, id: string, maxActive?: number) =>
    new Promise<string[]>((resolve, reject) => {
      const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, db, id, ...(maxActive ? [String(maxActive)] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child ${id} exit ${code}: ${err}`))));
    });

  it('six OS processes racing for ONE ready task: exactly one wins, the epoch is 1, and it was claimed once', async () => {
    const path = join(tempDir(), 's.db');
    const store = new SchedulerStore(path);
    store.createBatch(plan('/r', [workerTask('only')]));
    store.promote();
    const results = await Promise.all(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id) => runChild(path, id)));
    assert.deepEqual(results.flat(), ['only']);
    const t = store.requireTask('only');
    assert.deepEqual([t.claims, t.claimEpoch, t.state], [1, 1, 'CLAIMED']);
    assert.equal(store.events('only').filter((e) => e.to === 'CLAIMED').length, 1, 'one CLAIMED audit event');
  });

  it('maxActive is enforced inside the claim transaction ACROSS processes: 4 processes, 8 tasks, limit 3 -> exactly 3 leases', async () => {
    const path = join(tempDir(), 's.db');
    const store = new SchedulerStore(path);
    store.createBatch(plan('/r', Array.from({ length: 8 }, (_, i) => workerTask(`t${i}`))));
    store.promote();
    const won = (await Promise.all(['p1', 'p2', 'p3', 'p4'].map((id) => runChild(path, id, 3)))).flat();
    assert.equal(won.length, 3, `claimed ${won.join(',')}`);
    assert.equal(new Set(won).size, 3);
    assert.equal(store.listTasks({ states: ['CLAIMED'] }).length, 3);
  });

  it('two schedulers sharing one database never run the same task twice', async () => {
    const path = join(tempDir(), 's.db');
    const repo = makeRepo();
    const s1 = new SchedulerStore(path);
    const s2 = new SchedulerStore(path);
    s1.createBatch(plan(repo, ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => workerTask(id)), {}));
    s1.promote();
    const e1 = fakeExecutor({ gate: () => sleep(15) });
    const e2 = fakeExecutor({ gate: () => sleep(15) });
    const wt = new WorktreeManager(join(tempDir('mw-wt-'), 'worktrees'));
    const sched1 = new Scheduler({ store: s1, executor: e1, workspace: wt, config: { pollMs: 10, maxConcurrentWorkers: 3, maxTasksPerBatch: 10 } });
    const sched2 = new Scheduler({ store: s2, executor: e2, workspace: wt, config: { pollMs: 10, maxConcurrentWorkers: 3, maxTasksPerBatch: 10 } });
    await Promise.all([sched1.run({ workerPrefix: 'one' }), sched2.run({ workerPrefix: 'two' })]);
    const ran = [...e1.calls, ...e2.calls].sort();
    assert.deepEqual(ran, ['a', 'b', 'c', 'd', 'e', 'f'], 'each task executed exactly once across both schedulers');
    assert.ok(s1.listTasks().every((t) => t.claims === 1 && t.state === 'REVIEW_PENDING'));
    assert.ok(maxOverlap([...e1.intervals, ...e2.intervals]) <= 3, 'maxActive is global to the database: two schedulers together never exceed it');
  });
});

describe('M7 D: a failing worker does not disturb its siblings', () => {
  it('one task throws while two unrelated tasks are in flight with it: they still reach review, only its dependents are blocked', async () => {
    const gate = barrier(3);
    const executor = fakeExecutor({
      gate: () => gate.wait(), // all three are running before anything fails
      behavior: (input) => {
        if (input.task.id === 'bad') throw new Error('worker crashed');
        return undefined;
      },
    });
    const { store, scheduler } = setup([workerTask('ok1'), workerTask('bad'), workerTask('ok2'), workerTask('after-bad', { dependsOn: ['bad'] }), workerTask('after-ok1', { dependsOn: ['ok1'] })], { executor, config: { maxConcurrentWorkers: 3 } });
    const summary = await scheduler.run();

    assert.equal(store.requireTask('bad').state, 'RUNTIME_FAILURE');
    assert.equal(store.requireTask('bad').failureCategory, 'executor_error');
    assert.deepEqual(['ok1', 'ok2'].map((id) => store.requireTask(id).state), ['REVIEW_PENDING', 'REVIEW_PENDING']);
    assert.deepEqual(summary.reviewPending.sort(), ['ok1', 'ok2']);
    assert.equal(store.requireTask('after-ok1').state, 'BACKLOG', 'a sibling branch keeps waiting for its own prerequisite, undisturbed');
    // bad is RUNTIME_FAILURE with claims left (retryable): its dependent waits visibly rather than being silently dropped
    assert.deepEqual(store.dependencyStatus(store.requireTask('after-bad')).waitingOn, [{ id: 'bad', state: 'RUNTIME_FAILURE' }]);
    assert.ok(existsSync(join(store.requireTask('ok1').worktreePath!, 'src/ok1.js')) && existsSync(join(store.requireTask('ok2').worktreePath!, 'src/ok2.js')));
  });

  it('an escalated worker frees its slot for queued work and blocks only its own descendants', async () => {
    const outcomes: Record<string, ExecutorOutcome> = { x: { status: 'ESCALATED_TO_CLAUDE', reasons: ['coding_attempts_exhausted'], codingAttempts: 3, runtimeRetries: 0 } };
    const executor = fakeExecutor({ gate: () => sleep(20), behavior: (input) => outcomes[input.task.id] });
    const { store, scheduler } = setup([workerTask('x'), workerTask('y'), workerTask('z'), workerTask('w'), workerTask('child-of-x', { dependsOn: ['x'] })], { executor, config: { maxConcurrentWorkers: 2, maxTasksPerBatch: 10 } });
    const summary = await scheduler.run();
    assert.deepEqual(['y', 'z', 'w'].map((id) => store.requireTask(id).state), ['REVIEW_PENDING', 'REVIEW_PENDING', 'REVIEW_PENDING'], 'the queue drained through the freed slot');
    assert.equal(store.requireTask('x').state, 'ESCALATED');
    assert.equal(store.requireTask('child-of-x').state, 'BLOCKED');
    assert.deepEqual(summary.failed.map((f) => f.id).sort(), ['x']);
  });
});

describe('M7 E: lease expiry and stale workers', () => {
  it('a worker that lost its lease can neither complete the task nor publish a review once it has been re-claimed', async () => {
    let now = 1_000_000;
    const hold1 = barrier(1);
    const hold2 = barrier(1);
    let release1!: () => void;
    let release2!: () => void;
    const gate1 = new Promise<void>((r) => (release1 = r));
    const gate2 = new Promise<void>((r) => (release2 = r));
    const logs: string[] = [];

    const oldExec = fakeExecutor({ gate: async () => (await hold1.wait(), await gate1) });
    const newExec = fakeExecutor({ gate: async () => (await hold2.wait(), await gate2) });
    // 60 s lease: the heartbeat (every 20 s of REAL time) cannot fire during the test, so only the injected clock matters
    const config = { pollMs: 20, workerLeaseTimeoutMs: 60_000 };
    const repo = makeRepo();
    const store = makeStore(() => now);
    store.createBatch(plan(repo, [workerTask('a', { maxClaims: 3 })]));
    store.promote();
    const wt = new WorktreeManager(join(tempDir('mw-wt-'), 'worktrees'));
    const oldSched = new Scheduler({ store, executor: oldExec, workspace: wt, config, log: (l) => logs.push(`old: ${l}`) });
    const newSched = new Scheduler({ store, executor: newExec, workspace: wt, config, log: (l) => logs.push(`new: ${l}`) });

    const oldRun = oldSched.run({ workerPrefix: 'old' });
    while (hold1.arrived() < 1) await sleep(5);
    const first = store.requireTask('a');
    assert.deepEqual([first.state, first.leaseOwner, first.claimEpoch], ['CODING', 'old-w1', 1]);

    now += 120_000; // the old worker stalls past its lease
    assert.deepEqual(store.reapExpired().requeued, ['a']);
    assert.equal(store.heartbeat('a', { owner: 'old-w1', epoch: 1 }, 60_000), false, 'a zombie cannot renew');

    const newRun = newSched.run({ workerPrefix: 'new' });
    while (hold2.arrived() < 1) await sleep(5);
    const second = store.requireTask('a');
    assert.deepEqual([second.state, second.leaseOwner, second.claimEpoch, second.claims], ['CODING', 'new-w1', 2, 2], 'reclaimed: epoch bumped, new owner is CODING');

    // the dangerous window: the stale worker finishes while the NEW owner holds the task in the very same state
    release1();
    await oldRun;
    const mid = store.requireTask('a');
    assert.deepEqual([mid.state, mid.leaseOwner, mid.claimEpoch], ['CODING', 'new-w1', 2], 'the stale completion changed nothing');
    assert.equal(store.listReviews().length, 0, 'the stale worker published no review');
    assert.ok(!store.events('a').some((e) => e.actor === 'old-w1' && ['VERIFYING', 'REVIEW_PENDING', 'RUNTIME_FAILURE', 'ESCALATED'].includes(e.to)), 'no write from the old owner reached the audit trail');
    assert.ok(logs.some((l) => l.startsWith('old:') && /ownership lost; result discarded/.test(l)), logs.join('\n'));

    // the legitimate owner then completes normally
    release2();
    await newRun;
    const done = store.requireTask('a');
    assert.equal(done.state, 'REVIEW_PENDING');
    assert.equal(done.claimEpoch, 2);
    assert.equal(store.listReviews().length, 1);
    assert.equal(store.events('a').filter((e) => e.to === 'REVIEW_PENDING').length, 1);
    assert.equal(store.events('a').find((e) => e.to === 'REVIEW_PENDING')!.actor, 'new-w1');
  });

  it('expired ownership is recovered: the requeued task is claimed again and runs to completion', async () => {
    let now = 5_000;
    const { store, scheduler, worktrees } = setup([workerTask('a')], { now: () => now });
    const dead = store.claim({ workerId: 'dead-w1', languages: ['js'], leaseMs: 100, maxActive: 3 })!;
    const ws = await worktrees.prepare(dead.task, store.getBatch('B1')!);
    store.patchTask('a', { worktreePath: ws.path, branch: ws.branch, baseCommit: ws.baseCommit }, 'dead-w1');
    store.transition('a', 'CODING', { actor: 'dead-w1', fence: dead.fence });
    now += 10_000;
    const summary = await scheduler.run(); // run() reaps expired leases itself
    assert.deepEqual(summary.requeued, ['a']);
    assert.deepEqual(summary.reviewPending, ['a']);
    assert.equal(store.requireTask('a').claimEpoch, 2);
  });

  it('retries respect the claim limit: after maxClaims expiries the task is a RUNTIME_FAILURE, never claimed again, and its dependents are blocked', () => {
    let now = 1;
    const store = makeStore(() => now);
    store.createBatch(plan('/r', [workerTask('a', { maxClaims: 2 }), workerTask('b', { dependsOn: ['a'] })]));
    store.promote();
    for (let i = 0; i < 2; i++) {
      assert.ok(store.claim({ workerId: `w${i}`, languages: ['js'], leaseMs: 10, maxActive: 3 }));
      now += 100;
      store.reapExpired();
    }
    const a = store.requireTask('a');
    assert.deepEqual([a.state, a.failureCategory, a.claims], ['RUNTIME_FAILURE', 'lease_expired', 2]);
    assert.equal(store.claim({ workerId: 'w9', languages: ['js'], leaseMs: 10, maxActive: 3 }), undefined);
    store.promote();
    assert.equal(store.requireTask('b').state, 'BLOCKED', 'a dependency that can never run again must not leave b waiting');
  });
});

describe('M7: logical worker concurrency is NOT model concurrency', () => {
  /**
   * The REAL coding runner (and its machine-wide ModelCapacity) driven by three scheduler workers. Only the model
   * itself is a stub that records how many calls are inside it at once.
   */
  function runnerExecutor(capacity: ModelCapacity, metrics = createMetrics()) {
    const start = barrier(3); // all three tasks reach the runner together, so they contend for the model for real
    let inModel = 0;
    let peakModel = 0;
    const waits: Record<string, number> = {};
    const executor: Executor = {
      async run(input) {
        const id = input.task.id;
        const file = `src/${id}.js`;
        await start.wait();
        const result = await runCodingTask(
          { taskId: id, objective: `write ${id}`, allowedFiles: [file], verificationCommands: [['node', '-e', `process.exit(require('fs').readFileSync(${JSON.stringify(file)},'utf8').includes(${JSON.stringify(id)})?0:1)`]] },
          {
            repoRoot: input.repository,
            capacity,
            metrics,
            signal: input.signal,
            modelLabel: 'stub-model',
            worker: {
              async generate() {
                inModel += 1;
                peakModel = Math.max(peakModel, inModel);
                try {
                  await sleep(150); // "inference"
                  mkdirSync(join(input.repository, 'src'), { recursive: true });
                  writeFileSync(join(input.repository, file), `module.exports = "${id}";\n`);
                  return { text: 'done', finishReason: 'stop', steps: [{}] };
                } finally {
                  inModel -= 1;
                }
              },
            },
          },
        );
        waits[id] = result.records.reduce((a, r) => a + r.capacityWaitMs, 0);
        input.onRunStart({ runId: `run-${id}` });
        return { runId: `run-${id}`, ...PASS, status: result.verdict === 'PASS' ? 'PASS' : 'ESCALATED_TO_CLAUDE', reasons: [], codingAttempts: result.attempts };
      },
    };
    return { executor, peakModel: () => peakModel, waits, metrics };
  }

  it('3 logical workers + 1 model permit: all three tasks are in flight together, but only one is ever inside the model', async () => {
    const capacity = new ModelCapacity(join(tempDir('mw-cap-'), 'cap.db'), { permits: 1, pollMs: 10, leaseMs: 5_000 });
    const probe = runnerExecutor(capacity);
    const peakHolders: number[] = [];
    const sampler = setInterval(() => peakHolders.push(capacity.holders().length), 5);
    const { store, scheduler } = setup([workerTask('a'), workerTask('b'), workerTask('c')], { executor: probe.executor, config: { maxConcurrentWorkers: 3 } });
    try {
      const summary = await scheduler.run();
      assert.equal(summary.peakInFlight, 3, 'logical workers: three tasks in their lifecycle at once');
      assert.deepEqual(summary.reviewPending.sort(), ['a', 'b', 'c']);
      assert.equal(probe.peakModel(), 1, 'model concurrency: one call at a time');
      assert.ok(Math.max(...peakHolders) <= 1, `the lease database never showed more than one holder (${Math.max(...peakHolders)})`);
      assert.equal(capacity.holders().length, 0, 'every permit was released');

      const waited = Object.values(probe.waits);
      assert.equal(waited.filter((w) => w >= 100).length >= 2, true, `at least two of the three queued behind the model: ${JSON.stringify(probe.waits)}`);
      const text = await probe.metrics.render();
      const count = Number(/^model_capacity_wait_seconds_count\{outcome="acquired"\} (\d+)/m.exec(text)?.[1]);
      const sum = Number(/^model_capacity_wait_seconds_sum\{outcome="acquired"\} ([\d.e+-]+)/m.exec(text)?.[1]);
      assert.equal(count, 3, 'one wait observation per model call');
      assert.ok(sum >= 0.25, `waiting is measured separately from inference (${sum}s)`);
      const inference = Number(/^worker_inference_seconds_sum\{worker="stub-model",outcome="ok"\} ([\d.e+-]+)/m.exec(text)?.[1]);
      assert.ok(inference >= 0.4 && inference < 0.75, `inference (${inference}s, ~3 x 150ms) excludes the queueing (${sum}s); including it would be ~0.9s`);
      assert.equal(store.listTasks({ states: ['REVIEW_PENDING'] }).length, 3);
    } finally {
      clearInterval(sampler);
      capacity.close();
    }
  });

  it('the model limit is the capacity database, not the worker count: with 2 permits two calls overlap', async () => {
    const capacity = new ModelCapacity(join(tempDir('mw-cap-'), 'cap.db'), { permits: 2, pollMs: 10, leaseMs: 5_000 });
    const probe = runnerExecutor(capacity);
    const { scheduler } = setup([workerTask('a'), workerTask('b'), workerTask('c')], { executor: probe.executor, config: { maxConcurrentWorkers: 3 } });
    try {
      await scheduler.run();
      assert.equal(probe.peakModel(), 2);
    } finally {
      capacity.close();
    }
  });
});

describe('M7: abort checkpoints (the executor is never started with a dead signal)', () => {
  it('a task timeout that fires while the worktree is still being prepared ends the task as task_timeout without ever starting the executor', async () => {
    const executor = fakeExecutor();
    const { store, worktrees } = setup([workerTask('a')], { executor });
    const slow = Object.create(worktrees) as WorktreeManager; // same manager, but preparation outlasts the task timeout
    slow.prepare = async (...args: Parameters<WorktreeManager['prepare']>) => (await sleep(200), worktrees.prepare(...args));
    const scheduler = new Scheduler({ store, executor, workspace: slow, config: { pollMs: 20, taskTimeoutMs: 50 } });
    await scheduler.run();
    const t = store.requireTask('a');
    assert.deepEqual([t.state, t.failureCategory], ['RUNTIME_FAILURE', 'task_timeout']);
    assert.deepEqual(executor.calls, []);
  });
});

describe('M7 config: AGENTIC_WORKER_CONCURRENCY', () => {
  it('defaults conservatively to one logical worker; the env var sets the pool; garbage and out-of-range values are errors, not silent defaults', () => {
    assert.equal(resolveConfig().maxConcurrentWorkers, 1);
    assert.deepEqual(configFromEnv({}), {});
    assert.deepEqual(configFromEnv({ AGENTIC_WORKER_CONCURRENCY: ' ' }), {});
    assert.equal(resolveConfig(configFromEnv({ AGENTIC_WORKER_CONCURRENCY: '3' })).maxConcurrentWorkers, 3);
    for (const bad of ['three', '2.5', '-1', '0x3']) assert.throws(() => configFromEnv({ AGENTIC_WORKER_CONCURRENCY: bad }), /positive integer/, bad);
    assert.throws(() => resolveConfig(configFromEnv({ AGENTIC_WORKER_CONCURRENCY: '0' })), /positive integer/);
    assert.throws(() => resolveConfig(configFromEnv({ AGENTIC_WORKER_CONCURRENCY: '4' })), /not supported/);
  });

  it('the worker limit is independent of the model limit: no scheduler setting exists for model concurrency', () => {
    assert.equal('maxConcurrentOllamaRequests' in resolveConfig(), false);
  });
});

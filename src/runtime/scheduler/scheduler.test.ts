import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Scheduler, type ExecutorOutcome } from './scheduler.ts';
import { makeRepo, makeStore, plan, fakeExecutor, git, sleep, tempDir, workerTask } from './test-helpers.ts';
import { WorktreeManager } from '../worktree/worktree.ts';

function setup(tasks: ReturnType<typeof workerTask>[], options: { executor?: ReturnType<typeof fakeExecutor>; config?: object; now?: () => number; repoFiles?: Record<string, string>; planExtra?: object } = {}) {
  const repo = makeRepo(options.repoFiles ?? {});
  const store = makeStore(options.now);
  store.createBatch(plan(repo, tasks, options.planExtra));
  store.promote();
  const worktrees = new WorktreeManager(join(tempDir('sched-wt-'), 'worktrees'));
  const executor = options.executor ?? fakeExecutor();
  const scheduler = new Scheduler({ store, executor, workspace: worktrees, config: { pollMs: 20, ...options.config } });
  return { repo, store, worktrees, executor, scheduler };
}

describe('M5.1 sequential execution through the executor', () => {
  it('runs tasks by priority and dependency, persists run ids, and stops at REVIEW_PENDING (never DONE)', async () => {
    const { store, executor, scheduler } = setup([workerTask('low', { priority: 10 }), workerTask('high', { priority: 90 }), workerTask('child', { priority: 99, dependsOn: ['high'] })]);
    const summary = await scheduler.run();
    assert.deepEqual(executor.calls, ['high', 'low'], 'child waits for high to be DONE, which needs review + integration');
    assert.deepEqual(summary.reviewPending.sort(), ['high', 'low']);
    const high = store.requireTask('high');
    assert.equal(high.state, 'REVIEW_PENDING');
    assert.equal(high.runId, 'run-high-1');
    assert.equal(high.attempts, 1);
    assert.match(high.headCommit ?? '', /^[0-9a-f]{40}$/);
    assert.equal(store.requireTask('child').state, 'BACKLOG');
    const review = store.latestReview('high')!;
    assert.equal(review.decision, null);
    assert.match(review.request.diff, /module\.exports = "high"/);
    assert.deepEqual(store.events('high').map((e) => e.to), ['BACKLOG', 'READY', 'CLAIMED', 'CODING', 'CODING', 'VERIFYING', 'REVIEW_PENDING']);
  });

  it('a worker PASS cannot skip review: the scheduler never writes APPROVED/DONE', async () => {
    const { store, scheduler } = setup([workerTask('a')]);
    await scheduler.run();
    assert.ok(!store.events('a').some((e) => ['APPROVED', 'INTEGRATING', 'DONE'].includes(e.to)));
  });

  it('executor tasks run in an isolated worktree on a task branch; the source checkout is untouched', async () => {
    const { repo, store, scheduler, worktrees } = setup([workerTask('a')]);
    writeFileSync(join(repo, 'README.md'), '# user edit in progress\n'); // the user's uncommitted work
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    await scheduler.run();
    const t = store.requireTask('a');
    assert.equal(t.worktreePath, worktrees.taskPath('B1', 'a'));
    assert.ok(existsSync(join(t.worktreePath!, 'src/a.js')));
    assert.equal(existsSync(join(repo, 'src/a.js')), false, 'the worker never wrote into the source checkout');
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# user edit in progress\n', 'uncommitted user changes preserved');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore, 'user branch HEAD unchanged');
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    assert.equal(git(repo, 'rev-parse', 'refs/heads/lead-task/B1/a'), t.headCommit);
    assert.equal(git(repo, 'remote').length, 0, 'nothing configured to push to');
  });

  it('refuses to start from a stale base: uncommitted edits to a task file BLOCK the task', async () => {
    const { repo, store, scheduler, executor } = setup([workerTask('a', { files: ['src/a.js'] })], { repoFiles: { 'src/a.js': 'old\n' } });
    writeFileSync(join(repo, 'src/a.js'), 'uncommitted edit\n');
    await scheduler.run();
    assert.equal(executor.calls.length, 0);
    const t = store.requireTask('a');
    assert.equal(t.state, 'BLOCKED');
    assert.equal(t.failureCategory, 'source_tree_dirty');
    assert.equal(readFileSync(join(repo, 'src/a.js'), 'utf8'), 'uncommitted edit\n');
  });

  it('maps runner outcomes: exhausted -> ESCALATED, forbidden mutation -> ESCALATED/forbidden_mutation, runtime -> RUNTIME_FAILURE, gate refusal -> ESCALATED/not_eligible', async () => {
    const outcomes: Record<string, ExecutorOutcome> = {
      ex: { status: 'ESCALATED_TO_CLAUDE', reasons: ['coding_attempts_exhausted'], codingAttempts: 3, runtimeRetries: 0, failureCategory: 'C_wrong_implementation' },
      fm: { status: 'ESCALATED_TO_CLAUDE', reasons: ['forbidden_mutation'], codingAttempts: 1, runtimeRetries: 0, failureCategory: 'D_forbidden_mutation' },
      rt: { status: 'RUNTIME_FAILURE', reasons: ['ollama down'], codingAttempts: 0, runtimeRetries: 1 },
      ke: { status: 'KEPT_BY_CLAUDE', reasons: ['not delegable'], codingAttempts: 0, runtimeRetries: 0 },
    };
    const executor = fakeExecutor({ behavior: (input) => outcomes[input.task.id] });
    const { store, scheduler } = setup(['ex', 'fm', 'rt', 'ke'].map((id) => workerTask(id)), { executor });
    await scheduler.run();
    const get = (id: string) => store.requireTask(id);
    assert.deepEqual([get('ex').state, get('ex').failureCategory, get('ex').attempts], ['ESCALATED', 'coding_attempts_exhausted', 3]);
    assert.deepEqual([get('fm').state, get('fm').failureCategory], ['ESCALATED', 'forbidden_mutation']);
    assert.deepEqual([get('rt').state, get('rt').failureCategory, get('rt').runtimeRetries], ['RUNTIME_FAILURE', 'runtime_unavailable', 1]);
    assert.deepEqual([get('ke').state, get('ke').failureCategory], ['ESCALATED', 'not_eligible']);
  });

  it('blocks the dependents of an escalated task (dependency failure)', async () => {
    const executor = fakeExecutor({ behavior: (i) => (i.task.id === 'dep' ? { status: 'ESCALATED_TO_CLAUDE', reasons: ['x'], codingAttempts: 3, runtimeRetries: 0 } : undefined) });
    const { store, scheduler } = setup([workerTask('dep'), workerTask('child', { dependsOn: ['dep'] })], { executor });
    await scheduler.run();
    assert.equal(store.requireTask('child').state, 'BLOCKED');
    assert.match(store.requireTask('child').stateReason ?? '', /dependency dep is ESCALATED/);
  });

  it('a post-run change gate (out-of-scope file) escalates instead of reaching review, and keeps the worktree as evidence', async () => {
    const executor = fakeExecutor({
      behavior: (input) => {
        mkdirSync(join(input.repository, 'src'), { recursive: true });
        writeFileSync(join(input.repository, 'src/a.js'), 'module.exports = 1;\n');
        writeFileSync(join(input.repository, 'src/sneaky.js'), 'x\n');
        return { status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0 };
      },
    });
    const { store, scheduler } = setup([workerTask('a')], { executor });
    await scheduler.run();
    const t = store.requireTask('a');
    assert.equal(t.state, 'ESCALATED');
    assert.equal(t.failureCategory, 'review_gate_blocked');
    assert.ok(existsSync(join(t.worktreePath!, 'src/sneaky.js')), 'evidence preserved');
    assert.equal(store.listReviews().length, 0);
  });

  it('a PASS with no change to the allowed files is rejected (no fabricated PASS)', async () => {
    const executor = fakeExecutor({ behavior: () => ({ status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0 }) });
    const { store, scheduler } = setup([workerTask('a')], { executor });
    await scheduler.run();
    assert.equal(store.requireTask('a').state, 'ESCALATED');
    assert.equal(store.requireTask('a').failureCategory, 'review_gate_blocked');
  });

  it('an executor exception becomes RUNTIME_FAILURE, which resume can requeue only within the claim budget', async () => {
    const executor = fakeExecutor({ behavior: () => { throw new Error('boom'); } });
    const { store, scheduler } = setup([workerTask('a', { maxClaims: 2 })], { executor });
    await scheduler.run();
    assert.equal(store.requireTask('a').state, 'RUNTIME_FAILURE');
    assert.equal(store.requireTask('a').failureCategory, 'executor_error');
  });

  it('enforces taskTimeout: the executor is aborted and the task is a task_timeout RUNTIME_FAILURE', async () => {
    const executor = fakeExecutor({ gate: (input) => new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    const { store, scheduler } = setup([workerTask('a')], { executor, config: { taskTimeoutMs: 80 } });
    await scheduler.run();
    assert.equal(store.requireTask('a').failureCategory, 'task_timeout');
  });

  it('maxTasksPerBatch caps how many distinct tasks a batch may claim', async () => {
    const { store, executor, scheduler } = setup(['a', 'b', 'c', 'd'].map((id) => workerTask(id)), { config: { maxTasksPerBatch: 2 } });
    await scheduler.run();
    assert.equal(executor.calls.length, 2);
    assert.equal(store.listTasks({ states: ['READY'] }).length, 2);
  });
});

describe('batch base and snapshotPaths', () => {
  it('snapshotPaths exposes listed uncommitted files (modified AND untracked) to workers without touching the user checkout, branch or index', async () => {
    const seen: Record<string, string | null> = {};
    const executor = fakeExecutor({
      behavior: (input) => {
        for (const f of ['src/store.js', 'src/recover.js', 'src/private.js']) seen[f] = existsSync(join(input.repository, f)) ? readFileSync(join(input.repository, f), 'utf8') : null;
        return undefined;
      },
    });
    const task = workerTask('a');
    task.request!.contract.contextFiles = ['src/store.js', 'src/recover.js'];
    const { repo, scheduler, store } = setup([task], { executor, repoFiles: { 'src/store.js': 'committed\n' }, planExtra: { snapshotPaths: ['src/store.js', 'src/recover.js'] } });
    writeFileSync(join(repo, 'src/store.js'), 'user WIP edit\n'); // modified, uncommitted
    writeFileSync(join(repo, 'src/recover.js'), 'user WIP new file\n'); // untracked
    writeFileSync(join(repo, 'src/private.js'), 'secret scratch\n'); // untracked, NOT listed
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const statusBefore = git(repo, 'status', '--porcelain');
    const indexBefore = git(repo, 'diff', '--cached', '--name-only');
    await scheduler.run();
    assert.equal(store.requireTask('a').state, 'REVIEW_PENDING');
    assert.deepEqual(seen, { 'src/store.js': 'user WIP edit\n', 'src/recover.js': 'user WIP new file\n', 'src/private.js': null }, 'listed files visible, unlisted scratch invisible');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(git(repo, 'status', '--porcelain'), statusBefore, 'user working tree and index unchanged');
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), indexBefore);
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    assert.equal(git(repo, 'show', 'refs/lead/base/B1:src/store.js'), 'user WIP edit');
    assert.equal(git(repo, 'rev-parse', 'refs/lead/base/B1^'), headBefore, 'the base is HEAD plus the snapshot, nothing else');
    assert.throws(() => git(repo, 'cat-file', '-e', 'refs/lead/base/B1:src/private.js'));
  });

  it('a file the user edits AFTER the base was cut is stale: the task is BLOCKED instead of running on old content', async () => {
    const a = workerTask('a');
    const b = workerTask('b');
    b.request!.contract.contextFiles = ['src/store.js'];
    const { repo, store, worktrees, executor } = setup([a, b], { repoFiles: { 'src/store.js': 'v0\n' }, planExtra: {} });
    const first = new Scheduler({ store, executor, workspace: worktrees, config: { pollMs: 20, maxTasksPerBatch: 1 } });
    await first.run(); // runs a only (fixes the batch base at v0)
    assert.deepEqual(executor.calls, ['a']);
    writeFileSync(join(repo, 'src/store.js'), 'v1 edited after the base was cut\n');
    const second = new Scheduler({ store, executor, workspace: worktrees, config: { pollMs: 20, maxTasksPerBatch: 5 } });
    await second.run();
    const t = store.requireTask('b');
    assert.equal(t.state, 'BLOCKED');
    assert.equal(t.failureCategory, 'source_tree_dirty');
    assert.match(t.stateReason ?? '', /src\/store\.js/);
    assert.deepEqual(executor.calls, ['a'], 'the worker never ran on stale content');
  });
});

describe('M5.2 parallel workers and isolation', () => {
  it('two workers run disjoint tasks concurrently in separate worktrees (maxConcurrentWorkers=2)', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const arrived: string[] = [];
    const executor = fakeExecutor({
      gate: async (input) => {
        arrived.push(input.task.id);
        if (arrived.length === 2) release();
        await hold; // both must be in flight at once, or this deadlocks and the test times out
      },
    });
    const { store, scheduler } = setup([workerTask('a'), workerTask('b')], { executor, config: { maxConcurrentWorkers: 2 } });
    const summary = await scheduler.run();
    assert.equal(executor.peak(), 2);
    assert.equal(summary.peakInFlight, 2);
    const [a, b] = [store.requireTask('a'), store.requireTask('b')];
    assert.notEqual(a.worktreePath, b.worktreePath);
    assert.ok(existsSync(join(a.worktreePath!, 'src/a.js')) && !existsSync(join(a.worktreePath!, 'src/b.js')), 'no cross-contamination');
    assert.notEqual(a.assignedWorker, b.assignedWorker);
  });

  it('tasks with overlapping files never run concurrently', async () => {
    const executor = fakeExecutor({ gate: () => sleep(30) });
    const { scheduler } = setup([workerTask('a', { files: ['src/shared.js'] }), workerTask('b', { files: ['src/shared.js'] })], { executor, config: { maxConcurrentWorkers: 2 } });
    const s = await scheduler.run();
    assert.equal(executor.peak(), 1);
    assert.deepEqual(s.claimed, ['a'], 'b stays READY until a releases its files by being integrated or rejected');
  });

  it('rejects unsupported worker counts', () => {
    assert.throws(() => setup([workerTask('a')], { config: { maxConcurrentWorkers: 4 } }), /not supported/);
  });
});

describe('crash recovery', () => {
  it('a worker that died mid-run: lease expires, the task is requeued, and the next run completes it in a clean worktree', async () => {
    let now = 1_000;
    const { store, scheduler, worktrees, repo } = setup([workerTask('a')], { now: () => now });
    // simulate a crashed scheduler: claim + prepare + CODING + partial work, then nothing
    const claim = store.claim({ workerId: 'dead', languages: ['js'], leaseMs: 100, maxActive: 1 })!;
    const ws = await worktrees.prepare(claim.task, store.getBatch('B1')!);
    store.patchTask('a', { worktreePath: ws.path, branch: ws.branch, baseCommit: ws.baseCommit }, 'dead');
    store.transition('a', 'CODING', { actor: 'dead', fence: claim.fence });
    mkdirSync(join(ws.path, 'src'), { recursive: true });
    writeFileSync(join(ws.path, 'src/a.js'), 'half-written garbage\n');
    writeFileSync(join(ws.path, 'src/leftover.js'), 'junk\n');
    now += 10_000;
    const r = scheduler.recover();
    assert.deepEqual(r.requeued, ['a']);
    const s = await scheduler.run();
    assert.deepEqual(s.reviewPending, ['a']);
    const t = store.requireTask('a');
    assert.equal(t.claims, 2);
    assert.equal(t.claimEpoch, 2);
    assert.equal(existsSync(join(t.worktreePath!, 'src/leftover.js')), false, 'stale files from the crashed run were cleaned (worktree verified as ours first)');
    assert.equal(readFileSync(join(t.worktreePath!, 'src/a.js'), 'utf8'), 'module.exports = "a";\n');
    assert.equal(existsSync(join(repo, 'src/leftover.js')), false);
  });

  it('lost workflow response: the previous Mastra run is adopted, not executed a second time', async () => {
    let now = 1_000;
    const calls: string[] = [];
    const executor = fakeExecutor();
    executor.reconcile = async ({ runId }) => {
      calls.push(`reconcile:${runId}`);
      return { runId, status: 'PASS', reasons: [], codingAttempts: 2, runtimeRetries: 0 };
    };
    const { store, scheduler, worktrees } = setup([workerTask('a')], { now: () => now, executor });
    const claim = store.claim({ workerId: 'dead', languages: ['js'], leaseMs: 100, maxActive: 1 })!;
    const ws = await worktrees.prepare(claim.task, store.getBatch('B1')!);
    store.patchTask('a', { worktreePath: ws.path, branch: ws.branch, baseCommit: ws.baseCommit }, 'dead');
    store.transition('a', 'CODING', { actor: 'dead', fence: claim.fence });
    store.recordRun('a', claim.fence, 'mastra-run-lost');
    // the Mastra run actually finished while the scheduler was down: its change is sitting in the worktree
    mkdirSync(join(ws.path, 'src'), { recursive: true });
    writeFileSync(join(ws.path, 'src/a.js'), 'module.exports = "from-lost-run";\n');
    now += 10_000;
    scheduler.recover();
    await scheduler.run();
    assert.deepEqual(calls, ['reconcile:mastra-run-lost']);
    assert.equal(executor.calls.length, 0, 'executor.run was NOT called again');
    assert.equal(store.requireTask('a').state, 'REVIEW_PENDING');
    assert.equal(store.requireTask('a').attempts, 2);
    assert.deepEqual(store.requireTask('a').runIds, ['mastra-run-lost']);
    assert.match(store.latestReview('a')!.request.diff, /from-lost-run/, 'the adopted run\'s work was NOT wiped by the re-claim reset');
  });

  it('duplicate completion: a second completion for the same claim is rejected and changes nothing', async () => {
    const { store, scheduler } = setup([workerTask('a')]);
    await scheduler.run();
    const before = store.requireTask('a');
    const fence = { owner: before.assignedWorker!, epoch: before.claimEpoch };
    await assert.rejects(scheduler.complete('a', fence, { status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0 }, 0), /not allowed|expected|owned/);
    const after = store.requireTask('a');
    assert.equal(after.state, 'REVIEW_PENDING');
    assert.equal(after.attempts, before.attempts);
    assert.equal(store.listReviews().length, 1);
  });

  it('scheduler restart: a second Scheduler on the same DB does not redo finished work', async () => {
    const { store, scheduler, repo } = setup([workerTask('a'), workerTask('b')]);
    await scheduler.run();
    const executor2 = fakeExecutor();
    const scheduler2 = new Scheduler({ store, executor: executor2, workspace: new WorktreeManager(join(tempDir(), 'wt')), config: { pollMs: 20 } });
    const s = await scheduler2.run();
    assert.deepEqual(executor2.calls, []);
    assert.deepEqual(s.claimed, []);
    void repo;
  });

  it('stealLeases recovers tasks whose lease has not expired (operator knows the old process is gone)', async () => {
    const { store, scheduler } = setup([workerTask('a')]);
    store.claim({ workerId: 'dead', languages: ['js'], leaseMs: 3_600_000, maxActive: 1 });
    assert.deepEqual(scheduler.recover().requeued, []);
    assert.deepEqual(scheduler.recover({ stealLeases: true }).requeued, ['a']);
    assert.equal(store.requireTask('a').state, 'READY');
  });
});

describe('cancellation', () => {
  it('cancelling a running task aborts it, discards its late result, and blocks dependents', async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const executor = fakeExecutor({
      gate: (input) =>
        new Promise<void>((resolve) => {
          started();
          input.signal.addEventListener('abort', () => resolve());
          setTimeout(resolve, 2000);
        }),
    });
    const { store, scheduler } = setup([workerTask('a'), workerTask('b', { dependsOn: ['a'] })], { executor, config: { workerLeaseTimeoutMs: 300 } });
    const running = scheduler.run();
    await startedP;
    store.transition('a', 'CANCELLED', { actor: 'human', reason: 'user cancelled' });
    await running;
    assert.equal(store.requireTask('a').state, 'CANCELLED');
    assert.equal(store.listReviews().length, 0, 'a cancelled task never produces a review');
    store.promote();
    assert.equal(store.requireTask('b').state, 'BLOCKED');
  });
});

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WorktreeManager } from '../worktree/worktree.ts';
import { Scheduler } from './scheduler.ts';
import { fakeExecutor, makeRepo, makeStore, plan, sleep, tempDir, workerTask } from './test-helpers.ts';

/**
 * A stalled worker (host asleep, event loop blocked) loses its lease; the same run() re-claims the task. The superseded
 * execution later finishes ("ownership lost; result discarded"). That must not end run() while the re-claimed execution is
 * still working: found in the first real M7.5 -> M7 experiment, where run() returned with two tasks mid-flight and the
 * process then closed the database under them.
 */
describe('a task requeued and re-claimed inside one run()', () => {
  it('run() keeps waiting for the re-claimed execution after the superseded one finishes', async () => {
    let clock = 1_000_000;
    const store = makeStore(() => clock);
    const repo = makeRepo();
    store.createBatch(plan(repo, [workerTask('a')]));
    store.promote();
    const releases: (() => void)[] = [];
    const executor = fakeExecutor({
      gate: () => new Promise<void>((resolve) => releases.push(resolve)),
    });
    const worktrees = new WorktreeManager(join(tempDir('requeue-wt-'), 'worktrees'));
    // a long lease keeps the real heartbeat timer out of the way: the lease is expired by moving the fake clock
    const scheduler = new Scheduler({ store, executor, workspace: worktrees, config: { pollMs: 20, workerLeaseTimeoutMs: 60_000, maxConcurrentWorkers: 2 } });

    let finished = false;
    const running = scheduler.run().then((s) => ((finished = true), s));
    while (releases.length < 1) await sleep(10);
    clock += 10 * 60_000; // the first execution's lease has now expired
    while (releases.length < 2) await sleep(10); // the scheduler reaped, requeued and re-claimed it (epoch 2)
    assert.equal(store.requireTask('a').claimEpoch, 2);

    releases[0](); // the superseded execution finishes; its result is discarded by the fence
    await sleep(300);
    assert.equal(finished, false, 'run() ended while the re-claimed execution was still in flight');

    releases[1]();
    const summary = await running;
    assert.equal(store.requireTask('a').state, 'REVIEW_PENDING');
    assert.deepEqual(summary.reviewPending, ['a']);
    store.close();
  });
});

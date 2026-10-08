import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { reviewDecision } from '../../lead/review.ts';
import { Scheduler } from '../scheduler/scheduler.ts';
import type { SchedulerStore } from '../scheduler/store.ts';
import { barrier, fakeExecutor, git, makeRepo, makeStore, plan, sleep, tempDir, workerTask } from '../scheduler/test-helpers.ts';
import { WorktreeManager } from '../worktree/worktree.ts';
import { integrateBatch, type CommandRunner } from './integrate.ts';

/**
 * M7 G: concurrently produced work integrates deterministically, and changes that are individually valid but do not
 * work together end in an evidenced escalation, never in a silent overwrite or an invented resolution.
 */

const approve = (store: SchedulerStore, id: string) => reviewDecision(store, { maxReviewCorrections: 2 }, { taskId: id, decision: 'APPROVED', feedback: 'lgtm' });
const gitx = (cwd: string, ...a: string[]) => git(cwd, '-c', 'user.name=x', '-c', 'user.email=x@x', ...a);

/**
 * The "oracle" for this batch: each task's own test passes, but the COMBINED tree must not have two modules claiming the
 * same port. This is the shape of a real post-merge failure: two valid changes that cannot coexist.
 */
const portOracle: CommandRunner = async (command, cwd) => {
  if (command[0] !== 'go') return { exitCode: 0, output: 'task test ok', timedOut: false }; // the tasks' own (passing) tests
  const port = (f: string) => (existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), 'utf8').trim() : null);
  const [a, b] = [port('src/a.js'), port('src/b.js')];
  return a !== null && a === b ? { exitCode: 1, output: `FAIL: src/a.js and src/b.js both claim ${a}\n`, timedOut: false } : { exitCode: 0, output: 'ok', timedOut: false };
};

/** Two independent tasks produced concurrently; `order` decides which finishes (and is approved) first. */
async function twoConcurrentTasks(order: ['a', 'b'] | ['b', 'a'], options: { content?: (id: string) => string; planExtra?: object; extraTasks?: ReturnType<typeof workerTask>[] } = {}) {
  const repo = makeRepo();
  const store = makeStore();
  store.createBatch(plan(repo, [workerTask('a'), workerTask('b'), ...(options.extraTasks ?? [])], { integrationCommands: [['go', 'test', './...']], ...options.planExtra }));
  store.promote();
  const worktrees = new WorktreeManager(join(tempDir('int-wt-'), 'worktrees'));
  // the finish order is enforced, not timed: both tasks are inside the executor together, then the second is held until the first is in review
  const both = barrier(2);
  const executor = fakeExecutor({
    gate: async (input) => {
      await both.wait();
      if (input.task.id !== order[0]) while (store.requireTask(order[0]).state !== 'REVIEW_PENDING') await sleep(5);
    },
    content: options.content ?? ((id) => `module.exports = ${id === 'a' || id === 'b' ? 8080 : 9090};\n`),
  });
  const scheduler = new Scheduler({ store, executor, workspace: worktrees, config: { pollMs: 10, maxConcurrentWorkers: 3, maxTasksPerBatch: 10 } });
  await scheduler.run();
  const finishedOrder = store
    .listTasks({ states: ['REVIEW_PENDING'] })
    .sort((x, y) => store.events(x.id).find((e) => e.to === 'REVIEW_PENDING')!.seq - store.events(y.id).find((e) => e.to === 'REVIEW_PENDING')!.seq)
    .map((t) => t.id);
  return { repo, store, worktrees, finishedOrder };
}

describe('M7 G: deterministic integration of concurrently completed work', () => {
  for (const order of [['a', 'b'], ['b', 'a']] as const) {
    it(`two individually valid changes conflict semantically (${order.join(' finishes before ')}): the same one is escalated, the branch is the same, and nothing is overwritten`, async () => {
      const { store, worktrees, finishedOrder } = await twoConcurrentTasks([...order]);
      assert.deepEqual(finishedOrder.filter((id) => id === 'a' || id === 'b'), [...order], 'the workers really did finish in the intended order');
      for (const id of order) approve(store, id); // approved in completion order, which is NOT the integration order for b-first

      const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: portOracle });
      assert.deepEqual(reports.map((r) => [r.taskId, r.outcome]), [['a', 'DONE'], ['b', 'ESCALATED']], 'integration order is by (priority, creation, id), not by completion order');

      const iw = worktrees.integrationPath('B1');
      assert.equal(reports[1].category, 'integration_verification_failed');
      assert.match(reports[1].commands!.at(-1)!.tail, /both claim module\.exports = 8080;/);
      const b = store.requireTask('b');
      assert.equal(b.state, 'ESCALATED');
      assert.deepEqual((b.artifacts.integration as any).integratedBefore, ['a'], 'the evidence names what b failed to coexist with');
      assert.ok(existsSync(join(b.worktreePath!, 'src/b.js')), "b's work is preserved for the Lead");

      // rollback is exact: only a is on the branch, the tree is clean and the final state passes the batch oracle
      assert.equal(existsSync(join(iw, 'src/b.js')), false);
      assert.equal(git(iw, 'status', '--porcelain'), '');
      assert.equal(git(iw, 'log', '--merges', '--format=%s'), 'integrate a: Task a');
      assert.equal((await portOracle(['go', 'test', './...'], iw)).exitCode, 0, 'the final integrated state passes the required verification');
      assert.equal(store.requireTask('a').state, 'DONE');
    });
  }

  it('the resulting integration tree is identical whichever task finished first', async () => {
    const trees: string[] = [];
    const states: string[] = [];
    for (const order of [['a', 'b'], ['b', 'a']] as const) {
      const { store, worktrees } = await twoConcurrentTasks([...order], { content: (id) => `module.exports = "${id}";\n` }); // no conflict this time
      for (const id of order) approve(store, id);
      const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: portOracle });
      assert.deepEqual(reports.map((r) => r.outcome), ['DONE', 'DONE']);
      trees.push(git(worktrees.integrationPath('B1'), 'rev-parse', 'HEAD^{tree}'));
      states.push(['a', 'b'].map((id) => store.requireTask(id).state).join());
    }
    assert.equal(trees[0], trees[1], 'same merged tree');
    assert.deepEqual(states, ['DONE,DONE', 'DONE,DONE']);
  });

  it('a textual merge conflict is escalated with the evidence the Lead needs, and is never resolved automatically', async () => {
    const { store, worktrees, repo } = await twoConcurrentTasks(['a', 'b'], { content: (id) => `module.exports = "${id}";\n`, extraTasks: [workerTask('after-b', { dependsOn: ['b'], files: ['src/after-b.js'] })] });
    for (const id of ['a', 'b']) approve(store, id);

    // meanwhile a direct commit lands on the integration branch touching the file b owns (e.g. a Lead hot-fix)
    const iw = (await worktrees.integrationWorktree(store.getBatch('B1')!)).path;
    mkdirSync(join(iw, 'src'), { recursive: true });
    writeFileSync(join(iw, 'src/b.js'), 'module.exports = "hot-fix by the lead";\n');
    gitx(iw, 'add', '-A');
    gitx(iw, 'commit', '-q', '-m', 'hotfix: b.js');

    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: portOracle });
    assert.deepEqual(reports.map((r) => [r.taskId, r.outcome]), [['a', 'DONE'], ['b', 'ESCALATED']]);
    const report = reports[1];
    assert.equal(report.category, 'integration_conflict');

    const evidence = report.conflict!;
    assert.deepEqual(evidence.files, ['src/b.js']);
    assert.equal(evidence.taskHead, store.requireTask('b').headCommit);
    assert.match(evidence.integratedSince[0].commits.join('\n'), /hotfix: b\.js/, 'names the commit that landed first');
    assert.match(evidence.markers[0].excerpt, /<<<<<<<[\s\S]*hot-fix by the lead[\s\S]*=======[\s\S]*module\.exports = "b"[\s\S]*>>>>>>>/, 'both sides of the hunk are preserved');
    assert.equal(evidence.integrationTip, git(iw, 'rev-parse', 'HEAD'), 'the branch is back at exactly the tip the merge started from');

    // persisted on the task, so it outlives the process; the Lead reads it from the database
    const persisted = (store.requireTask('b').artifacts.integration as any).conflict;
    assert.deepEqual(persisted.files, ['src/b.js']);
    assert.deepEqual((store.requireTask('b').artifacts.integration as any).integratedBefore, ['a']);

    // no silent overwrite, no invented resolution, no merge left half-done
    assert.equal(readFileSync(join(iw, 'src/b.js'), 'utf8'), 'module.exports = "hot-fix by the lead";\n');
    assert.equal(git(iw, 'status', '--porcelain'), '');
    assert.equal(existsSync(join(iw, git(iw, 'rev-parse', '--git-path', 'MERGE_HEAD'))), false, 'no merge in progress');
    assert.equal(store.requireTask('after-b').state, 'BLOCKED', "b's dependent is blocked with a reason, not left waiting");
    assert.match(store.requireTask('after-b').stateReason ?? '', /dependency b is ESCALATED/);
    assert.equal(git(repo, 'branch', '--show-current'), 'main', 'the source checkout is untouched');
  });

  it('a dependent whose prerequisites are not integrated is skipped loudly, not integrated out of order', async () => {
    const repo = makeRepo();
    const store = makeStore();
    store.createBatch(plan(repo, [workerTask('base'), workerTask('top', { dependsOn: ['base'] })]));
    store.promote();
    const worktrees = new WorktreeManager(join(tempDir('int-wt-'), 'worktrees'));
    // an inconsistent state a bug or a manual edit could produce: the dependent is APPROVED while its prerequisite is not DONE
    store.db.prepare("UPDATE tasks SET state = 'APPROVED' WHERE id = 'top'").run();
    const logs: string[] = [];
    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: async () => ({ exitCode: 0, output: '', timedOut: false }), log: (l) => logs.push(l) });
    assert.deepEqual(reports.map((r) => [r.taskId, r.outcome]), [['top', 'SKIPPED']]);
    assert.match(reports[0].detail ?? '', /base \(READY\)/);
    assert.equal(store.requireTask('top').state, 'APPROVED', 'untouched');
    assert.ok(logs.some((l) => /skipped top/.test(l)));
  });
});

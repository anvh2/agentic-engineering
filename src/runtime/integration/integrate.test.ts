import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { integrateBatch, type CommandRunner } from './integrate.ts';
import { pendingReviews, renderReviewPack, reviewDecision, startClaudeTask, takeOverEscalated } from '../../lead/review.ts';
import { Scheduler, type ExecutorOutcome } from '../scheduler/scheduler.ts';
import { fakeExecutor, git, makeRepo, makeStore, plan, tempDir, workerTask } from '../scheduler/test-helpers.ts';
import { WorktreeManager } from '../worktree/worktree.ts';

const passRunner: CommandRunner = async () => ({ exitCode: 0, output: 'ok', timedOut: false });

function setup(tasks: ReturnType<typeof workerTask>[], options: { executor?: ReturnType<typeof fakeExecutor>; repoFiles?: Record<string, string>; planExtra?: object; config?: object } = {}) {
  const repo = makeRepo(options.repoFiles ?? {});
  const store = makeStore();
  store.createBatch(plan(repo, tasks, options.planExtra));
  store.promote();
  const worktrees = new WorktreeManager(join(tempDir('sched-wt-'), 'worktrees'));
  const scheduler = new Scheduler({ store, executor: options.executor ?? fakeExecutor(), workspace: worktrees, config: { pollMs: 20, ...options.config } });
  return { repo, store, worktrees, scheduler };
}
const approve = (store: ReturnType<typeof makeStore>, id: string) => reviewDecision(store, { maxReviewCorrections: 2 }, { taskId: id, decision: 'APPROVED', feedback: 'lgtm' });

describe('M5.3 review queue', () => {
  it('review is the only path to APPROVED; the decision is recorded once', async () => {
    const { store, scheduler } = setup([workerTask('a')]);
    await scheduler.run();
    assert.equal(pendingReviews(store).length, 1);
    assert.match(renderReviewPack(store), /## a: Task a/);
    approve(store, 'a');
    assert.equal(store.requireTask('a').state, 'APPROVED');
    assert.equal(store.requireTask('a').reviewOutcome, 'APPROVED');
    assert.throws(() => approve(store, 'a'), /not REVIEW_PENDING/, 'no duplicate decision');
    assert.equal(pendingReviews(store).length, 0);
  });

  it('rejection with feedback creates a bounded correction task that supersedes the original; dependents follow it', async () => {
    const { store, scheduler } = setup([workerTask('a'), workerTask('child', { dependsOn: ['a'] })]);
    await scheduler.run();
    const r = reviewDecision(store, { maxReviewCorrections: 2 }, { taskId: 'a', decision: 'REJECTED_WITH_FEEDBACK', feedback: 'handle null input' });
    assert.equal(r.correctionId, 'a-fix1');
    assert.equal(store.requireTask('a').state, 'REVIEW_REJECTED');
    assert.equal(store.requireTask('a').supersededBy, 'a-fix1');
    const fix = store.requireTask('a-fix1');
    assert.equal(fix.state, 'READY', 'promoted immediately; its files are free because the rejected task released them');
    assert.match(fix.spec.request!.contract.objective, /handle null input/);
    assert.equal(fix.corrections, 1);
    assert.equal(store.requireTask('child').state, 'BACKLOG', 'child waits on the correction, not blocked by the rejection');
  });

  it('corrections are bounded: after maxReviewCorrections the task is ESCALATED, never retried forever', async () => {
    const { store, scheduler } = setup([workerTask('a')]);
    const config = { maxReviewCorrections: 2 };
    await scheduler.run();
    reviewDecision(store, config, { taskId: 'a', decision: 'REJECTED_WITH_FEEDBACK', feedback: 'one' });
    await scheduler.run();
    reviewDecision(store, config, { taskId: 'a-fix1', decision: 'REJECTED_WITH_FEEDBACK', feedback: 'two' });
    await scheduler.run();
    const last = reviewDecision(store, config, { taskId: 'a-fix2', decision: 'REJECTED_WITH_FEEDBACK', feedback: 'three' });
    assert.equal(last.correctionId, undefined);
    const t = store.requireTask('a-fix2');
    assert.equal(t.state, 'ESCALATED');
    assert.equal(t.failureCategory, 'review_rejected');
    assert.match(t.stateReason ?? '', /budget/);
    assert.equal(store.listTasks().filter((x) => x.state === 'READY').length, 0);
  });

  it('a rejection must carry feedback; ESCALATED_TO_HUMAN escalates', async () => {
    const { store, scheduler } = setup([workerTask('a'), workerTask('b')]);
    await scheduler.run();
    assert.throws(() => reviewDecision(store, { maxReviewCorrections: 2 }, { taskId: 'a', decision: 'REJECTED_WITH_FEEDBACK' }), /feedback/);
    assert.equal(store.requireTask('a').state, 'REVIEW_PENDING', 'a failed decision changes nothing (atomic)');
    reviewDecision(store, { maxReviewCorrections: 2 }, { taskId: 'b', decision: 'ESCALATED_TO_HUMAN', feedback: 'needs product call' });
    assert.equal(store.requireTask('b').state, 'ESCALATED');
    assert.equal(store.requireTask('b').failureCategory, 'escalated_by_reviewer');
  });
});

describe('M5.3 integration', () => {
  it('integrates an approved task into the integration branch only, commits its oracle as a permanent test, then DONE', async () => {
    const { repo, store, worktrees, scheduler } = setup([workerTask('a')]);
    await scheduler.run();
    approve(store, 'a');
    const ran: string[][] = [];
    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: async (c) => (ran.push(c), { exitCode: 0, output: '', timedOut: false }) });
    assert.deepEqual(reports.map((r) => r.outcome), ['DONE']);
    assert.equal(store.requireTask('a').state, 'DONE');
    assert.equal(store.requireTask('a').implementedBy, 'worker');
    assert.deepEqual(ran, [['npx', '--no-install', 'jest', '--runInBand', 'tests/a.test.js']]);
    const iw = worktrees.integrationPath('B1');
    assert.equal(readFileSync(join(iw, 'src/a.js'), 'utf8'), 'module.exports = "a";\n');
    assert.ok(existsSync(join(iw, 'tests/a.test.js')), 'oracle persisted as a permanent test');
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    assert.equal(existsSync(join(repo, 'src/a.js')), false, 'the user checkout is untouched');
    assert.match(git(repo, 'log', '--oneline', 'lead-integration/B1'), /integrate a/);
    assert.equal(git(repo, 'log', '--oneline', 'main').split('\n').length, 1, 'main has no new commits');
  });

  it('only APPROVED tasks integrate; REVIEW_PENDING is left alone', async () => {
    const { store, worktrees, scheduler } = setup([workerTask('a'), workerTask('b')]);
    await scheduler.run();
    approve(store, 'a');
    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.deepEqual(reports.map((r) => r.taskId), ['a']);
    assert.equal(store.requireTask('b').state, 'REVIEW_PENDING');
  });

  it('a DONE task is never integrated twice', async () => {
    const { store, worktrees, scheduler } = setup([workerTask('a')]);
    await scheduler.run();
    approve(store, 'a');
    await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    const again = await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.deepEqual(again.reports, []);
    assert.equal(store.requireTask('a').state, 'DONE');
  });

  it('dependent tasks only start after the dependency is integrated, and are built on top of it', async () => {
    const { store, worktrees, scheduler } = setup([workerTask('a'), workerTask('b', { dependsOn: ['a'], files: ['src/b.js'] })]);
    const seen: string[] = [];
    const executor = fakeExecutor({ behavior: (input) => (seen.push(existsSync(join(input.repository, 'src/a.js')) ? `${input.task.id}:sees-a` : `${input.task.id}:no-a`), undefined) });
    const sched = new Scheduler({ store, executor, workspace: worktrees, config: { pollMs: 20 } });
    await sched.run();
    assert.deepEqual(seen, ['a:no-a']);
    approve(store, 'a');
    await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.equal(store.requireTask('b').state, 'READY');
    await sched.run();
    assert.deepEqual(seen, ['a:no-a', 'b:sees-a']);
    void scheduler;
  });

  it('a merge conflict is detected, the integration branch is restored exactly, and the task is ESCALATED with its worktree kept', async () => {
    const { store, worktrees, scheduler } = setup([workerTask('a')]);
    await scheduler.run();
    approve(store, 'a');
    // meanwhile another change (e.g. a Claude-direct commit) lands on the integration branch: add/add conflict on src/a.js
    const batch = store.getBatch('B1')!;
    const iw = await worktrees.integrationWorktree(batch);
    mkdirSync(join(iw.path, 'src'), { recursive: true });
    writeFileSync(join(iw.path, 'src/a.js'), 'module.exports = "someone else";\n');
    git(iw.path, 'add', '-A');
    git(iw.path, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'claude direct');
    const tipBefore = git(iw.path, 'rev-parse', 'HEAD');
    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.equal(reports[0].outcome, 'ESCALATED');
    assert.equal(reports[0].category, 'integration_conflict');
    assert.equal(git(iw.path, 'rev-parse', 'HEAD'), tipBefore, 'integration branch restored');
    assert.equal(git(iw.path, 'status', '--porcelain'), '', 'no merge in progress, tree clean');
    assert.equal(readFileSync(join(iw.path, 'src/a.js'), 'utf8'), 'module.exports = "someone else";\n', 'nothing silently overwritten');
    const t = store.requireTask('a');
    assert.equal(t.state, 'ESCALATED');
    assert.ok(existsSync(join(t.worktreePath!, 'src/a.js')), 'task worktree preserved');
  });

  it('failed integration verification rolls the branch back, preserves the worktree, and blocks dependents', async () => {
    const { store, worktrees, scheduler } = setup([workerTask('a'), workerTask('b', { dependsOn: ['a'] })], { planExtra: { integrationCommands: [['go', 'test', './...']] } });
    await scheduler.run();
    approve(store, 'a');
    const iw = await worktrees.integrationWorktree(store.getBatch('B1')!);
    const tipBefore = git(iw.path, 'rev-parse', 'HEAD');
    const failing: CommandRunner = async (c) => (c[0] === 'go' ? { exitCode: 1, output: 'FAIL: TestX\n', timedOut: false } : { exitCode: 0, output: '', timedOut: false });
    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: failing });
    assert.equal(reports[0].category, 'integration_verification_failed');
    assert.match(reports[0].commands!.at(-1)!.tail, /FAIL: TestX/);
    assert.equal(git(iw.path, 'rev-parse', 'HEAD'), tipBefore);
    assert.equal(existsSync(join(iw.path, 'src/a.js')), false, 'merged files rolled back');
    assert.equal(store.requireTask('a').state, 'ESCALATED');
    assert.equal(store.requireTask('b').state, 'BLOCKED');
    assert.ok(existsSync(store.requireTask('a').worktreePath!));
  });

  it('rejects integration commands that are not allow-listed (no arbitrary command execution)', async () => {
    const { store, worktrees, scheduler } = setup([workerTask('a')], { planExtra: { integrationCommands: [['rm', '-rf', '/']] } });
    await scheduler.run();
    approve(store, 'a');
    let executed = false;
    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: async (c) => (c[0] === 'rm' ? ((executed = true), { exitCode: 0, output: '', timedOut: false }) : { exitCode: 0, output: '', timedOut: false }) });
    assert.equal(executed, false);
    assert.match(reports[0].detail ?? '', /not allow-listed/);
  });

  it('detects a task branch changed after review (diverged_after_review)', async () => {
    const { repo, store, worktrees, scheduler } = setup([workerTask('a')]);
    await scheduler.run();
    approve(store, 'a');
    const t = store.requireTask('a');
    writeFileSync(join(t.worktreePath!, 'src/a.js'), 'module.exports = "tampered";\n');
    git(t.worktreePath!, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-am', 'post-review change');
    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.equal(reports[0].category, 'diverged_after_review');
    assert.equal(store.requireTask('a').state, 'ESCALATED');
    void repo;
  });

  it('M9.0: a reviewed commit that renames an out-of-scope file onto an allowed one is caught (the scope check sees both paths)', async () => {
    const { repo, store, worktrees, scheduler } = setup([workerTask('a')], { repoFiles: { 'src/secret.js': 'module.exports = "keep me";\n' } });
    await scheduler.run();
    approve(store, 'a');
    const t = store.requireTask('a');
    // A commit whose rename record would name only src/a.js: the deletion of src/secret.js must not be hidden from the check.
    git(t.worktreePath!, 'reset', '-q', '--hard', t.baseCommit!);
    git(t.worktreePath!, 'mv', 'src/secret.js', 'src/a.js');
    git(t.worktreePath!, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'rename');
    store.db.prepare('UPDATE tasks SET head_commit = ? WHERE id = ?').run(git(t.worktreePath!, 'rev-parse', 'HEAD'), 'a');
    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.equal(reports[0].category, 'diverged_after_review');
    assert.match(reports[0].detail ?? '', /src\/secret\.js/);
    assert.equal(git(repo, 'show', 'lead-integration/B1:src/secret.js'), 'module.exports = "keep me";', 'nothing was merged');
  });

  it('serializes integration per repository: a live lock makes a second integrator back off', async () => {
    const { store, worktrees, scheduler, repo } = setup([workerTask('a')]);
    await scheduler.run();
    approve(store, 'a');
    assert.ok(store.acquireLock(`integrate:${repo}`, 'other-integrator', 60_000));
    const r = await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.equal(r.locked, true);
    assert.equal(store.requireTask('a').state, 'APPROVED');
  });

  it('crash mid-integration: the branch is restored to the recorded pre-merge SHA and the task is retried, not lost or doubled', async () => {
    const { store, worktrees, scheduler } = setup([workerTask('a')]);
    await scheduler.run();
    approve(store, 'a');
    const iw = await worktrees.integrationWorktree(store.getBatch('B1')!);
    const preSha = git(iw.path, 'rev-parse', 'HEAD');
    // simulate the integrator dying after the merge but before verification finished
    store.transition('a', 'INTEGRATING', { actor: 'dead', expectFrom: 'APPROVED', patch: { artifacts: { integration: { preSha } } } });
    git(iw.path, '-c', 'user.name=x', '-c', 'user.email=x@x', 'merge', '--no-ff', '-m', 'half merge', store.requireTask('a').headCommit!);
    // The new journal records the exact owned tip; ancestry alone cannot authorize discarding commits.
    store.setArtifacts('a', { integration: { preSha, expectedTip: git(iw.path, 'rev-parse', 'HEAD') } });
    assert.notEqual(git(iw.path, 'rev-parse', 'HEAD'), preSha);
    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.deepEqual(reports.map((r) => r.outcome), ['DONE']);
    assert.equal(store.requireTask('a').state, 'DONE');
    assert.equal(git(iw.path, 'log', '--oneline', '--merges').split('\n').filter(Boolean).length, 1, 'exactly one integration merge');
  });

  it('Claude-direct: an escalated task is taken over with a recorded reason, completed on the integration branch, and counted separately', async () => {
    const executor = fakeExecutor({ behavior: () => ({ status: 'ESCALATED_TO_CLAUDE', reasons: ['coding_attempts_exhausted'], codingAttempts: 3, runtimeRetries: 0 }) });
    const { store, worktrees, scheduler } = setup([workerTask('a')], { executor });
    await scheduler.run();
    assert.throws(() => takeOverEscalated(store, 'a', ''), /reason/);
    takeOverEscalated(store, 'a', 'worker failed 3 attempts on a subtle ordering bug');
    startClaudeTask(store, 'a');
    const iw = await worktrees.integrationWorktree(store.getBatch('B1')!);
    mkdirSync(join(iw.path, 'src'), { recursive: true });
    writeFileSync(join(iw.path, 'src/a.js'), 'module.exports = "claude";\n');
    git(iw.path, 'add', '-A');
    git(iw.path, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '-m', 'a by claude');
    const { completeClaudeTask } = await import('./integrate.ts');
    await completeClaudeTask(store, worktrees, { taskId: 'a', commit: git(iw.path, 'rev-parse', 'HEAD'), note: 'fixed ordering', run: passRunner });
    const t = store.requireTask('a');
    assert.equal(t.state, 'DONE');
    assert.equal(t.implementedBy, 'claude');
    assert.equal(t.executor, 'claude');
    assert.match(String((t.artifacts.claudeDirect as any).reason), /ordering bug/);
  });
});

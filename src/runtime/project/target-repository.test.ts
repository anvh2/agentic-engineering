import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { findProjectRoot } from '../../core/paths.ts';
import { reviewDecision } from '../../lead/review.ts';
import { Scheduler } from '../scheduler/scheduler.ts';
import { fakeExecutor, git, makeRepo, makeStore, plan, tempDir, workerTask } from '../scheduler/test-helpers.ts';
import { WorktreeManager } from '../worktree/worktree.ts';
import { integrateBatch } from '../integration/integrate.ts';
import { assertWorktreeOwnedBy, ensureWorktreesExcluded, frameworkGitCommonDir, resolveTargetRepository, TargetRepositoryError } from './target-repository.ts';

/**
 * Regression tests for the CloudFarm failure: task worktrees for a target repository were created under the framework
 * checkout's `.workdir/worktrees`, and nothing checked that a batch still operated on the repository it was planned for.
 */

const fast = { pollMs: 10, workerLeaseTimeoutMs: 60_000 };

describe('target repository identity', () => {
  test('resolves the canonical root and common dir from any worktree, and the id is stable', () => {
    const repo = makeRepo();
    const linked = join(tempDir('linked-'), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', linked);
    const a = resolveTargetRepository(repo);
    const b = resolveTargetRepository(linked);
    assert.equal(a.repositoryId, b.repositoryId);
    assert.equal(b.canonicalRoot, realpathSync(repo), 'a linked worktree resolves to the primary checkout');
    assert.equal(a.gitCommonDir, realpathSync(join(repo, '.git')));
    assert.equal(a.worktreeRoot, join(realpathSync(repo), '.worktrees'));
    assert.equal(a.isFramework, false);
  });

  test('the framework repository is recognised as such; an arbitrary target is not', () => {
    assert.ok(frameworkGitCommonDir(), 'the framework checkout is a git repository');
    assert.equal(resolveTargetRepository(findProjectRoot(import.meta.dirname)!).isFramework, true);
    assert.equal(resolveTargetRepository(makeRepo()).isFramework, false);
  });

  test('a path that is not a repository, or a relative path, is refused', () => {
    assert.throws(() => resolveTargetRepository(tempDir('plain-')), (e: unknown) => e instanceof TargetRepositoryError && e.code === 'not_a_repository');
    assert.throws(() => resolveTargetRepository('relative/path'), TargetRepositoryError);
  });

  test('credentials embedded in a remote URL are not recorded', () => {
    const repo = makeRepo();
    git(repo, 'remote', 'add', 'origin', 'https://user:secret-token@github.com/o/r.git');
    assert.equal(resolveTargetRepository(repo).origin, 'https://github.com/o/r.git');
  });

  test('.worktrees is excluded locally (info/exclude), once, without touching tracked files', () => {
    const repo = makeRepo();
    const t = resolveTargetRepository(repo);
    assert.equal(ensureWorktreesExcluded(t), true);
    assert.equal(ensureWorktreesExcluded(t), false, 'idempotent');
    assert.match(readFileSync(join(t.gitCommonDir, 'info', 'exclude'), 'utf8'), /^\/\.worktrees\/$/m);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  });
});

describe('batches record their target and worktrees live in the target repository', () => {
  test('createBatch records the identity; a registered project refuses a batch on another repository', () => {
    const store = makeStore();
    const a = makeRepo();
    const b = makeRepo({ 'other.txt': 'x\n' });
    store.registerProject({ projectId: 'cloudfarm', target: resolveTargetRepository(a) });
    store.createBatch(plan(a, [workerTask('t1')], { project: 'cloudfarm' }), 'lead', { target: resolveTargetRepository(a) });
    assert.equal(store.getBatch('B1')!.target!.repositoryId, resolveTargetRepository(a).repositoryId);
    assert.throws(
      () => store.createBatch(plan(b, [workerTask('t2')], { batchId: 'B2', project: 'cloudfarm' }), 'lead', { target: resolveTargetRepository(b) }),
      /repository_identity_mismatch/,
    );
    assert.equal(store.getBatch('B2'), undefined, 'nothing of the refused batch is stored');
    assert.throws(() => store.registerProject({ projectId: 'cloudfarm', target: resolveTargetRepository(b) }), /repository_identity_mismatch/);
    assert.throws(() => store.registerProject({ projectId: 'other', target: resolveTargetRepository(a) }), /already registered as project cloudfarm/);
    assert.throws(() => store.db.exec("UPDATE batch_targets SET repository_id = 'x'"), /append-only/);
    store.close();
  });

  test('a task worktree is created inside the target repository, never inside the framework checkout', async () => {
    const store = makeStore();
    const repo = makeRepo();
    const target = resolveTargetRepository(repo);
    store.createBatch(plan(repo, [workerTask('a')]), 'lead', { target });
    const framework = findProjectRoot(import.meta.dirname)!;
    const frameworkWorktreesBefore = git(framework, 'worktree', 'list', '--porcelain');
    const summary = await new Scheduler({ store, executor: fakeExecutor(), workspace: WorktreeManager.targetOwned(), config: fast }).run();
    assert.deepEqual(summary.reviewPending, ['a']);
    const task = store.requireTask('a');
    assert.equal(realpathSync(task.worktreePath!), join(target.worktreeRoot, 'B1', 'a'));
    assertWorktreeOwnedBy(target, task.worktreePath!);
    assert.notEqual(realpathSync(git(task.worktreePath!, 'rev-parse', '--path-format=absolute', '--git-common-dir')), frameworkGitCommonDir());
    assert.equal(git(framework, 'worktree', 'list', '--porcelain'), frameworkWorktreesBefore, 'the framework repository gained no worktree');
    assert.equal(git(repo, 'status', '--porcelain'), '', 'the target checkout stays clean (.worktrees is excluded)');
    store.close();
  });

  test('two targets never share a worktree root', async () => {
    const store = makeStore();
    const r1 = makeRepo();
    const r2 = makeRepo({ 'b.txt': 'b\n' });
    store.createBatch(plan(r1, [workerTask('x1')], { batchId: 'P1', project: 'one' }), 'lead', { target: resolveTargetRepository(r1) });
    store.createBatch(plan(r2, [workerTask('x2')], { batchId: 'P2', project: 'two' }), 'lead', { target: resolveTargetRepository(r2) });
    await new Scheduler({ store, executor: fakeExecutor(), workspace: WorktreeManager.targetOwned(), config: { ...fast, maxConcurrentWorkers: 2 } }).run();
    assert.ok(realpathSync(store.requireTask('x1').worktreePath!).startsWith(realpathSync(r1) + '/.worktrees/'));
    assert.ok(realpathSync(store.requireTask('x2').worktreePath!).startsWith(realpathSync(r2) + '/.worktrees/'));
    store.close();
  });

  test('a repository replaced at the recorded path fails closed before any worktree or worker', async () => {
    const store = makeStore();
    const repo = makeRepo();
    store.createBatch(plan(repo, [workerTask('a')]), 'lead', { target: resolveTargetRepository(repo) });
    // Same path, different repository (re-initialised with another history): the identity no longer matches.
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'different history');
    const executor = fakeExecutor();
    await new Scheduler({ store, executor, workspace: WorktreeManager.targetOwned(), config: fast }).run();
    const task = store.requireTask('a');
    assert.equal(task.state, 'ESCALATED');
    assert.equal(task.failureCategory, 'repository_identity_mismatch');
    assert.deepEqual(executor.calls, [], 'no worker was started');
    assert.equal(existsSync(join(repo, '.worktrees')), false, 'no worktree was created');
    store.close();
  });

  test('integration re-checks the identity, and integrates inside the target repository', async () => {
    const store = makeStore();
    const repo = makeRepo();
    store.createBatch(plan(repo, [workerTask('a')]), 'lead', { target: resolveTargetRepository(repo) });
    const worktrees = WorktreeManager.targetOwned();
    await new Scheduler({ store, executor: fakeExecutor(), workspace: worktrees, config: fast }).run();
    reviewDecision(store, { maxReviewCorrections: 0 }, { taskId: 'a', decision: 'APPROVED' });
    const batch = store.getBatch('B1')!;
    await assert.rejects(worktrees.integrationWorktree({ ...batch, repository: makeRepo() }), /repository_identity_mismatch/);
    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: async () => ({ exitCode: 0, output: '', timedOut: false }) });
    assert.deepEqual(reports.map((r) => r.outcome), ['DONE'], JSON.stringify(reports));
    assert.ok(realpathSync(worktrees.integrationPath('B1', batch)).startsWith(realpathSync(repo) + '/.worktrees/'));
    store.close();
  });
});

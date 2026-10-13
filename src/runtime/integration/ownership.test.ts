import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { reviewDecision } from '../../lead/review.ts';
import { Scheduler } from '../scheduler/scheduler.ts';
import { fakeExecutor, git, makeRepo, makeStore, plan, tempDir, workerTask } from '../scheduler/test-helpers.ts';
import { WorktreeManager } from '../worktree/worktree.ts';
import { integrateBatch } from './integrate.ts';
import { integrationOwnership } from './ownership.ts';

const pass = { exitCode: 0, output: '', timedOut: false };
async function setup() {
  let now = 1000;
  const repo = makeRepo();
  const store = makeStore(() => now);
  store.createBatch(plan(repo, [workerTask('a')]));
  store.promote();
  const worktrees = new WorktreeManager(join(tempDir('fenced-int-'), 'worktrees'));
  await new Scheduler({ store, workspace: worktrees, executor: fakeExecutor(), config: { pollMs: 10 } }).run();
  reviewDecision(store, { maxReviewCorrections: 2 }, { taskId: 'a', decision: 'APPROVED', feedback: 'ok' });
  return { repo, store, worktrees, advance: (ms: number) => { now += ms; } };
}

it('renewal maintains ownership beyond the original TTL; a second manager cannot overlap', async (t) => {
  const { repo, store, worktrees, advance } = await setup();
  t.mock.timers.enable({ apis: ['setInterval'] });
  const result = await integrateBatch(store, worktrees, { batchId: 'B1', lockTtlMs: 300, run: async () => {
    for (let i = 0; i < 20; i++) { advance(100); t.mock.timers.tick(100); }
    assert.equal((await integrateBatch(store, new WorktreeManager(worktrees.root), { batchId: 'B1' })).locked, true);
    assert.ok(store.db.prepare('SELECT 1 FROM locks WHERE name = ? AND expires_at > ?').get(`integrate:${repo}`, store.now()));
    return pass;
  } });
  assert.equal(result.reports[0].outcome, 'DONE');
});

it('an in-flight Git command retains the non-expiring gate across lease expiry and the check/act gap', async () => {
  const { store, worktrees, advance } = await setup();
  const original = worktrees.git.bind(worktrees);
  let checked = false;
  worktrees.git = async (cwd, args, timeout) => {
    if (args.includes('--no-ff')) {
      advance(301); // after the coordinator's check, before the actual asynchronous Git mutation
      const second = await integrateBatch(store, new WorktreeManager(worktrees.root), { batchId: 'B1' });
      assert.equal(second.locked, true);
      checked = true;
    }
    return original(cwd, args, timeout);
  };
  await assert.rejects(integrateBatch(store, worktrees, { batchId: 'B1', lockTtlMs: 300, run: async () => pass }), /ownership lost/);
  assert.equal(checked, true);
  assert.equal(store.requireTask('a').state, 'INTEGRATING');
});

it('expired generation cannot write, rollback, clean, finish, renew or release a replacement lease', async () => {
  const { repo, store, worktrees, advance } = await setup();
  const original = worktrees.git.bind(worktrees);
  let stale = false;
  worktrees.git = async (cwd, args, timeout) => {
    assert.equal(stale, false, `stale Git call: ${args.join(' ')}`);
    return original(cwd, args, timeout);
  };
  const name = `integrate:${repo}`;
  await assert.rejects(integrateBatch(store, worktrees, { batchId: 'B1', lockTtlMs: 300, run: async (_, cwd) => {
    const old = (store.db.prepare('SELECT owner FROM locks WHERE name = ?').get(name) as { owner: string }).owner;
    advance(301);
    assert.equal(store.acquireLock(name, 'replacement', 10000), true);
    assert.equal(store.renewLock(name, old, 300), false);
    writeFileSync(join(cwd, 'external.txt'), 'preserve me');
    stale = true;
    return { ...pass, exitCode: 1 }; // would previously rollback and clean
  } }), /ownership lost/);
  assert.equal(store.ownsLock(name, 'replacement'), true);
  assert.equal(readFileSync(join(worktrees.integrationPath('B1'), 'external.txt'), 'utf8'), 'preserve me');
  assert.equal(store.requireTask('a').state, 'INTEGRATING');
});

it('failed renewal is sticky even while the lease is otherwise live', async (t) => {
  const { store, worktrees } = await setup();
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(store, 'renewLock', () => { throw new Error('database unavailable'); });
  await assert.rejects(integrateBatch(store, worktrees, { batchId: 'B1', lockTtlMs: 300, run: async () => {
    t.mock.timers.tick(100);
    return pass;
  } }), /ownership lost/);
  assert.equal(store.requireTask('a').state, 'INTEGRATING');
});

it('recovery refuses external descendant commits and preserves unknown untracked files', async () => {
  const { store, worktrees } = await setup();
  await assert.rejects(integrateBatch(store, worktrees, { batchId: 'B1', run: async () => { throw new Error('interrupted'); } }), /interrupted/);
  const iw = worktrees.integrationPath('B1');
  writeFileSync(join(iw, 'external.txt'), 'external commit');
  git(iw, 'add', 'external.txt');
  git(iw, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-m', 'external');
  const tip = git(iw, 'rev-parse', 'HEAD');
  writeFileSync(join(iw, 'untracked.txt'), 'operator work');
  await assert.rejects(integrateBatch(store, worktrees, { batchId: 'B1', run: async () => pass }), /unexpected integration tip/);
  assert.equal(git(iw, 'rev-parse', 'HEAD'), tip);
  assert.equal(readFileSync(join(iw, 'untracked.txt'), 'utf8'), 'operator work');
});

it('a recorded interrupted integration recovers and integrates normally', async () => {
  const { store, worktrees } = await setup();
  await assert.rejects(integrateBatch(store, worktrees, { batchId: 'B1', run: async () => { throw new Error('interrupted'); } }), /interrupted/);
  const result = await integrateBatch(store, worktrees, { batchId: 'B1', run: async () => pass });
  assert.equal(result.reports[0].outcome, 'DONE');
});

it('an orphan gate fails closed across stores and is never stolen based on TTL or PID', async () => {
  const repo = makeRepo();
  const worktrees = new WorktreeManager(join(tempDir('guard-'), 'worktrees'));
  const common = git(repo, 'rev-parse', '--git-common-dir');
  mkdirSync(join(repo, common, 'agentic-integration-guard'));
  assert.equal(await integrationOwnership(makeStore(), worktrees, repo, 'new', 300), null);
});

it('recovery aborts an interrupted conflicted merge without discarding the pre-existing external commit', async () => {
  const { store, worktrees } = await setup();
  const iw = (await worktrees.integrationWorktree(store.getBatch('B1')!)).path;
  mkdirSync(join(iw, 'src'), { recursive: true });
  writeFileSync(join(iw, 'src/a.js'), 'external version');
  git(iw, 'add', 'src/a.js');
  git(iw, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-m', 'external prior commit');
  const preSha = git(iw, 'rev-parse', 'HEAD');
  store.transition('a', 'INTEGRATING', { actor: 'interrupted', expectFrom: 'APPROVED', patch: { artifacts: { integration: { preSha } } } });
  const merge = await worktrees.git(iw, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'merge', '--no-ff', '-m', 'interrupted', store.requireTask('a').headCommit!]);
  assert.equal(merge.success, false);
  assert.ok(git(iw, 'rev-parse', 'MERGE_HEAD'));
  const result = await integrateBatch(store, worktrees, { batchId: 'B1', run: async () => pass });
  assert.equal(result.reports[0].outcome, 'ESCALATED'); // retry still has the genuine conflict
  assert.equal(git(iw, 'rev-parse', 'HEAD'), preSha);
  assert.equal(readFileSync(join(iw, 'src/a.js'), 'utf8'), 'external version');
  assert.equal(git(iw, 'status', '--porcelain'), '');
});

it('rollback refuses unknown untracked files before reset can overwrite them', async () => {
  const { store, worktrees } = await setup();
  await assert.rejects(integrateBatch(store, worktrees, { batchId: 'B1', run: async (_, cwd) => {
    writeFileSync(join(cwd, 'untracked.txt'), 'operator content');
    return { ...pass, exitCode: 1 };
  } }), /unknown untracked path/);
  assert.equal(readFileSync(join(worktrees.integrationPath('B1'), 'untracked.txt'), 'utf8'), 'operator content');
  assert.equal(store.requireTask('a').state, 'INTEGRATING');
});

it('the repository gate excludes a different process using a different scheduler database', async () => {
  const repo = makeRepo();
  const root = tempDir('cross-process-integration-');
  const worktrees = new WorktreeManager(join(root, 'worktrees'));
  const owner = await integrationOwnership(makeStore(), worktrees, repo, 'first', 60_000);
  assert.ok(owner);
  try {
    const code = `
      import { integrationOwnership } from ${JSON.stringify(new URL('./ownership.ts', import.meta.url).href)};
      import { SchedulerStore } from ${JSON.stringify(new URL('../scheduler/store.ts', import.meta.url).href)};
      import { WorktreeManager } from ${JSON.stringify(new URL('../worktree/worktree.ts', import.meta.url).href)};
      const store = new SchedulerStore(${JSON.stringify(join(root, 'second.db'))});
      const guard = await integrationOwnership(store, new WorktreeManager(${JSON.stringify(worktrees.root)}), ${JSON.stringify(repo)}, 'second', 60_000);
      if (guard) { await guard.release(); process.exitCode = 1; }
      store.close();
    `;
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code]);
  } finally { await owner.release(); }
});

it('rollback preserves external tracked edits instead of resetting them', async () => {
  const { store, worktrees } = await setup();
  await assert.rejects(integrateBatch(store, worktrees, { batchId: 'B1', run: async (_, cwd) => {
    writeFileSync(join(cwd, 'src/a.js'), 'operator edit');
    return { ...pass, exitCode: 1 };
  } }), /uncommitted tracked changes/);
  assert.equal(readFileSync(join(worktrees.integrationPath('B1'), 'src/a.js'), 'utf8'), 'operator edit');
});

it('a staged oracle is discardable only while its working bytes still match the owned oracle', async () => {
  const { store, worktrees } = await setup();
  const original = worktrees.git.bind(worktrees);
  worktrees.git = async (cwd, args, timeout) => {
    if (args.includes('commit') && args.includes('tests: oracle for a')) {
      writeFileSync(join(cwd, 'tests/a.test.js'), 'external oracle edit');
      return { success: false, exitCode: 1, stdout: '', stderr: 'injected commit failure', durationMs: 0, timedOut: false };
    }
    return original(cwd, args, timeout);
  };
  await assert.rejects(integrateBatch(store, worktrees, { batchId: 'B1', run: async () => pass }), /uncommitted tracked changes/);
  assert.equal(readFileSync(join(worktrees.integrationPath('B1'), 'tests/a.test.js'), 'utf8'), 'external oracle edit');
});

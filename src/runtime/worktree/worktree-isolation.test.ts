import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { writeFile as writeFileTool } from '../../workers/tools/repository-tools.ts';
import { contextFor } from '../../workers/tools/__testing__/context-for.ts';
import { runSandboxedCommand } from '../sandbox/sandbox.ts';
import { Scheduler, type ExecutorOutcome } from '../scheduler/scheduler.ts';
import { barrier, fakeExecutor, git, makeRepo, makeStore, plan, tempDir, workerTask } from '../scheduler/test-helpers.ts';
import { WorktreeManager } from './worktree.ts';

/**
 * M7 F: tasks that run at the same time cannot see or change each other's files, and nothing they do reaches the
 * source checkout. Real git repositories and worktrees throughout; no mocks of the isolation boundary.
 */

const darwin = process.platform === 'darwin';

function setup(tasks: ReturnType<typeof workerTask>[], executor = fakeExecutor(), config: object = { maxConcurrentWorkers: 3 }) {
  const repo = makeRepo({ 'src/existing.js': 'module.exports = "existing";\n' });
  const store = makeStore();
  store.createBatch(plan(repo, tasks));
  store.promote();
  const worktrees = new WorktreeManager(join(tempDir('iso-wt-'), 'worktrees'));
  const scheduler = new Scheduler({ store, executor, workspace: worktrees, config: { pollMs: 20, maxTasksPerBatch: 10, ...config } });
  return { repo, store, worktrees, scheduler, executor };
}

describe('M7 F: worktree isolation under concurrency', () => {
  it('three tasks edit at once: each worktree contains exactly its own change, each task branch commits only its own file', async () => {
    const gate = barrier(3); // all three workers are inside the executor, each in its own worktree, before any of them returns
    const executor = fakeExecutor({
      gate: () => gate.wait(),
      content: (id) => `module.exports = "only-${id}";\n`,
    });
    const { repo, store, scheduler } = setup([workerTask('a'), workerTask('b'), workerTask('c')], executor);
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const statusBefore = git(repo, 'status', '--porcelain');

    const summary = await scheduler.run();
    assert.equal(summary.peakInFlight, 3);
    assert.deepEqual(summary.reviewPending.sort(), ['a', 'b', 'c']);

    const ids = ['a', 'b', 'c'];
    for (const id of ids) {
      const t = store.requireTask(id);
      for (const other of ids) {
        assert.equal(existsSync(join(t.worktreePath!, `src/${other}.js`)), other === id, `${id}'s worktree ${other === id ? 'has' : 'must not have'} src/${other}.js`);
      }
      assert.equal(readFileSync(join(t.worktreePath!, `src/${id}.js`), 'utf8'), `module.exports = "only-${id}";\n`);
      assert.equal(git(t.worktreePath!, 'status', '--porcelain'), '', `${id}'s worktree is clean after its commit`);
      assert.equal(git(repo, 'diff', '--name-only', t.baseCommit!, t.headCommit!), `src/${id}.js`, `${id}'s commit touches only its own file`);
      assert.equal(git(repo, 'rev-parse', `refs/heads/lead-task/B1/${id}`), t.headCommit);
    }
    assert.equal(new Set(ids.map((id) => realpathSync(store.requireTask(id).worktreePath!))).size, 3);

    // the source checkout: same commit, same status, same branch, none of the task files, and no stray worktree state
    assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(git(repo, 'status', '--porcelain'), statusBefore);
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    for (const id of ids) assert.equal(existsSync(join(repo, `src/${id}.js`)), false);
  });

  it('preparing worktrees concurrently (the scheduler claims several tasks in one pass) is race-free', async () => {
    const { repo, store, worktrees } = setup(['a', 'b', 'c', 'd'].map((id) => workerTask(id)));
    const batch = store.getBatch('B1')!;
    const prepared = await Promise.all(['a', 'b', 'c', 'd'].map((id) => worktrees.prepare(store.requireTask(id), batch)));
    assert.equal(new Set(prepared.map((p) => p.path)).size, 4);
    assert.equal(new Set(prepared.map((p) => p.baseCommit)).size, 1, 'all four are cut from the same integration tip');
    const listed = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
    assert.equal(listed, 1 + 4, 'the source checkout plus exactly four task worktrees');
  });

  it("worker A's tools cannot reach worker B's worktree, by relative traversal or by absolute path", async () => {
    const { store, worktrees } = setup([workerTask('a'), workerTask('b')]);
    const batch = store.getBatch('B1')!;
    const [a, b] = await Promise.all([worktrees.prepare(store.requireTask('a'), batch), worktrees.prepare(store.requireTask('b'), batch)]);
    writeFileSync(join(b.path, 'src-b-secret.txt'), 'b-owned\n');

    // the worktrees are siblings under <root>/B1/, exactly the layout a traversal attack would target
    await assert.rejects(writeFileTool.execute!({ path: '../b/src-b-secret.txt', content: 'hijacked\n' }, contextFor(a.path)), /outside the repository root|outside/i);
    await assert.rejects(writeFileTool.execute!({ path: join(b.path, 'src-b-secret.txt'), content: 'hijacked\n' }, contextFor(a.path)), /outside the repository root|outside|absolute/i);
    await assert.rejects(writeFileTool.execute!({ path: '../b/new-file.txt', content: 'x\n' }, contextFor(a.path)));
    assert.equal(readFileSync(join(b.path, 'src-b-secret.txt'), 'utf8'), 'b-owned\n');
    assert.equal(existsSync(join(b.path, 'new-file.txt')), false);
    assert.equal(git(b.path, 'status', '--porcelain'), '?? src-b-secret.txt', "B's worktree holds only B's own file");
  });

  it("model-generated code in worker A's sandbox cannot write into worker B's worktree", { skip: !darwin && 'macOS sandbox only' }, async () => {
    const { store, worktrees } = setup([workerTask('a'), workerTask('b')]);
    const batch = store.getBatch('B1')!;
    const [a, b] = await Promise.all([worktrees.prepare(store.requireTask('a'), batch), worktrees.prepare(store.requireTask('b'), batch)]);
    const victim = join(b.path, 'src', 'existing.js');
    const before = readFileSync(victim, 'utf8');
    // the same script also writes inside its OWN root: that write succeeding proves the script really ran (not a vacuous pass)
    const attack = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(join(a.path, 'own.txt'))},'mine');try{fs.writeFileSync(${JSON.stringify(victim)},'pwned');}catch(e){}try{fs.writeFileSync(${JSON.stringify(join(b.path, 'dropped.txt'))},'x');}catch(e){}`;
    await runSandboxedCommand('node', ['-e', attack], { cwd: a.path, root: a.path, timeoutMs: 20_000 });
    assert.equal(readFileSync(join(a.path, 'own.txt'), 'utf8'), 'mine', 'the sandboxed script ran and could write in its own worktree');
    assert.equal(readFileSync(victim, 'utf8'), before, "B's file is untouched");
    assert.equal(existsSync(join(b.path, 'dropped.txt')), false);
    assert.equal(git(b.path, 'status', '--porcelain'), '');
  });

  it('a failed task leaves junk in ITS worktree only and does not contaminate tasks that run alongside or afterwards', async () => {
    const failing: Record<string, ExecutorOutcome> = {
      bad: { status: 'ESCALATED_TO_CLAUDE', reasons: ['coding_attempts_exhausted'], codingAttempts: 3, runtimeRetries: 0 },
    };
    const executor = fakeExecutor({
      behavior: (input) => {
        if (input.task.id !== 'bad') return undefined;
        mkdirSync(join(input.repository, 'src'), { recursive: true });
        writeFileSync(join(input.repository, 'src/bad.js'), 'half-written garbage\n');
        writeFileSync(join(input.repository, 'src/junk.js'), 'leftover\n');
        return failing.bad;
      },
    });
    const { repo, store, worktrees, scheduler } = setup([workerTask('bad'), workerTask('good')], executor);
    await scheduler.run();
    assert.equal(store.requireTask('bad').state, 'ESCALATED');
    assert.equal(store.requireTask('good').state, 'REVIEW_PENDING');
    const good = store.requireTask('good');
    assert.equal(existsSync(join(good.worktreePath!, 'src/junk.js')), false, "bad's junk never appears in good's worktree");
    assert.equal(existsSync(join(good.worktreePath!, 'src/bad.js')), false);
    assert.ok(existsSync(join(store.requireTask('bad').worktreePath!, 'src/junk.js')), "bad's worktree is preserved as evidence");

    // a later task on the same file (allowed: an ESCALATED task no longer owns its files) starts from the clean
    // integration tip, not from bad's branch
    const batch = store.getBatch('B1')!;
    store.addCorrectionTask(store.requireTask('bad'), workerTask('later', { files: ['src/bad.js'] }) as any, 'lead');
    const ws = await worktrees.prepare(store.requireTask('later'), batch);
    assert.equal(existsSync(join(ws.path, 'src/bad.js')), false, "later's worktree does not contain bad's half-written file");
    assert.equal(existsSync(join(ws.path, 'src/junk.js')), false);
    assert.equal(git(ws.path, 'status', '--porcelain'), '');
    assert.equal(ws.baseCommit, store.requireTask('good').baseCommit, 'cut from the same integration tip as every other task');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
    assert.equal(existsSync(join(repo, 'src/junk.js')), false, 'the source checkout never saw any of it');
  });
});

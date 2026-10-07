import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile as writeFileOnDisk } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatch, writeFile } from './repository-tools.ts';
import { runJestTest } from './execution-tools.ts';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';
import { contextFor } from './__testing__/context-for.ts';
import { runCodingTask, type CodingTask } from '../../runtime/execution/coding-task-runner.ts';

/**
 * Regression tests for paths the harness's mutation policy cannot see. The runner's filesystem snapshot skips `.git`,
 * `node_modules` and `.applypatch-*` entries, so a worker write there is invisible to the forbidden-mutation check AND to
 * the restore. Such writes must therefore be refused at the tool boundary:
 *   - `.git` (dir, or a worktree's `.git` pointer FILE): repointing it redirects every later harness git command
 *     (commit, `reset --hard`) to another repository; `.git/config` / hooks give code execution on the next git call.
 *   - `node_modules`: the JS verifier (`npx --no-install jest`) executes code from there; editing it forges a PASS.
 *   - `.applypatch-*`: the atomic-write temp prefix, ignored by the snapshot.
 */

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

describe('repository tools: protected paths are never writable', () => {
  let fixture: FixtureRepo;
  before(async () => {
    fixture = await createFixtureRepo();
    git(fixture.root, 'init', '-q', '-b', 'main');
    await mkdir(join(fixture.root, 'node_modules', 'jest', 'bin'), { recursive: true });
    await writeFileOnDisk(join(fixture.root, 'node_modules', 'jest', 'bin', 'jest.js'), 'real jest\n');
  });
  after(() => fixture.cleanup());

  const blocked = ['.git/config', '.git/hooks/pre-commit', 'node_modules/jest/bin/jest.js', 'internal/.applypatch-1234.tmp', 'internal/../.git/HEAD', '.GIT/config', 'Node_Modules/x.js'];
  for (const path of blocked) {
    it(`writeFile refuses ${path}`, async () => {
      await assert.rejects(writeFile.execute!({ path, content: 'pwned\n' }, contextFor(fixture.root)), /protected/i);
    });
    it(`applyPatch refuses ${path}`, async () => {
      const patch = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+pwned\n`;
      await assert.rejects(applyPatch.execute!({ path, patch }, contextFor(fixture.root)), /protected/i);
    });
  }

  it('leaves the protected files untouched', async () => {
    assert.equal(await readFile(join(fixture.root, 'node_modules/jest/bin/jest.js'), 'utf8'), 'real jest\n');
    assert.doesNotMatch(await readFile(join(fixture.root, '.git/config'), 'utf8'), /pwned/);
  });

  it('ordinary repository files stay writable (no over-blocking of look-alike names)', async () => {
    for (const path of ['internal/git_helpers.go', 'internal/node_modules_test_notes.md', 'internal/applypatch.go', '.gitignore']) {
      const r = (await writeFile.execute!({ path, content: 'ok\n' }, contextFor(fixture.root))) as { success: boolean };
      assert.equal(r.success, true, path);
    }
  });
});

describe('a git worktree pointer file cannot be repointed by the worker', () => {
  let main: string;
  let worktree: string;
  before(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'protected-wt-'));
    main = join(parent, 'main');
    await mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    await writeFileOnDisk(join(main, 'a.go'), 'package a\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    worktree = join(parent, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'lead-task/B/t', worktree);
  });
  after(() => rm(join(main, '..'), { recursive: true, force: true }));

  it('refuses to overwrite the worktree .git file (which would redirect harness git commands to the user repository)', async () => {
    assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'lead-task/B/t');
    await assert.rejects(writeFile.execute!({ path: '.git', content: `gitdir: ${join(main, '.git')}\n` }, contextFor(worktree)), /protected/i);
    // Still on the task branch: harness commits / resets keep targeting the task worktree, never the user's branch.
    assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'lead-task/B/t');
  });
});

describe('runner: mutations the snapshot cannot see', () => {
  it('documents the blind spot the tool boundary closes: a node_modules write is not reported as a forbidden mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-blind-'));
    try {
      await mkdir(join(root, 'src'));
      await mkdir(join(root, 'node_modules', 'jest'), { recursive: true });
      await writeFileOnDisk(join(root, 'src', 'a.txt'), 'old\n');
      const task: CodingTask = {
        taskId: 'blind',
        objective: 'x',
        allowedFiles: ['src/a.txt'],
        verificationCommands: [['node', '-e', 'process.exit(0)']],
        constraints: ['tests are immutable'],
      };
      const worker = {
        async generate() {
          await writeFileOnDisk(join(root, 'src', 'a.txt'), 'new\n');
          await writeFileOnDisk(join(root, 'node_modules', 'jest', 'index.js'), 'forged\n'); // bypasses the tools
          return { text: 'done', finishReason: 'stop', steps: [{}] };
        },
      };
      const result = await runCodingTask(task, { repoRoot: root, worker });
      // The snapshot is blind here by design (node_modules is huge); writes there are only prevented by the tools.
      assert.equal(result.verdict, 'PASS');
      assert.deepEqual(result.forbiddenFilesChanged, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('execution tools: jest invocation', () => {
  let fixture: FixtureRepo;
  let argvLog: string;
  before(async () => {
    fixture = await createFixtureRepo();
    // A fake `npx` first on PATH records its argv, so the test needs no network and no real jest.
    const bin = join(fixture.parent, 'bin');
    argvLog = join(fixture.root, 'argv.log'); // inside the root: the sandboxed npx may not write anywhere else
    await mkdir(bin);
    await writeFileOnDisk(join(bin, 'npx'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvLog}'\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${process.env.PATH}`;
    await writeFileOnDisk(join(fixture.root, '--config=evil.js'), 'x\n');
  });
  after(() => fixture.cleanup());

  it('never lets npx download a package (--no-install)', async () => {
    await runJestTest.execute!({ testPath: 'internal' }, contextFor(fixture.root));
    const argv = (await readFile(argvLog, 'utf8')).trim().split('\n');
    assert.deepEqual(argv.slice(0, 2), ['--no-install', 'jest']);
  });

  it('a test path that looks like an option is refused, not passed to jest', async () => {
    await assert.rejects(runJestTest.execute!({ testPath: '--config=evil.js' }, contextFor(fixture.root)), /option|must not start/i);
  });
});

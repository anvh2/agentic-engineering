import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectRoot } from '../../core/paths.ts';
import type { WorkerLike } from './coding-task-runner.ts';
import { executeDelegation, routeTask, type DelegationRequest } from './delegation.ts';
import { isRuntimeRepository, nonDelegatableReasons } from './non-delegatable.ts';

const STUB = 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n';
const TEST_SRC = 'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif Double(3) != 6 {\n\t\tt.Fatal("want 6")\n\t}\n}\n';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });

const request = (allowedFile: string, dir: string): DelegationRequest => ({
  contract: {
    taskId: 'SELF-1',
    objective: `Implement Double in ${allowedFile}`,
    allowedFiles: [allowedFile],
    contextFiles: [`${dir}/calc_test.go`],
    acceptanceCriteria: ['TestDouble passes'],
    verificationCommands: [['go', 'test', '-count=1', `./${dir}/...`]],
    constraints: ['tests are immutable', 'standard library only'],
  },
  assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'single function with an existing test' },
});

/** A Go package at `dir`, inside a repository that is (or is not) a checkout of this runtime. */
async function repo(packageName: string, dirs: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'self-dev-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: packageName }));
  await writeFile(join(root, 'go.mod'), 'module example.com/self\n\ngo 1.22\n');
  for (const dir of dirs) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'calc.go'), STUB);
    await writeFile(join(root, dir, 'calc_test.go'), TEST_SRC);
  }
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

const neverCalled: WorkerLike = { async generate() { throw new Error('worker must not be invoked'); } };

describe('self-development: the runtime never delegates its own gates', () => {
  let root: string;
  beforeEach(async () => { root = await repo('agentic-engineering', ['src/runtime/sandbox', 'tests/bench/calc', 'tools/calc']); });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('identifies the runtime by its package name, not by its directory', async () => {
    assert.equal(await isRuntimeRepository(root), true);
    assert.equal(await isRuntimeRepository(tmpdir()), false);
  });

  it('a protected file stays with Claude at routing, with the reason', async () => {
    for (const dir of ['src/runtime/sandbox', 'tests/bench/calc']) {
      const route = await routeTask(request(`${dir}/calc.go`, dir), root);
      assert.equal(route.route, 'claude', dir);
      assert.match((route as { reasons: string[] }).reasons.join(' | '), /non-delegatable in the runtime's own repository/, dir);
    }
  });

  it('an ordinary file in the runtime repository is still delegated: the list does not over-block', async () => {
    assert.deepEqual(await routeTask(request('tools/calc/calc.go', 'tools/calc'), root), { route: 'qwen' });
  });

  it('case and segment tricks and a symlinked alias directory cannot reach a protected path', async () => {
    assert.match((await nonDelegatableReasons(root, ['SRC/Runtime/sandbox/calc.go'])).join(), /non-delegatable/);
    assert.match((await nonDelegatableReasons(root, ['./src//runtime/sandbox/calc.go'])).join(), /non-delegatable/);
    assert.match((await nonDelegatableReasons(root, ['Package.json'])).join(), /non-delegatable/);
    assert.deepEqual(await nonDelegatableReasons(root, ['srcx/calc.go', 'tools/src/calc.go']), [], 'whole segments only');

    await mkdir(join(root, 'docs'));
    await symlink(join(root, 'src', 'runtime'), join(root, 'docs', 'alias'));
    assert.match((await nonDelegatableReasons(root, ['docs/alias/sandbox/calc.go'])).join(), /resolves through a symlink to a non-delegatable path \(src\/\)/);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'alias');
    assert.equal((await routeTask(request('docs/alias/sandbox/calc.go', 'docs/alias/sandbox'), root)).route, 'claude');
  });

  it('a step re-entered past routing still cannot run a worker on a protected file', async () => {
    const result = await executeDelegation(request('src/runtime/sandbox/calc.go', 'src/runtime/sandbox'), { repoRoot: root, worker: neverCalled });
    assert.equal(result.status, 'KEPT_BY_CLAUDE');
    assert.match(result.reasons!.join(), /non-delegatable/);
  });
});

describe('review findings (PR #58)', () => {
  let root: string;
  beforeEach(async () => { root = await repo('agentic-engineering', ['src/runtime/sandbox', 'tools/calc']); });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('P1: a subdirectory of the runtime handed in as the repository is still the runtime', async () => {
    assert.match((await nonDelegatableReasons(join(root, 'src'), ['runtime/sandbox/calc.go'])).join(), /non-delegatable in the runtime's own repository \(src\/\)/);
    assert.equal((await routeTask(request('runtime/sandbox/calc.go', 'runtime/sandbox'), join(root, 'src'))).route, 'claude');
    assert.deepEqual(await routeTask(request('calc/calc.go', 'calc'), join(root, 'tools')), { route: 'qwen' }, 'tools/ stays delegatable from a subdirectory too');
  });

  it('a target repository whose worktree lives under the runtime (.workdir/worktrees) is judged by its own identity', async () => {
    const nested = join(root, '.workdir', 'worktrees', 'b1', 't1');
    await mkdir(join(nested, 'calc'), { recursive: true });
    await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'some-product' }));
    await writeFile(join(nested, 'go.mod'), 'module example.com/p\n\ngo 1.22\n');
    await writeFile(join(nested, 'calc', 'calc.go'), STUB);
    await writeFile(join(nested, 'calc', 'calc_test.go'), TEST_SRC);
    git(nested, 'init', '-q'); git(nested, 'add', '-A'); git(nested, 'commit', '-q', '-m', 'init');
    assert.deepEqual(await nonDelegatableReasons(nested, ['calc/calc.go']), []);
    assert.deepEqual(await routeTask(request('calc/calc.go', 'calc'), nested), { route: 'qwen' });
  });

  it('fails closed when git cannot answer or is steered: GIT_* env, a broken .git file, a nested repository', async () => {
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = root;
    try { assert.match((await nonDelegatableReasons(join(root, 'src'), ['runtime/sandbox/calc.go'])).join(), /non-delegatable/); }
    finally { if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = saved; }
    await writeFile(join(root, 'src', '.git'), 'gitdir: /nonexistent\n');
    assert.match((await nonDelegatableReasons(join(root, 'src'), ['runtime/sandbox/calc.go'])).join(), /non-delegatable/, 'broken .git file');
    await rm(join(root, 'src', '.git'));
    git(join(root, 'src'), 'init', '-q');
    assert.match((await nonDelegatableReasons(join(root, 'src'), ['runtime/sandbox/calc.go'])).join(), /non-delegatable/, 'nested repository');
  });

  it('a ".." segment is refused even when its parent does not exist', async () => {
    assert.match((await nonDelegatableReasons(root, ['tools/../src/nonexistent/x.go'])).join(), /"\.\." segments are not delegated/);
  });

  it('re-entry past routing repeats every static scope check, not only the deny-list', async () => {
    const other = await repo('some-product', ['calc']);
    try {
      const result = await executeDelegation(request('calc/calc_test.go', 'calc'), { repoRoot: other, worker: neverCalled });
      assert.equal(result.status, 'KEPT_BY_CLAUDE');
      assert.match(result.reasons!.join(), /test files are the oracle/);
    } finally { await rm(other, { recursive: true, force: true }); }
  });
});

describe('other target repositories are unaffected', () => {
  it('the same paths in a repository that is not this runtime are delegated as before', async () => {
    const root = await repo('some-product', ['src/runtime/sandbox']);
    try {
      assert.deepEqual(await nonDelegatableReasons(root, ['src/runtime/sandbox/calc.go']), []);
      assert.deepEqual(await routeTask(request('src/runtime/sandbox/calc.go', 'src/runtime/sandbox'), root), { route: 'qwen' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

it('in this checkout, files the enabled Go/JS adapters could route today are now refused', async () => {
  const self = findProjectRoot()!;
  const exposed = ['src/workers/providers/__testing__/fake-codex.mjs', 'tests/bench/go-ladder/L1/reference/internal/calculator/calculator.go', 'tests/bench/go-ladder/L1/stub/internal/calculator/calculator.go'];
  const reasons = await nonDelegatableReasons(self, exposed);
  assert.equal(reasons.length, exposed.length, reasons.join('\n'));
});

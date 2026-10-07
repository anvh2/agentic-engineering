import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { languageOf, routeTask, workerAgentIdFor, type DelegationRequest } from './delegation.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const good: DelegationRequest = {
  contract: {
    taskId: 'JS-1',
    objective: 'Implement double in src/util/double.js',
    allowedFiles: ['src/util/double.js'],
    contextFiles: ['src/util/tests/unit/double.test.js'],
    acceptanceCriteria: ['double(3) === 6'],
    verificationCommands: [['npx', '--no-install', 'jest', '--runInBand', 'src/util/tests/unit/double.test.js']],
    constraints: ['tests are immutable', 'CommonJS only'],
  },
  assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one pure function with an existing test' },
};
const withContract = (c: Partial<DelegationRequest['contract']>): DelegationRequest => ({ ...good, contract: { ...good.contract, ...c } });
const withVerify = (...command: string[]) => withContract({ verificationCommands: [command] });

describe('JS/TS delegation gate (deterministic, no model)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lead-delegation-js-'));
    await mkdir(join(root, 'src/util/tests/unit'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
    await writeFile(join(root, 'src/util/double.js'), 'module.exports = (n) => 0;\n');
    await writeFile(join(root, 'src/util/tests/unit/double.test.js'), "const d = require('../../double');\ntest('d', () => expect(d(3)).toBe(6));\n");
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('clears a small, low-risk, well-scoped JS task for qwen', async () => {
    assert.deepEqual(await routeTask(good, root), { route: 'qwen' });
  });

  it('clears a JS task whose oracle is a runtime-owned hidden test file', async () => {
    const hidden = 'src/util/tests/unit/double.hidden.test.js';
    const request = withContract({
      verificationCommands: [['npx', '--no-install', 'jest', hidden]],
      hiddenFiles: { [hidden]: "test('x', () => {});\n" },
    });
    assert.deepEqual(await routeTask(request, root), { route: 'qwen' });
  });

  for (const [name, request, pattern] of [
    ['npx without --no-install (could fetch from the network)', withVerify('npx', 'jest', 'src/util/tests/unit/double.test.js'), /--no-install jest/],
    ['a different npx package', withVerify('npx', '--no-install', 'eslint', 'src/util/double.js'), /--no-install jest/],
    ['node as the verifier', withVerify('node', '-e', 'process.exit(0)'), /allow-listed/],
    ['sh as the verifier', withVerify('sh', '-c', 'echo hi'), /allow-listed/],
    ['jest --config (arbitrary file execution)', withVerify('npx', '--no-install', 'jest', '--config', 'evil.js', 'src/util/tests/unit/double.test.js'), /--config/],
    ['jest --setupFiles', withVerify('npx', '--no-install', 'jest', '--setupFiles=evil.js', 'src/util/tests/unit/double.test.js'), /setupFiles/],
    ['jest --runner', withVerify('npx', '--no-install', 'jest', '--runner', 'evil', 'src/util/tests/unit/double.test.js'), /--runner/],
    ['jest with no test path (whole suite)', withVerify('npx', '--no-install', 'jest', '--runInBand'), /at least one test file/],
    ['a test path with ..', withVerify('npx', '--no-install', 'jest', '../outside.test.js'), /without "\.\."/],
    ['an absolute test path', withVerify('npx', '--no-install', 'jest', '/etc/x.test.js'), /repo-relative/],
    ['a verification path that is not a test file', withVerify('npx', '--no-install', 'jest', 'src/util/double.js'), /not a test file/],
    ['a verification test that does not exist', withVerify('npx', '--no-install', 'jest', 'src/util/tests/unit/nope.test.js'), /does not exist/],
    ['a test file as the allowed file', withContract({ allowedFiles: ['src/util/tests/unit/double.test.js'] }), /test files/],
    ['more than one allowed file', withContract({ allowedFiles: ['src/util/double.js', 'src/util/other.js'] }), /exceeds the limit/],
    ['a TypeScript file (not enabled)', withContract({ allowedFiles: ['src/util/double.ts'] }), /\.go, or all be \.js/],
    ['a JSX file (not enabled)', withContract({ allowedFiles: ['src/util/Double.jsx'] }), /\.go, or all be \.js/],
    ['mixed Go and JS allowed files', withContract({ allowedFiles: ['src/util/double.js', 'x.go'] }), /\.go, or all be \.js/],
  ] as const) {
    it(`keeps the task with Claude: ${name}`, async () => {
      const route = await routeTask(request as DelegationRequest, root);
      assert.equal(route.route, 'claude');
      assert.match((route as { reasons: string[] }).reasons.join('\n'), pattern);
    });
  }

  it('keeps the task with Claude when the verification test is a symlink', async () => {
    await symlink('double.test.js', join(root, 'src/util/tests/unit/link.test.js'));
    const route = await routeTask(withVerify('npx', '--no-install', 'jest', 'src/util/tests/unit/link.test.js'), root);
    assert.equal(route.route, 'claude');
    assert.match((route as { reasons: string[] }).reasons.join('\n'), /symlink/);
  });

  it('keeps the task with Claude when the allowed file has uncommitted changes', async () => {
    await writeFile(join(root, 'src/util/double.js'), 'module.exports = (n) => 1;\n');
    const route = await routeTask(good, root);
    assert.equal(route.route, 'claude');
    assert.match((route as { reasons: string[] }).reasons.join('\n'), /uncommitted/);
  });

  it('a Go-style verifier is still refused for a JS task and vice versa', async () => {
    assert.equal((await routeTask(withVerify('go', 'test', './...'), root)).route, 'claude');
  });

  it('language detection and worker selection', () => {
    assert.equal(languageOf(['a.go']), 'go');
    assert.equal(languageOf(['a.js']), 'js');
    assert.equal(languageOf(['a.mjs']), 'js');
    assert.equal(languageOf(['a.ts']), undefined);
    assert.equal(languageOf(['a.go', 'b.js']), undefined);
    assert.equal(workerAgentIdFor('js'), 'codingWorkerJs');
    assert.equal(workerAgentIdFor('go'), 'codingWorkerGo');
    assert.equal(workerAgentIdFor(undefined), 'codingWorkerGo');
  });
});

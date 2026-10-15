import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, JS_POLICY, effectivePolicy, executeDelegation, routeTask, type DelegationPolicy, type DelegationRequest } from './delegation.ts';
import type { WorkerLike } from './coding-task-runner.ts';

/**
 * Runtime permission ceilings: a caller-supplied policy may only NARROW what the language adapter registry allows.
 * Regression for the copied-JS_POLICY bypass (argv validation used to be selected by object identity).
 */

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const JEST = ['npx', '--no-install', 'jest', '--runInBand', 'src/util/tests/unit/double.test.js'];

const jsRequest = (verificationCommands: string[][], allowedFiles = ['src/util/double.js']): DelegationRequest => ({
  contract: {
    taskId: 'JS-CEILING',
    objective: 'Implement double in src/util/double.js',
    allowedFiles,
    contextFiles: ['src/util/tests/unit/double.test.js'],
    acceptanceCriteria: ['double(3) === 6'],
    verificationCommands,
    constraints: ['tests are immutable'],
  },
  assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one pure function with an existing test' },
});
const goRequest = (verificationCommands: string[][]): DelegationRequest => ({
  contract: {
    taskId: 'GO-CEILING',
    objective: 'Implement Double in calc/calc.go',
    allowedFiles: ['calc/calc.go'],
    contextFiles: ['calc/calc_test.go'],
    acceptanceCriteria: ['TestDouble passes'],
    verificationCommands,
    constraints: ['tests are immutable'],
  },
  assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'single function with an existing test' },
});
const reasonsOf = (route: Awaited<ReturnType<typeof routeTask>>) => (route.route === 'claude' ? route.reasons.join('\n') : '');

describe('delegation permission ceilings', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'delegation-ceiling-'));
    await mkdir(join(root, 'src/util/tests/unit'), { recursive: true });
    await mkdir(join(root, 'calc'));
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
    await writeFile(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    await writeFile(join(root, 'src/util/double.js'), 'module.exports = (n) => 0;\n');
    await writeFile(join(root, 'src/util/double.ts'), 'export const double = (n: number) => 0;\n');
    await writeFile(join(root, 'src/util/tests/unit/double.test.js'), "const d = require('../../double');\ntest('d', () => expect(d(3)).toBe(6));\n");
    await writeFile(join(root, 'calc/calc.go'), 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n');
    await writeFile(join(root, 'calc/calc_test.go'), 'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif Double(3) != 6 {\n\t\tt.Fatal("want 6")\n\t}\n}\n');
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  describe('effectivePolicy', () => {
    it('is exactly the registry ceiling when no policy is requested', () => {
      assert.deepEqual(effectivePolicy('go'), DEFAULT_POLICY);
      assert.deepEqual(effectivePolicy('js'), JS_POLICY);
    });

    it('narrows but never widens: every field is the intersection with the ceiling', () => {
      const wide: DelegationPolicy = { maxAllowedFiles: 50, maxAttempts: 99, allowedExtensions: ['.js', '.mjs', '.cjs', '.ts', '.rb'], allowedVerificationBinaries: ['npx', 'node', 'sh', 'curl'] };
      assert.deepEqual(effectivePolicy('js', wide), { maxAllowedFiles: 1, maxAttempts: 3, allowedExtensions: ['.js', '.mjs', '.cjs'], allowedVerificationBinaries: ['npx'] });
      const narrow: DelegationPolicy = { maxAllowedFiles: 1, maxAttempts: 1, allowedExtensions: ['.js'], allowedVerificationBinaries: [] };
      assert.deepEqual(effectivePolicy('js', narrow), narrow, 'a trusted caller can still reduce permissions');
    });

    it('a policy copied from another language gains nothing', () => {
      assert.deepEqual(effectivePolicy('go', JS_POLICY), { maxAllowedFiles: 1, maxAttempts: 3, allowedExtensions: [], allowedVerificationBinaries: [] });
    });

    it('exported ceilings cannot be mutated to widen later routing decisions', () => {
      assert.throws(() => (JS_POLICY.allowedExtensions as string[]).push('.ts'), TypeError);
      assert.throws(() => (JS_POLICY.allowedVerificationBinaries as string[]).push('node'), TypeError);
      assert.throws(() => { (DEFAULT_POLICY as { maxAllowedFiles: number }).maxAllowedFiles = 99; }, TypeError);
      assert.deepEqual(JS_POLICY.allowedVerificationBinaries, ['npx']);
    });
  });

  describe('routeTask with an explicit policy', () => {
    it('positive control: a copied policy equal to the ceiling still clears a valid JS task', async () => {
      assert.deepEqual(await routeTask(jsRequest([JEST]), root, { ...JS_POLICY }), { route: 'qwen' });
    });

    it('a COPIED JS_POLICY cannot bypass strict jest argv validation (--config executes arbitrary files)', async () => {
      const route = await routeTask(jsRequest([['npx', '--no-install', 'jest', '--config', 'evil.js', 'src/util/tests/unit/double.test.js']]), root, { ...JS_POLICY, allowedExtensions: [...JS_POLICY.allowedExtensions] });
      assert.equal(route.route, 'claude');
      assert.match(reasonsOf(route), /--config/);
    });

    it('a hand-built JS policy cannot skip the npx --no-install requirement', async () => {
      const hand: DelegationPolicy = { maxAllowedFiles: 1, maxAttempts: 3, allowedExtensions: ['.js'], allowedVerificationBinaries: ['npx'] };
      const route = await routeTask(jsRequest([['npx', 'jest', 'src/util/tests/unit/double.test.js']]), root, hand);
      assert.equal(route.route, 'claude');
      assert.match(reasonsOf(route), /--no-install jest/);
    });

    it('a copied policy cannot allow whole-suite or non-test jest paths', async () => {
      const route = await routeTask(jsRequest([['npx', '--no-install', 'jest', '--runInBand']]), root, { ...JS_POLICY });
      assert.equal(route.route, 'claude');
      assert.match(reasonsOf(route), /at least one test file/);
    });

    it('a permissive policy cannot add a verifier binary to JS', async () => {
      const route = await routeTask(jsRequest([['node', '-e', 'process.exit(0)']]), root, { ...JS_POLICY, allowedVerificationBinaries: ['npx', 'node'] });
      assert.equal(route.route, 'claude');
      assert.match(reasonsOf(route), /"node" is not allow-listed/);
    });

    it('a permissive policy cannot add a verifier binary to Go', async () => {
      const route = await routeTask(goRequest([['sh', '-c', 'echo hi']]), root, { ...DEFAULT_POLICY, allowedVerificationBinaries: ['go', 'gofmt', 'sh'] });
      assert.equal(route.route, 'claude');
      assert.match(reasonsOf(route), /"sh" is not allow-listed/);
    });

    it('a permissive policy cannot raise the file limit', async () => {
      await writeFile(join(root, 'src/util/other.js'), 'module.exports = 1;\n');
      git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
      git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'other');
      const route = await routeTask(jsRequest([JEST], ['src/util/double.js', 'src/util/other.js']), root, { ...JS_POLICY, maxAllowedFiles: 10 });
      assert.equal(route.route, 'claude');
      assert.match(reasonsOf(route), /exceeds the limit of 1/);
    });

    it('a permissive policy cannot add the disabled TypeScript extension to a JS ceiling', async () => {
      const route = await routeTask(jsRequest([JEST], ['src/util/double.ts']), root, { ...JS_POLICY, allowedExtensions: ['.js', '.ts'] });
      assert.equal(route.route, 'claude');
      assert.match(reasonsOf(route), /mixed or other file types are not delegated/);
    });

    it('a reduced policy is honored', async () => {
      const route = await routeTask(jsRequest([JEST]), root, { ...JS_POLICY, allowedVerificationBinaries: [] });
      assert.equal(route.route, 'claude');
      assert.match(reasonsOf(route), /"npx" is not allow-listed/);
    });
  });

  describe('executeDelegation', () => {
    it('clamps a policy that asks for more coding attempts than the ceiling', async () => {
      let calls = 0;
      const worker: WorkerLike = { async generate() { calls += 1; return { text: 'done', finishReason: 'stop', steps: [{}] }; } };
      const result = await executeDelegation(goRequest([['go', 'test', '-count=1', './...']]), { repoRoot: root, worker, policy: { ...DEFAULT_POLICY, maxAttempts: 50 }, runOptions: { runtimeRetryDelayMs: 0 } });
      assert.equal(result.status, 'ESCALATED_TO_CLAUDE');
      assert.equal(result.run?.attempts, 3);
      assert.equal(calls, 3);
    });

    it('lets a trusted caller lower the attempt budget', async () => {
      let calls = 0;
      const worker: WorkerLike = { async generate() { calls += 1; return { text: 'done', finishReason: 'stop', steps: [{}] }; } };
      await executeDelegation(goRequest([['go', 'test', '-count=1', './...']]), { repoRoot: root, worker, policy: { ...DEFAULT_POLICY, maxAttempts: 1 }, runOptions: { runtimeRetryDelayMs: 0 } });
      assert.equal(calls, 1);
    });
  });
});

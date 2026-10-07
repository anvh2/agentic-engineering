import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delegateCodingTask, routeTask, type DelegationRequest } from './delegation.ts';
import type { WorkerLike } from './coding-task-runner.ts';

const STUB = 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n';
const RIGHT = 'package calc\n\nfunc Double(n int) int {\n\treturn n * 2\n}\n';
const WRONG = 'package calc\n\nfunc Double(n int) int {\n\treturn n + 1\n}\n';
const TEST_SRC =
  'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif got := Double(3); got != 6 {\n\t\tt.Fatalf("Double(3) = %d, want 6", got)\n\t}\n}\n';

const good: DelegationRequest = {
  contract: {
    taskId: 'ENG-1',
    objective: 'Implement Double in calc/calc.go',
    allowedFiles: ['calc/calc.go'],
    contextFiles: ['calc/calc_test.go'],
    acceptanceCriteria: ['TestDouble passes'],
    verificationCommands: [['go', 'test', '-count=1', './...']],
    constraints: ['tests are immutable', 'standard library only'],
  },
  assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'single function with an existing test' },
};
const withAssessment = (a: Partial<DelegationRequest['assessment']>): DelegationRequest => ({ ...good, assessment: { ...good.assessment, ...a } });
const withContract = (c: Partial<DelegationRequest['contract']>): DelegationRequest => ({ ...good, contract: { ...good.contract, ...c } });

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

describe('Engineering Lead delegation', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lead-delegation-'));
    await mkdir(join(root, 'calc'));
    await writeFile(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    await writeFile(join(root, 'calc', 'calc.go'), STUB);
    await writeFile(join(root, 'calc', 'calc_test.go'), TEST_SRC);
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const impl = (src: string) => writeFile(join(root, 'calc', 'calc.go'), src);
  const neverCalled: WorkerLike = {
    async generate() {
      throw new Error('worker must not be invoked');
    },
  };
  const ok = { text: 'done', finishReason: 'stop', steps: [{}] };
  const fast = { runtimeRetryDelayMs: 0 };

  describe('routing gate (deterministic, no model)', () => {
    it('clears a small, low-risk, unambiguous, well-scoped task for qwen', async () => {
      assert.deepEqual(await routeTask(good, root), { route: 'qwen' });
    });

    for (const [name, request, pattern] of [
      ['complex', withAssessment({ complexity: 'medium' }), /complexity/],
      ['architectural/large', withAssessment({ complexity: 'large' }), /complexity/],
      ['high risk', withAssessment({ risk: 'high' }), /risk/],
      ['ambiguous', withAssessment({ ambiguity: 'some' }), /ambiguity/],
      ['too many files', withContract({ allowedFiles: ['calc/calc.go', 'calc/other.go'] }), /exceeds the limit/],
      ['a test file as an allowed file', withContract({ allowedFiles: ['calc/calc_test.go'] }), /test files/],
      ['non-Go file', withContract({ allowedFiles: ['README.md'] }), /extension/],
      ['no acceptance criteria', withContract({ acceptanceCriteria: [] }), /acceptance/],
      ['no constraints', withContract({ constraints: [] }), /constraints/],
      ['missing tests-immutable constraint', withContract({ constraints: ['standard library only'] }), /immutable/],
      ['non-allow-listed verification binary', withContract({ verificationCommands: [['sh', '-c', 'echo hi']] }), /allow-listed/],
      ['missing context file', withContract({ contextFiles: ['calc/nope_test.go'] }), /does not exist/],
    ] as const) {
      it(`keeps the task with Claude: ${name}`, async () => {
        const route = await routeTask(request as DelegationRequest, root);
        assert.equal(route.route, 'claude');
        assert.match((route as { reasons: string[] }).reasons.join('\n'), pattern);
      });
    }

    it('keeps the task with Claude when an allowed file already has uncommitted changes', async () => {
      await impl(WRONG);
      const route = await routeTask(good, root);
      assert.equal(route.route, 'claude');
      assert.match((route as { reasons: string[] }).reasons.join('\n'), /uncommitted/);
    });

    it('keeps the task with Claude outside a git work tree', async () => {
      const bare = await mkdtemp(join(tmpdir(), 'not-git-'));
      try {
        await mkdir(join(bare, 'calc'));
        await writeFile(join(bare, 'calc', 'calc.go'), STUB);
        await writeFile(join(bare, 'calc', 'calc_test.go'), TEST_SRC);
        const route = await routeTask(good, bare);
        assert.equal(route.route, 'claude');
      } finally {
        await rm(bare, { recursive: true, force: true });
      }
    });

    it('a refused task never invokes the worker', async () => {
      const result = await delegateCodingTask(withAssessment({ risk: 'high' }), { repoRoot: root, worker: neverCalled, runOptions: fast });
      assert.equal(result.status, 'KEPT_BY_CLAUDE');
      assert.equal(result.run, undefined);
    });
  });

  describe('delegated runs', () => {
    it('PASS: runtime-verified change is left uncommitted for the Lead; nothing is committed', async () => {
      const headBefore = git(root, 'rev-parse', 'HEAD').trim();
      const result = await delegateCodingTask(good, { repoRoot: root, worker: { generate: async () => (await impl(RIGHT), ok) }, runOptions: fast });
      assert.equal(result.status, 'PASS');
      assert.match(result.diff, /\+\treturn n \* 2/);
      assert.equal(await readFile(join(root, 'calc', 'calc.go'), 'utf8'), RIGHT);
      assert.equal(git(root, 'rev-parse', 'HEAD').trim(), headBefore, 'must not commit');
      assert.match(git(root, 'status', '--porcelain'), /calc\.go/);
    });

    it("worker prose cannot own PASS: claiming success with a failing verifier is not PASS", async () => {
      const result = await delegateCodingTask(good, {
        repoRoot: root,
        worker: { generate: async () => (await impl(WRONG), { text: 'All tests pass! Done.', finishReason: 'stop', steps: [{}] }) },
        runOptions: fast,
      });
      assert.notEqual(result.status, 'PASS');
    });

    it('exhausting 3 coding attempts escalates to Claude with evidence and restores the tree', async () => {
      let calls = 0;
      const result = await delegateCodingTask(good, {
        repoRoot: root,
        worker: { generate: async () => (calls++, await impl(WRONG), ok) },
        artifactDir: join(root, '..', `artifacts-${Date.now()}`),
        runOptions: fast,
      });
      assert.equal(result.status, 'ESCALATED_TO_CLAUDE');
      assert.equal(calls, 3, 'bounded at 3 coding attempts');
      assert.equal(result.escalation?.reason, 'coding_attempts_exhausted');
      assert.equal(result.escalation?.codingAttempts, 3);
      assert.match(result.escalation?.lastVerifierOutput ?? '', /Double\(3\) = 4, want 6/);
      assert.match(result.escalation?.workerFinalDiff ?? '', /return n \+ 1/);
      assert.equal(result.restored, true);
      assert.equal(await readFile(join(root, 'calc', 'calc.go'), 'utf8'), STUB, 'worker change reverted');
      assert.equal(git(root, 'status', '--porcelain').trim(), '', 'working tree clean after escalation');
      const files = await readdir(result.artifactDir!);
      for (const f of ['escalation.json', 'result.json', 'contract.json', 'attempts.json', 'final.diff', 'summary.json']) assert.ok(files.includes(f), `missing ${f}`);
      await rm(result.artifactDir!, { recursive: true, force: true });
    });

    it('a fresh-context retry can still succeed within the attempt budget', async () => {
      let calls = 0;
      const result = await delegateCodingTask(good, { repoRoot: root, worker: { generate: async () => (calls++, await impl(calls === 1 ? WRONG : RIGHT), ok) }, runOptions: fast });
      assert.equal(result.status, 'PASS');
      assert.equal(result.run?.attempts, 2);
    });

    it('runtime failure is reported separately: not escalated as a coding failure, tree restored', async () => {
      const result = await delegateCodingTask(good, { repoRoot: root, worker: { generate: async () => { throw new Error('ollama down'); } }, runOptions: fast });
      assert.equal(result.status, 'RUNTIME_FAILURE');
      assert.equal(result.escalation, undefined);
      assert.equal(result.run?.attempts, 0);
      assert.equal(result.run?.runtimeRetries, 1);
      assert.equal(git(root, 'status', '--porcelain').trim(), '');
    });

    it('a forbidden mutation escalates and restores BOTH the edited test and any new file', async () => {
      const result = await delegateCodingTask(good, {
        repoRoot: root,
        worker: {
          generate: async () => {
            await impl(RIGHT);
            await writeFile(join(root, 'calc', 'calc_test.go'), TEST_SRC.replace('got != 6', 'got != 0'));
            await writeFile(join(root, 'calc', 'extra.go'), 'package calc\n');
            return ok;
          },
        },
        runOptions: fast,
      });
      assert.equal(result.status, 'ESCALATED_TO_CLAUDE');
      assert.equal(result.escalation?.reason, 'forbidden_mutation');
      assert.equal(git(root, 'status', '--porcelain').trim(), '', 'edited test reverted and new file removed');
    });
  });
});

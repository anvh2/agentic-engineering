import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingTask, type CodingTask, type WorkerLike } from '../workflows/coding-task-runner.ts';
import { delegateCodingTask, routeTask, type DelegationRequest } from '../lead/delegation.ts';
import { runGoTest } from '../tools/execution-tools.ts';
import { contextFor } from '../tools/__testing__/context-for.ts';
import { resetSandboxStatusForTests } from './sandbox.ts';

/** The sandbox is on every path that executes model-written code, and the whole pipeline fails closed without it. */

const darwin = process.platform === 'darwin';
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

describe('sandbox integration', { skip: !darwin && 'macOS only' }, () => {
  let base: string;
  let root: string;
  before(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'sbx-int-')));
    root = join(base, 'repo');
    await mkdir(join(root, 'calc'), { recursive: true });
    await writeFile(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    await writeFile(join(root, 'calc', 'calc.go'), 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n');
    await writeFile(join(root, 'calc', 'calc_test.go'), 'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif Double(3) != 6 {\n\t\tt.Fatal("bad")\n\t}\n}\n');
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  });
  afterEach(() => {
    delete process.env.HARNESS_SANDBOX_EXEC;
    resetSandboxStatusForTests();
  });
  after(() => rm(base, { recursive: true, force: true }));

  const writeRight: WorkerLike = {
    async generate() {
      await writeFile(join(root, 'calc', 'calc.go'), 'package calc\n\nfunc Double(n int) int {\n\treturn n * 2\n}\n');
      return { text: 'done', finishReason: 'stop', steps: [{}] };
    },
  };
  const task = (verify: string[][]): CodingTask => ({ taskId: 'SBX', objective: 'x', allowedFiles: ['calc/calc.go'], verificationCommands: verify, constraints: ['tests are immutable'] });

  it('verification runs inside the sandbox: a verifier writing outside the repository fails and writes nothing', async () => {
    const outside = join(base, 'escaped.txt');
    const result = await runCodingTask(task([['node', '-e', `require('fs').writeFileSync(${JSON.stringify(outside)}, 'x')`]]), { repoRoot: root, worker: writeRight, maxAttempts: 1 });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(existsSync(outside), false);
    git(root, 'checkout', '--', '.');
  });

  it('real go test verification still passes inside the sandbox', async () => {
    const result = await runCodingTask(task([['go', 'test', '-count=1', './...']]), { repoRoot: root, worker: writeRight, maxAttempts: 1 });
    assert.equal(result.verdict, 'PASS', JSON.stringify(result.verifier));
    git(root, 'checkout', '--', '.');
  });

  it('the worker tool runGoTest runs sandboxed (no harness secrets in its environment)', async () => {
    await writeFile(join(root, 'calc', 'env_test.go'), 'package calc\n\nimport (\n\t"os"\n\t"testing"\n)\n\nfunc TestEnv(t *testing.T) {\n\tif os.Getenv("HARNESS_TEST_SECRET_TOKEN") != "" {\n\t\tt.Fatal("secret leaked")\n\t}\n}\n');
    process.env.HARNESS_TEST_SECRET_TOKEN = 'leak-me-123456';
    try {
      const r = (await runGoTest.execute!({ package: './calc' }, contextFor(root))) as { exitCode: number | null; stdout: string };
      assert.match(r.stdout, /secret leaked|FAIL/, 'calc test still fails (Double returns 0), but not because of the secret');
      assert.doesNotMatch(r.stdout, /secret leaked/);
    } finally {
      delete process.env.HARNESS_TEST_SECRET_TOKEN;
      await rm(join(root, 'calc', 'env_test.go'));
    }
  });

  it('fail closed: without isolation the worker is never invoked and delegation reports RUNTIME_FAILURE sandbox_unavailable', async () => {
    process.env.HARNESS_SANDBOX_EXEC = join(base, 'missing-sandbox-exec');
    resetSandboxStatusForTests();
    let calls = 0;
    const worker: WorkerLike = { async generate() { calls++; return { text: '', finishReason: 'stop', steps: [{}] }; } };
    const run = await runCodingTask(task([['go', 'test', './...']]), { repoRoot: root, worker });
    assert.equal(calls, 0);
    assert.equal(run.verdict, 'FAIL');
    assert.match(run.sandboxUnavailable ?? '', /not available/);

    const request: DelegationRequest = {
      contract: { taskId: 'SBX-GATE', objective: 'Implement Double', allowedFiles: ['calc/calc.go'], contextFiles: ['calc/calc_test.go'], acceptanceCriteria: ['passes'], verificationCommands: [['go', 'test', './...']], constraints: ['tests are immutable'] },
      assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'r' },
    };
    const route = await routeTask(request, root);
    assert.equal(route.route, 'claude');
    assert.ok(route.route === 'claude' && route.reasons.some((r) => /OS sandbox unavailable/.test(r)));
    const delegated = await delegateCodingTask(request, { repoRoot: root, worker });
    assert.equal(delegated.status, 'KEPT_BY_CLAUDE');
    assert.equal(calls, 0);
  });
});

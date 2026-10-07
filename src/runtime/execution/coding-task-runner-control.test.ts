import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingTask, type CodingTask, type WorkerLike } from './coding-task-runner.ts';
import { createTraceSink, redact } from './coding-task-trace.ts';

const STUB = 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n';
// Passes the visible test (Double(3) == 6) but is wrong elsewhere: only the hidden test catches it.
const VISIBLE_ONLY = 'package calc\n\nfunc Double(n int) int {\n\tif n == 3 {\n\t\treturn 6\n\t}\n\treturn 1\n}\n';
const RIGHT = 'package calc\n\nfunc Double(n int) int {\n\treturn n * 2\n}\n';
const WRONG = 'package calc\n\nfunc Double(n int) int {\n\treturn n + 1\n}\n';
const VISIBLE_TEST =
  'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif got := Double(3); got != 6 {\n\t\tt.Fatalf("Double(3) = %d, want 6", got)\n\t}\n}\n';
const HIDDEN_TEST =
  'package calc\n\nimport "testing"\n\nfunc TestDoubleHidden(t *testing.T) {\n\tif got := Double(0); got != 0 {\n\t\tt.Fatalf("Double(0) = %d, want 0", got)\n\t}\n\tif got := Double(-2); got != -4 {\n\t\tt.Fatalf("Double(-2) = %d, want -4", got)\n\t}\n}\n';
const HIDDEN_PATH = 'calc/calc_hidden_test.go';

const task: CodingTask = {
  taskId: 'T-2',
  objective: 'Implement Double',
  allowedFiles: ['calc/calc.go'],
  contextFiles: ['calc/calc_test.go'],
  verificationCommands: [['go', 'test', '-count=1', './...']],
  hiddenFiles: { [HIDDEN_PATH]: HIDDEN_TEST },
};

const okResponse = { text: 'done', finishReason: 'stop', steps: [{}] };

describe('runCodingTask control semantics', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'coding-task-control-'));
    await mkdir(join(root, 'calc'));
    await writeFile(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    await writeFile(join(root, 'calc', 'calc.go'), STUB);
    await writeFile(join(root, 'calc', 'calc_test.go'), VISIBLE_TEST);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  const impl = (src: string) => writeFile(join(root, 'calc', 'calc.go'), src);

  it('runtime retry does not consume a coding attempt: one transient failure then success is PASS with attempts=1', async () => {
    let calls = 0;
    const worker: WorkerLike = {
      async generate() {
        calls += 1;
        if (calls === 1) throw new Error('ollama 500');
        await impl(RIGHT);
        return okResponse;
      },
    };
    const result = await runCodingTask(task, { repoRoot: root, worker, runtimeRetryDelayMs: 0 });
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.attempts, 1);
    assert.equal(result.runtimeRetries, 1);
    assert.equal(calls, 2);
    const types = result.events.map((e) => e.type);
    assert.ok(types.includes('runtime_retry'));
    assert.ok(!types.includes('coding_retry'), 'a runtime retry must never be reported as a coding retry');
  });

  it('runtime retry is bounded: at most 1 retry per coding attempt, never infinite', async () => {
    let calls = 0;
    const worker: WorkerLike = {
      async generate() {
        calls += 1;
        return { text: '', finishReason: 'tripwire', steps: [] };
      },
    };
    const result = await runCodingTask(task, { repoRoot: root, worker, maxAttempts: 3, runtimeRetryDelayMs: 0 });
    assert.equal(calls, 2);
    assert.equal(result.runtimeRetries, 1);
  });

  it('exhausted runtime retry is reported as runtime failure (F), not as a coding failure, and stops the task', async () => {
    const worker: WorkerLike = {
      async generate() {
        throw new Error('socket hang up');
      },
    };
    const result = await runCodingTask(task, { repoRoot: root, worker, runtimeRetryDelayMs: 0 });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.failureCategory, 'F_model_runtime');
    assert.equal(result.runtimeFailed, true);
    assert.equal(result.attempts, 0);
    assert.equal(result.verifier, null, 'verification never ran for a run with no model response');
    assert.equal(result.events.at(-1)?.type, 'task_failed');
  });

  it('keeps runtime retries and coding retries separate when both occur', async () => {
    let calls = 0;
    const worker: WorkerLike = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          await impl(WRONG); // coding attempt 1: wrong -> coding retry
        } else if (calls === 2) {
          throw new Error('transient'); // coding attempt 2, first invocation: runtime failure
        } else {
          await impl(RIGHT); // coding attempt 2, runtime retry succeeds
        }
        return okResponse;
      },
    };
    const result = await runCodingTask(task, { repoRoot: root, worker, runtimeRetryDelayMs: 0 });
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.attempts, 2, 'two coding attempts');
    assert.equal(result.runtimeRetries, 1, 'one runtime retry, counted separately');
    const types = result.events.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'coding_retry').length, 1);
    assert.equal(types.filter((t) => t === 'runtime_retry').length, 1);
  });

  it('hidden runtime-owned tests are never visible to the worker, decide PASS, and are removed afterwards', async () => {
    const seen: { hiddenPresentDuringRun: boolean; promptMentionsHidden: boolean }[] = [];
    const worker: WorkerLike = {
      async generate(prompt) {
        seen.push({
          hiddenPresentDuringRun: (await readdir(join(root, 'calc'))).includes('calc_hidden_test.go'),
          promptMentionsHidden: prompt.includes('Double(-2)') || prompt.includes('calc_hidden_test'),
        });
        await impl(VISIBLE_ONLY); // satisfies the visible test only
        return okResponse;
      },
    };
    const result = await runCodingTask(task, { repoRoot: root, worker, maxAttempts: 1, runtimeRetryDelayMs: 0 });
    assert.equal(result.verdict, 'FAIL', 'passing only the visible test must not be PASS');
    assert.equal(result.failureCategory, 'C_wrong_implementation');
    assert.match(result.verifier?.output ?? '', /TestDoubleHidden/);
    assert.deepEqual(seen, [{ hiddenPresentDuringRun: false, promptMentionsHidden: false }]);
    assert.ok(!(await readdir(join(root, 'calc'))).includes('calc_hidden_test.go'), 'hidden file removed after verification');
  });

  it('a pre-existing file at a hidden path is rejected up front', async () => {
    await writeFile(join(root, HIDDEN_PATH), 'package calc\n');
    await assert.rejects(runCodingTask(task, { repoRoot: root, worker: { generate: async () => okResponse }, runtimeRetryDelayMs: 0 }), /already exists/);
  });

  it('emits the structured trace and a final diff; verification events carry the exit code', async () => {
    const trace = createTraceSink();
    const result = await runCodingTask(task, {
      repoRoot: root,
      worker: { generate: async () => (await impl(RIGHT), okResponse) },
      trace,
      modelLabel: 'test-model',
      runtimeRetryDelayMs: 0,
    });
    assert.equal(result.verdict, 'PASS');
    const types = trace.events.map((e) => e.type);
    for (const t of ['task_started', 'attempt_started', 'model_started', 'model_finished', 'file_hash', 'verification_started', 'verification_finished', 'task_passed'] as const) {
      assert.ok(types.includes(t), `missing event ${t}`);
    }
    const verify = trace.events.find((e) => e.type === 'verification_finished' && e.data.phase === 'verify');
    assert.equal(verify?.data.exitCode, 0);
    assert.match(result.finalDiff, /\+\treturn n \* 2/);
  });

  it('latest mutation invalidates earlier verification: PASS state hash equals the final on-disk state', async () => {
    const result = await runCodingTask(task, { repoRoot: root, worker: { generate: async () => (await impl(RIGHT), okResponse) }, runtimeRetryDelayMs: 0 });
    assert.equal(result.verdict, 'PASS');
    assert.equal(await readFile(join(root, 'calc', 'calc.go'), 'utf8'), RIGHT);
    assert.ok(result.verifiedStateHash);
  });
});

describe('trace redaction', () => {
  it('redacts secret-looking environment values and token shapes', () => {
    const env = { MASTRA_PLATFORM_ACCESS_TOKEN: 'super-secret-token-value', PATH: '/usr/bin:/bin', HOME: '/Users/someone' };
    const out = redact('token=super-secret-token-value path=/usr/bin:/bin key=sk-abcdefghijklmnop Bearer abcdefghijkl', env);
    assert.ok(!out.includes('super-secret-token-value'));
    assert.ok(!out.includes('sk-abcdefghijklmnop'));
    assert.ok(!out.includes('Bearer abcdefghijkl'));
    assert.ok(out.includes('/usr/bin:/bin'), 'non-secret env values are left alone (and never enumerated)');
  });
});

describe('trace + artifact persistence', () => {
  it('writes redacted JSONL trace and the per-run artifact set without leaking environment values', async () => {
    const { readFile: rf, readdir: rd, mkdtemp: mk, rm: rmDir } = await import('node:fs/promises');
    const { persistRun } = await import('./coding-task-artifacts.ts');
    const { buildFixture } = await import('../../../tests/bench/go-ladder.ts');
    const dir = await mk(join(tmpdir(), 'artifacts-'));
    process.env.TEST_SECRET_TOKEN = 'leak-me-please-12345';
    const fx = await buildFixture('L1');
    try {
      const trace = createTraceSink({ jsonlPath: join(dir, 'trace.jsonl') });
      const result = await runCodingTask(fx.task, {
        repoRoot: fx.root,
        worker: { generate: async () => ({ text: 'status: leak-me-please-12345', finishReason: 'stop', steps: [{}] }) },
        maxAttempts: 1,
        trace,
        runtimeRetryDelayMs: 0,
      });
      await persistRun(dir, { level: 'L1', verdict: result.verdict }, fx.task, result);
      const files = (await rd(dir)).sort();
      assert.deepEqual(files, ['attempts.json', 'contract.json', 'final.diff', 'summary.json', 'trace.jsonl']);
      for (const f of files) assert.ok(!(await rf(join(dir, f), 'utf8')).includes('leak-me-please-12345'), `${f} leaked a secret`);
      const lines = (await rf(join(dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(lines[0].type, 'task_started');
      assert.equal(lines.at(-1).type, 'task_failed');
    } finally {
      delete process.env.TEST_SECRET_TOKEN;
      await fx.cleanup();
      await rmDir(dir, { recursive: true, force: true });
    }
  });
});

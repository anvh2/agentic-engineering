import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingTask, type CodingTask, type WorkerLike } from './coding-task-runner.ts';

const STUB = 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n';
const WRONG = 'package calc\n\nfunc Double(n int) int {\n\treturn n + 1\n}\n';
const RIGHT = 'package calc\n\nfunc Double(n int) int {\n\treturn n * 2\n}\n';
// Deliberately badly formatted but correct: the runtime formatter must fix it.
const RIGHT_UNFORMATTED = 'package calc\nfunc Double(n int) int {\nreturn n*2\n}\n';
const TEST_SRC =
  'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif got := Double(3); got != 6 {\n\t\tt.Fatalf("Double(3) = %d, want 6", got)\n\t}\n}\n';

const task: CodingTask = {
  taskId: 'T-1',
  objective: 'Implement Double',
  allowedFiles: ['calc/calc.go'],
  contextFiles: ['calc/calc_test.go'],
  acceptanceCriteria: ['TestDouble passes'],
  verificationCommands: [['go', 'test', '-count=1', './calc']],
  constraints: ['tests are immutable'],
};

type Script = (ctx: { call: number; prompt: string; root: string }) => Promise<void> | void;

describe('runCodingTask (runtime-owned control loop, model boundary stubbed)', () => {
  let root: string;
  const prompts: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'coding-task-runner-'));
    await mkdir(join(root, 'calc'));
    await writeFile(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    await writeFile(join(root, 'calc', 'calc.go'), STUB);
    await writeFile(join(root, 'calc', 'calc_test.go'), TEST_SRC);
    prompts.length = 0;
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  function workerFrom(script: Script, text = 'All tests pass, implementation complete.'): WorkerLike {
    let call = 0;
    return {
      async generate(prompt) {
        call += 1;
        prompts.push(prompt);
        await script({ call, prompt, root });
        return { text, finishReason: 'stop', steps: [{}] };
      },
    };
  }
  const writeImpl = (src: string) => writeFile(join(root, 'calc', 'calc.go'), src);

  it('PASS on first attempt when the runtime-run test passes; the runtime formats the result', async () => {
    const result = await runCodingTask(task, { repoRoot: root, worker: workerFrom(() => writeImpl(RIGHT_UNFORMATTED)) });
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.attempts, 1);
    assert.equal(result.implementationChanged, true);
    assert.deepEqual(result.forbiddenFilesChanged, []);
    assert.equal(result.records[0].formatter?.ok, true);
    assert.equal(await readFile(join(root, 'calc', 'calc.go'), 'utf8'), RIGHT, 'gofmt must have run on the final state');
    assert.ok(result.verifiedStateHash);
  });

  it('injects approved HLD/LLD and Go conventions into the actual worker prompt on each attempt', async () => {
    const approvedDesign = {
      approvalRef: 'ADR-12@sha-123',
      hld: 'The scheduler exclusively owns capacity assignment.',
      lld: 'Never exceed two permits and preserve oldest-ticket fairness.',
      adr: ['Do not expose the hidden Oracle to the worker.'],
    };
    const result = await runCodingTask(
      { ...task, approvedDesign },
      { repoRoot: root, worker: workerFrom(({ call }) => writeImpl(call === 1 ? WRONG : RIGHT)) },
    );
    assert.equal(result.verdict, 'PASS');
    assert.equal(prompts.length, 2);
    const hashes: string[] = [];
    for (const prompt of prompts) {
      assert.match(prompt, /The scheduler exclusively owns capacity assignment/);
      assert.match(prompt, /Never exceed two permits/);
      assert.match(prompt, /ADR-12@sha-123/);
      assert.match(prompt, /idiomatic Go naming/);
      assert.match(prompt, /runtime verifier and independent reviewer/);
      const hash = prompt.match(/Engineering context SHA-256: ([a-f0-9]{64})/);
      assert.ok(hash, 'the injected context must be fingerprinted');
      hashes.push(hash[1]);
    }
    assert.equal(hashes[0], hashes[1], 'repair attempts keep the same approved design');
  });

  it("model prose claiming success cannot produce PASS; attempts are bounded and categorized", async () => {
    const result = await runCodingTask(task, { repoRoot: root, worker: workerFrom(() => {}) });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.attempts, 3);
    assert.equal(result.modelCalls, 3);
    assert.equal(result.failureCategory, 'A_no_mutation');
    assert.equal(result.implementationChanged, false);
    assert.equal(result.verifier?.exitCode, 1);
  });

  it('retries with FRESH context carrying only the objective, current source and the concrete verifier failure', async () => {
    const result = await runCodingTask(task, {
      repoRoot: root,
      worker: workerFrom(({ call }) => writeImpl(call === 1 ? WRONG : RIGHT)),
    });
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.attempts, 2);
    assert.equal(result.records[0].verification?.exitCode, 1);
    assert.doesNotMatch(prompts[0], /previous attempt/);
    assert.match(prompts[1], /Implement Double/);
    assert.match(prompts[1], /return n \+ 1/, 'attempt 2 shows the CURRENT (attempt 1) source');
    assert.match(prompts[1], /Double\(3\) = 4, want 6/, 'attempt 2 carries the exact verifier failure');
    assert.equal(prompts[1].match(/--- calc\/calc\.go/g)?.length, 1, 'no accumulated history: one copy of the source');
  });

  it('modifying the test file is a forbidden mutation: FAIL immediately, no further attempts', async () => {
    const result = await runCodingTask(task, {
      repoRoot: root,
      worker: workerFrom(async () => {
        await writeImpl(RIGHT);
        await writeFile(join(root, 'calc', 'calc_test.go'), TEST_SRC.replace('want 6', 'want 0').replace('got != 6', 'got != 0'));
      }),
    });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.failureCategory, 'D_forbidden_mutation');
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.forbiddenFilesChanged, ['calc/calc_test.go']);
  });

  it('creating an unrelated file is forbidden too', async () => {
    const result = await runCodingTask(task, {
      repoRoot: root,
      worker: workerFrom(async () => {
        await writeImpl(RIGHT);
        await writeFile(join(root, 'calc', 'extra.go'), 'package calc\n');
      }),
    });
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.forbiddenFilesChanged, ['calc/extra.go']);
  });

  it("a worker-side 'test passed' tool result followed by a later breaking edit is not PASS (latest mutation invalidates)", async () => {
    const worker: WorkerLike = {
      async generate(_prompt, options) {
        await writeFile(join(root, 'calc', 'calc.go'), RIGHT);
        const onIteration = options.onIterationComplete as (c: unknown) => Promise<unknown> | unknown;
        await onIteration({
          iteration: 1,
          text: '',
          toolCalls: [],
          toolResults: [{ id: 't', name: 'runGoTest', result: { success: true, exitCode: 0, stdout: 'ok', stderr: '' } }],
          isFinal: false,
          finishReason: 'tool-calls',
          runId: 'r',
          agentId: 'a',
          agentName: 'a',
          messages: [],
        });
        await writeFile(join(root, 'calc', 'calc.go'), WRONG); // mutation AFTER the worker's own green run
        return { text: 'tests pass', finishReason: 'stop', steps: [{}] };
      },
    };
    const result = await runCodingTask(task, { repoRoot: root, worker, maxAttempts: 1 });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.failureCategory, 'C_wrong_implementation');
    assert.equal(result.verifiedStateHash, null);
  });

  it('a verifier command that cannot start is classified as verifier infrastructure failure', async () => {
    const result = await runCodingTask(
      { ...task, verificationCommands: [['definitely-not-a-real-binary-xyz']] },
      { repoRoot: root, worker: workerFrom(() => writeImpl(RIGHT)), maxAttempts: 1 },
    );
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.failureCategory, 'E_verifier_infrastructure');
  });

  it('a worker that throws (model/runtime failure) is categorized F after one bounded runtime retry, consuming no coding attempt', async () => {
    let calls = 0;
    const worker: WorkerLike = {
      async generate() {
        calls += 1;
        throw new Error('connection refused');
      },
    };
    const result = await runCodingTask(task, { repoRoot: root, worker, runtimeRetryDelayMs: 0 });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.failureCategory, 'F_model_runtime');
    assert.equal(result.runtimeFailed, true);
    assert.equal(result.runtimeRetries, 1);
    assert.equal(result.attempts, 0, 'a runtime failure is not a coding attempt');
    assert.equal(calls, 2, 'one initial invocation + exactly one runtime retry');
  });

  it('a response with zero model steps (e.g. provider error surfaced as tripwire) is runtime failure F, not A', async () => {
    const worker: WorkerLike = {
      async generate() {
        return { text: '', finishReason: 'tripwire', steps: [] };
      },
    };
    const result = await runCodingTask(task, { repoRoot: root, worker, maxAttempts: 2, runtimeRetryDelayMs: 0 });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.failureCategory, 'F_model_runtime');
    assert.match(result.records[0].runtimeError ?? '', /tripwire/);
    assert.equal(result.attempts, 0);
  });

  it('preserves legacy nondelegated .txt runtime fixtures without inventing language conventions', async () => {
    await writeFile(join(root, 'calc', 'legacy.txt'), 'initial\n');
    let seenPrompt = '';
    const result = await runCodingTask(
      { ...task, allowedFiles: ['calc/legacy.txt'], verificationCommands: [['go', 'test', '-count=1', './calc']] },
      { repoRoot: root, maxAttempts: 1, worker: { async generate(prompt) {
        seenPrompt = prompt;
        await writeFile(join(root, 'calc', 'legacy.txt'), 'updated\n');
        return { text: 'done', finishReason: 'stop', steps: [{}] };
      } } },
    );
    assert.equal(result.modelCalls, 1, 'a legacy fixture still reaches its model boundary');
    assert.doesNotMatch(seenPrompt, /Engineering context SHA-256/);
  });

  it('refuses silently omitting approved architecture on unknown language files', async () => {
    await writeFile(join(root, 'calc', 'legacy.txt'), 'initial\n');
    await assert.rejects(
      runCodingTask(
        { ...task, allowedFiles: ['calc/legacy.txt'],
          approvedDesign: { approvalRef: 'ADR-01', hld: 'Design', lld: 'Implementation details' } },
        { repoRoot: root, worker: workerFrom(() => {}) },
      ),
      /approvedDesign requires one registered implementation language/,
    );
  });

  it('rejects contracts whose allowedFiles escape the repository', async () => {
    await assert.rejects(runCodingTask({ ...task, allowedFiles: ['../x.go'] }, { repoRoot: root, worker: workerFrom(() => {}) }));
  });

  it('counts applyPatch rejections from tool telemetry', async () => {
    const worker: WorkerLike = {
      async generate() {
        return {
          text: 'done',
          finishReason: 'stop',
          steps: [
            {
              content: [
                { type: 'tool-call', toolName: 'applyPatch', input: {} },
                { type: 'tool-result', toolName: 'applyPatch', output: { type: 'json', value: 'Patch is empty. Nothing to apply.' } },
              ],
            },
          ],
        };
      },
    };
    const result = await runCodingTask(task, { repoRoot: root, worker, maxAttempts: 1 });
    assert.equal(result.editFailures, 1);
    assert.equal(result.failureCategory, 'B_patch_rejected');
  });
});

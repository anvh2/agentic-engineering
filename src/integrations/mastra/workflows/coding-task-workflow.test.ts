import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodingTaskWorkflow, codingTaskWorkflow, type CodingTaskWorkflowInput } from './coding-task-workflow.ts';
import type { WorkerLike } from '../../../runtime/execution/coding-task-runner.ts';

const STUB = 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n';
const RIGHT = 'package calc\n\nfunc Double(n int) int {\n\treturn n * 2\n}\n';
const WRONG = 'package calc\n\nfunc Double(n int) int {\n\treturn n + 1\n}\n';
const TEST_SRC =
  'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif got := Double(3); got != 6 {\n\t\tt.Fatalf("Double(3) = %d, want 6", got)\n\t}\n}\n';
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

describe('coding-task-workflow (Mastra boundary; model stubbed, runner + verifier real)', () => {
  let root: string;
  let artifacts: string;
  let input: CodingTaskWorkflowInput;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ctw-repo-'));
    artifacts = await mkdtemp(join(tmpdir(), 'ctw-artifacts-'));
    await mkdir(join(root, 'calc'));
    await writeFile(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    await writeFile(join(root, 'calc', 'calc.go'), STUB);
    await writeFile(join(root, 'calc', 'calc_test.go'), TEST_SRC);
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    input = {
      repository: root,
      contract: {
        taskId: 'WF-1',
        objective: 'Implement Double in calc/calc.go',
        allowedFiles: ['calc/calc.go'],
        contextFiles: ['calc/calc_test.go'],
        acceptanceCriteria: ['TestDouble passes'],
        verificationCommands: [['go', 'test', '-count=1', './...']],
        constraints: ['tests are immutable', 'standard library only'],
      },
      assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one function with an existing test' },
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  });

  const impl = (src: string) => writeFile(join(root, 'calc', 'calc.go'), src);
  const ok = { text: 'done', finishReason: 'stop', steps: [{}] };
  const workflowWith = (generate: WorkerLike['generate'], calls?: { n: number }) =>
    createCodingTaskWorkflow({
      resolveWorker: () => ({
        generate: async (p, o) => {
          if (calls) calls.n += 1;
          return generate(p, o);
        },
      }),
      artifactRoot: artifacts,
      runOptions: { runtimeRetryDelayMs: 0 },
    });
  const run = async (wf: ReturnType<typeof createCodingTaskWorkflow>, data: CodingTaskWorkflowInput = input) => {
    const r = await (await wf.createRun()).start({ inputData: data as never });
    assert.equal(r.status, 'success', `workflow run itself should complete: ${JSON.stringify((r as { error?: unknown }).error)}`);
    return r as Extract<typeof r, { status: 'success' }>;
  };

  it('is registered under the id coding-task-workflow with the three coarse steps', () => {
    assert.equal(codingTaskWorkflow.id, 'coding-task-workflow');
    const steps = Object.keys((codingTaskWorkflow as unknown as { steps: Record<string, unknown> }).steps);
    assert.deepEqual(steps, ['prepare-coding-task', 'run-coding-worker', 'finalize-result']);
  });

  it('a real CodingTask enters the workflow and PASS propagates; the verified change is left uncommitted', async () => {
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const r = await run(workflowWith(async () => (await impl(RIGHT), ok)));
    assert.equal(r.result.status, 'PASS');
    assert.equal(r.result.phase, 'passed');
    assert.equal(r.result.codingAttempts, 1);
    assert.match(r.result.diff, /\+\treturn n \* 2/);
    assert.equal(git(root, 'rev-parse', 'HEAD').trim(), head, 'workflow must not commit');
    for (const id of ['prepare-coding-task', 'run-coding-worker', 'finalize-result']) {
      assert.equal((r.steps as Record<string, { status: string }>)[id].status, 'success');
    }
  });

  it('delegates to the existing runner: its trace (task_started ... verification_finished ... task_passed) and artifacts are produced', async () => {
    const r = await run(workflowWith(async () => (await impl(RIGHT), ok)));
    const dir = r.result.artifactDir!;
    const types = (await readFile(join(dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).type);
    for (const t of ['task_started', 'attempt_started', 'model_started', 'verification_finished', 'task_passed']) assert.ok(types.includes(t), `missing ${t}`);
    assert.ok((await readdir(dir)).includes('contract.json'));
  });

  it('the runner stays the authority: a worker claiming success while the verifier fails is never PASS', async () => {
    const r = await run(workflowWith(async () => (await impl(WRONG), { text: 'All tests pass, done!', finishReason: 'stop', steps: [{}] })));
    assert.notEqual(r.result.status, 'PASS');
    assert.equal(r.result.verifier?.exitCode, 1);
  });

  it('exhausted coding retries propagate as an explicit escalation (exactly 3 attempts, tree restored)', async () => {
    const calls = { n: 0 };
    const r = await run(workflowWith(async () => (await impl(WRONG), ok), calls));
    assert.equal(r.result.status, 'ESCALATED_TO_CLAUDE');
    assert.equal(r.result.phase, 'escalated');
    assert.equal(r.result.codingAttempts, 3);
    assert.equal(calls.n, 3, 'the worker is invoked once per coding attempt - the workflow adds no retry loop of its own');
    assert.equal(r.result.restored, true);
    assert.equal(git(root, 'status', '--porcelain').trim(), '');
    assert.ok(r.result.escalation);
  });

  it('a fresh-context retry can recover inside the same workflow run', async () => {
    const calls = { n: 0 };
    const r = await run(workflowWith(async () => (await impl(calls.n === 1 ? WRONG : RIGHT), ok), calls));
    assert.equal(r.result.status, 'PASS');
    assert.equal(r.result.codingAttempts, 2);
  });

  it('forbidden mutations can never become workflow PASS', async () => {
    const r = await run(
      workflowWith(async () => {
        await impl(RIGHT);
        await writeFile(join(root, 'calc', 'calc_test.go'), TEST_SRC.replace('got != 6', 'got != 0'));
        return ok;
      }),
    );
    assert.equal(r.result.status, 'ESCALATED_TO_CLAUDE');
    assert.deepEqual(r.result.reasons, ['forbidden_mutation']);
    assert.equal(git(root, 'status', '--porcelain').trim(), '', 'edited test restored');
  });

  it('runtime failures stay distinct: bounded to one runtime retry, not escalated as a coding failure', async () => {
    const calls = { n: 0 };
    const r = await run(workflowWith(async () => { throw new Error('ollama down'); }, calls));
    assert.equal(r.result.status, 'RUNTIME_FAILURE');
    assert.equal(r.result.phase, 'runtime_failed');
    assert.equal(r.result.codingAttempts, 0);
    assert.equal(r.result.runtimeRetries, 1);
    assert.equal(calls.n, 2);
    assert.equal(r.result.escalation, undefined);
  });

  it('Engineering Lead routing: only eligible scoped tasks reach the worker; the rest stay with Claude and the worker is never called', async () => {
    const ineligible: [string, CodingTaskWorkflowInput][] = [
      ['complex', { ...input, assessment: { ...input.assessment, complexity: 'large' } }],
      ['risky', { ...input, assessment: { ...input.assessment, risk: 'high' } }],
      ['ambiguous', { ...input, assessment: { ...input.assessment, ambiguity: 'significant' } }],
      ['multi-file', { ...input, contract: { ...input.contract, allowedFiles: ['calc/calc.go', 'calc/more.go'] } }],
      ['no constraints', { ...input, contract: { ...input.contract, constraints: [] } }],
    ];
    for (const [name, data] of ineligible) {
      const calls = { n: 0 };
      const r = await run(workflowWith(async () => (await impl(RIGHT), ok), calls), data);
      assert.equal(r.result.status, 'KEPT_BY_CLAUDE', name);
      assert.equal(r.result.phase, 'kept_by_claude', name);
      assert.equal(calls.n, 0, `${name}: worker must not be invoked`);
      assert.ok(r.result.reasons.length > 0, name);
    }
    const eligible = await run(workflowWith(async () => (await impl(RIGHT), ok)));
    assert.equal(eligible.result.status, 'PASS');
  });

  it('streams operational phases (preparing -> worker_running -> verifying -> passed) for Studio', async () => {
    const wf = workflowWith(async () => (await impl(RIGHT), ok));
    const stream = (await wf.createRun()).stream({ inputData: input as never });
    const phases: string[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<{ payload?: { output?: { type?: string; phase?: string } } }>) {
      const out = chunk.payload?.output;
      if (out?.type === 'coding-phase' && out.phase && phases.at(-1) !== out.phase) phases.push(out.phase);
    }
    assert.deepEqual(phases, ['preparing', 'worker_running', 'verifying', 'passed']);
  });

  it('introduces no coding/verification/retry logic of its own (single source of execution semantics)', async () => {
    const src = await readFile(new URL('./coding-task-workflow.ts', import.meta.url), 'utf8');
    // Imports of execution/verification/retry internals, loops over attempts, or Mastra step retries would mean a second implementation.
    for (const forbidden of [/from '\.\.\/tools\/execution-tools/, /repair-loop-tracker/, /import \{[^}]*runCodingTask[^}]*\}/, /for \(let attempt/, /^\s*(while|do) *[({]/m, /^\s+retries\s*:/m]) {
      assert.doesNotMatch(src, forbidden, `workflow must not contain ${forbidden}`);
    }
    assert.match(src, /executeDelegation\(/);
  });
});

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodingTaskWorkflow, type CodingTaskWorkflowInput } from './coding-task-workflow.ts';
import type { WorkerLike } from '../../../runtime/execution/coding-task-runner.ts';

/**
 * Observed on 2026-10-06: every `mastra dev` hot reload re-executed the harness step of every run still marked
 * "running" (Mastra's restartAllActiveWorkflowRuns), including runs the Lead had already abandoned and whose files it had
 * restored. One resurrected run wrote into the user's real checkout 4 minutes after the restore and made an unrelated
 * task fail its scope gate. The step must run at most once per run id, and a cancelled run must actually stop.
 */

const STUB = 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n';
const RIGHT = 'package calc\n\nfunc Double(n int) int {\n\treturn n * 2\n}\n';
const TEST_SRC = 'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif got := Double(3); got != 6 {\n\t\tt.Fatalf("Double(3) = %d, want 6", got)\n\t}\n}\n';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });

describe('coding-task-workflow: restarted and cancelled runs', () => {
  let root: string;
  let artifacts: string;
  let input: CodingTaskWorkflowInput;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ctw-restart-'));
    artifacts = await mkdtemp(join(tmpdir(), 'ctw-restart-artifacts-'));
    await mkdir(join(root, 'calc'));
    await writeFile(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    await writeFile(join(root, 'calc', 'calc.go'), STUB);
    await writeFile(join(root, 'calc', 'calc_test.go'), TEST_SRC);
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    input = {
      repository: root,
      contract: {
        taskId: 'WF-R',
        objective: 'Implement Double',
        allowedFiles: ['calc/calc.go'],
        contextFiles: ['calc/calc_test.go'],
        acceptanceCriteria: ['TestDouble passes'],
        verificationCommands: [['go', 'test', '-count=1', './...']],
        constraints: ['tests are immutable'],
      },
      assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one function' },
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  });

  const workflow = (generate: WorkerLike['generate']) =>
    createCodingTaskWorkflow({ resolveWorker: () => ({ generate }), artifactRoot: artifacts, runOptions: { runtimeRetryDelayMs: 0 } });

  it('a second execution of the worker step for the same run id (server restart) is refused and touches nothing', async () => {
    let calls = 0;
    const generate: WorkerLike['generate'] = async () => {
      calls += 1;
      await writeFile(join(root, 'calc', 'calc.go'), RIGHT);
      return { text: 'done', finishReason: 'stop', steps: [{}] };
    };
    const first = await (await workflow(generate).createRun({ runId: 'run-1' })).start({ inputData: input as never });
    assert.equal(first.status, 'success');
    assert.equal((first as { result: { status: string } }).result.status, 'PASS');
    git(root, 'checkout', '--', 'calc/calc.go'); // the Lead reviewed / restored the tree meanwhile

    // a fresh server process (new workflow instance, same artifact root) re-drives the same run id
    const again = await (await workflow(generate).createRun({ runId: 'run-1' })).start({ inputData: input as never });
    assert.equal(again.status, 'success');
    const result = (again as { result: { status: string; reasons: string[] } }).result;
    assert.equal(result.status, 'RUNTIME_FAILURE');
    assert.match(result.reasons[0], /run_restarted/);
    assert.equal(calls, 1, 'the worker was not invoked again');
    assert.equal(await readFile(join(root, 'calc', 'calc.go'), 'utf8'), STUB, 'repository untouched by the re-execution');
  });

  it('different run ids are independent (the guard is per run, not per task)', async () => {
    const generate: WorkerLike['generate'] = async () => {
      await writeFile(join(root, 'calc', 'calc.go'), RIGHT);
      return { text: 'done', finishReason: 'stop', steps: [{}] };
    };
    for (const runId of ['run-a', 'run-b']) {
      const r = await (await workflow(generate).createRun({ runId })).start({ inputData: input as never });
      assert.equal((r as { result: { status: string } }).result.status, 'PASS');
      git(root, 'checkout', '--', 'calc/calc.go');
    }
  });

  it('cancelling a running run aborts the model call and restores the half-edited allowed file', async () => {
    let started!: () => void;
    const workerStarted = new Promise<void>((r) => (started = r));
    const generate: WorkerLike['generate'] = async (_prompt, options) => {
      await writeFile(join(root, 'calc', 'calc.go'), 'package calc\n// half-written\n');
      started();
      const signal = options.abortSignal as AbortSignal;
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted by cancel')), { once: true }));
      throw new Error('unreachable');
    };
    const run = await workflow(generate).createRun({ runId: 'run-c' });
    const pending = run.start({ inputData: input as never });
    await workerStarted;
    await run.cancel();
    const r = await pending;
    assert.equal(r.status, 'canceled');
    assert.equal(await readFile(join(root, 'calc', 'calc.go'), 'utf8'), STUB, 'the partial edit was restored, not left behind');
  });
});

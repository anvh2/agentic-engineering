import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OnIterationCompleteHandler } from '@mastra/core/agent';
import { codingTaskWorkflow } from './coding-task-workflow.ts';
import { codingWorker } from '../agents/coding-worker.ts';

/**
 * Exercises the real workflow end-to-end (codingTaskWorkflow.createRun().start),
 * stubbing only the model boundary (codingWorker.generate) - same pattern as
 * coding-task-workflow.test.ts. This file specifically verifies that the
 * workflow step wires the repair-loop tracker's onIterationComplete option
 * through to generate() and surfaces its state (attempts/status/lastTestResult)
 * on the step's output, by having the stub simulate the tool-call sequence a
 * real agent run would produce and driving the real onIterationComplete
 * callback with it.
 */
describe('codingTaskWorkflow repair-loop wiring (model boundary stubbed)', () => {
  const originalGenerate = codingWorker.generate.bind(codingWorker);
  let capturedOnIterationComplete: OnIterationCompleteHandler | undefined;

  function stubGenerateWith(toolResultBatches: Array<{ id: string; name: string; result: unknown; error?: Error }[]>) {
    (codingWorker as unknown as { generate: typeof codingWorker.generate }).generate = (async (
      _messages: unknown,
      options?: { onIterationComplete?: OnIterationCompleteHandler },
    ) => {
      capturedOnIterationComplete = options?.onIterationComplete;
      let lastControl: Awaited<ReturnType<OnIterationCompleteHandler>> | undefined;
      for (let i = 0; i < toolResultBatches.length; i += 1) {
        lastControl = await options?.onIterationComplete?.({
          iteration: i + 1,
          text: '',
          toolCalls: [],
          toolResults: toolResultBatches[i],
          isFinal: i === toolResultBatches.length - 1,
          finishReason: 'tool-calls',
          runId: 'stub-run',
          agentId: 'coding-worker',
          agentName: 'Coding Worker',
          messages: [],
        });
        if (lastControl?.continue === false) break;
      }
      return { text: 'stubbed final answer', finishReason: 'stop' };
    }) as typeof codingWorker.generate;
  }

  after(async () => {
    (codingWorker as unknown as { generate: typeof codingWorker.generate }).generate = originalGenerate;
  });

  it('patch -> format -> test success: reports status test_passed with zero repair attempts', async () => {
    stubGenerateWith([
      [{ id: 'a1', name: 'applyPatch', result: { success: true, path: 'x.go', created: false, diff: '' } }],
      [{ id: 'f1', name: 'runGoFmt', result: { success: true, path: 'x.go', changed: false, stderr: '' } }],
      [{ id: 't1', name: 'runGoTest', result: { success: true, exitCode: 0, stdout: 'ok', stderr: '' } }],
    ]);

    const run = await codingTaskWorkflow.createRun();
    const result = await run.start({ inputData: { task: 'add a function' } });

    assert.equal(result.status, 'success');
    assert.ok(capturedOnIterationComplete, 'expected the workflow to pass onIterationComplete to generate()');
    if (result.status !== 'success') return;
    assert.equal(result.result.status, 'test_passed');
    assert.equal(result.result.attempts, 0);
    assert.equal(result.result.lastTestResult?.success, true);
    assert.equal(result.result.patchApplied, true);
    assert.equal(result.result.gofmtCompleted, true);
    assert.equal(result.result.goTestPassed, true);
    assert.equal(result.result.success, true);
  });

  it('patch -> format -> test failure -> repair -> format -> test success: reports one repair attempt', async () => {
    stubGenerateWith([
      [{ id: 'a1', name: 'applyPatch', result: { success: true, path: 'x.go', created: false, diff: '' } }],
      [{ id: 'f1', name: 'runGoFmt', result: { success: true, path: 'x.go', changed: false, stderr: '' } }],
      [{ id: 't1', name: 'runGoTest', result: { success: false, exitCode: 1, stdout: '--- FAIL', stderr: '' } }],
      [{ id: 'a2', name: 'applyPatch', result: { success: true, path: 'x.go', created: false, diff: '' } }],
      [{ id: 'f2', name: 'runGoFmt', result: { success: true, path: 'x.go', changed: true, stderr: '' } }],
      [{ id: 't2', name: 'runGoTest', result: { success: true, exitCode: 0, stdout: 'ok', stderr: '' } }],
    ]);

    const run = await codingTaskWorkflow.createRun();
    const result = await run.start({ inputData: { task: 'add a function' } });

    assert.equal(result.status, 'success');
    if (result.status !== 'success') return;
    assert.equal(result.result.status, 'test_passed');
    assert.equal(result.result.attempts, 1);
    assert.equal(result.result.lastTestResult?.success, true);
    assert.equal(result.result.success, true, 'a passing test after one repair round is still an objective success');
  });

  it('caps repair attempts: a model that keeps failing tests past the configured limit is force-stopped', async () => {
    const originalMax = process.env.MAX_REPAIR_ATTEMPTS;
    process.env.MAX_REPAIR_ATTEMPTS = '1';
    try {
      stubGenerateWith([
        [{ id: 't1', name: 'runGoTest', result: { success: false, exitCode: 1, stdout: 'FAIL 1', stderr: '' } }],
        // Ignores the "stop now" feedback and tries again anyway.
        [{ id: 't2', name: 'runGoTest', result: { success: false, exitCode: 1, stdout: 'FAIL 2', stderr: '' } }],
        // Should never be reached - the tracker force-stops before this iteration runs.
        [{ id: 't3', name: 'runGoTest', result: { success: false, exitCode: 1, stdout: 'FAIL 3', stderr: '' } }],
      ]);

      const run = await codingTaskWorkflow.createRun();
      const result = await run.start({ inputData: { task: 'add a function' } });

      assert.equal(result.status, 'success');
      if (result.status !== 'success') return;
      assert.equal(result.result.status, 'blocked');
      assert.equal(result.result.attempts, 2, 'blocked after the limit-reaching attempt plus one forced-stop attempt');
      assert.match(result.result.lastTestResult?.stdout ?? '', /FAIL 2/);
      assert.equal(result.result.success, false, 'a blocked run with no passing test must never be an objective success');
    } finally {
      if (originalMax === undefined) delete process.env.MAX_REPAIR_ATTEMPTS;
      else process.env.MAX_REPAIR_ATTEMPTS = originalMax;
    }
  });
});

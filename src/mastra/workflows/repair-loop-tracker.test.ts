import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IterationCompleteContext } from '@mastra/core/agent';
import { createRepairLoopTracker } from './repair-loop-tracker.ts';

function iterationWith(
  toolResults: IterationCompleteContext['toolResults'],
  overrides: Partial<IterationCompleteContext> = {},
): IterationCompleteContext {
  return {
    iteration: 1,
    text: '',
    toolCalls: [],
    toolResults,
    isFinal: false,
    finishReason: 'tool-calls',
    runId: 'test-run',
    agentId: 'coding-worker',
    agentName: 'Coding Worker',
    messages: [],
    ...overrides,
  };
}

function passingTestResult(id = 't1') {
  return { id, name: 'runGoTest', result: { success: true, exitCode: 0, stdout: 'ok', stderr: '' } };
}

function failingTestResult(id = 't1') {
  return {
    id,
    name: 'runGoTest',
    result: { success: false, exitCode: 1, stdout: '--- FAIL', stderr: '' },
  };
}

describe('createRepairLoopTracker', () => {
  it('starts pending and ignores iterations with no runGoTest call (e.g. readFile)', () => {
    const { state, onIterationComplete } = createRepairLoopTracker(3);
    const result = onIterationComplete(iterationWith([{ id: 'r1', name: 'readFile', result: { path: 'x.go', content: '', truncated: false, totalBytes: 0 } }]));

    assert.equal(result, undefined);
    assert.deepEqual(state, { attempts: 0, status: 'pending', patchApplied: false, gofmtCompleted: false });
  });

  it('a successful applyPatch sets patchApplied without counting an attempt or changing status', () => {
    const { state, onIterationComplete } = createRepairLoopTracker(3);
    const result = onIterationComplete(
      iterationWith([{ id: 'a1', name: 'applyPatch', result: { success: true, path: 'x.go', created: false, diff: '' } }]),
    );

    assert.equal(result, undefined);
    assert.deepEqual(state, { attempts: 0, status: 'pending', patchApplied: true, gofmtCompleted: false });
  });

  it('a successful runGoFmt sets gofmtCompleted without counting an attempt or changing status', () => {
    const { state, onIterationComplete } = createRepairLoopTracker(3);
    const result = onIterationComplete(
      iterationWith([{ id: 'f1', name: 'runGoFmt', result: { success: true, path: 'x.go', changed: false, stderr: '' } }]),
    );

    assert.equal(result, undefined);
    assert.deepEqual(state, { attempts: 0, status: 'pending', patchApplied: false, gofmtCompleted: true });
  });

  it('a rejected applyPatch counts as a repair attempt and surfaces the exact tool error as feedback', async () => {
    const { state, onIterationComplete } = createRepairLoopTracker(3);
    const result = await onIterationComplete(
      iterationWith([{ id: 'a1', name: 'applyPatch', result: 'Patch is empty. Nothing to apply.' }]),
    );

    assert.equal(state.attempts, 1);
    assert.equal(state.patchApplied, false, 'a rejected patch must never set patchApplied');
    assert.equal(result?.continue, undefined, 'below the limit, the model should get a turn to retry');
    assert.match(result?.feedback ?? '', /applyPatch failed:/);
    assert.match(result?.feedback ?? '', /Patch is empty\. Nothing to apply\./, 'the exact tool error must be preserved, not summarized');
  });

  it('a rejected applyPatch and a failing test share the same bounded repair budget', async () => {
    const { state, onIterationComplete } = createRepairLoopTracker(2);

    await onIterationComplete(iterationWith([{ id: 'a1', name: 'applyPatch', result: 'Patch is empty. Nothing to apply.' }]));
    assert.equal(state.attempts, 1);

    const result = await onIterationComplete(iterationWith([failingTestResult('t1')]));
    assert.equal(state.attempts, 2, 'the applyPatch failure and the test failure count against the same limit');
    assert.equal(state.status, 'blocked');
    assert.equal(result?.continue, undefined);
  });

  it('transitions patch -> format -> test success straight to test_passed, without counting an attempt', () => {
    const { state, onIterationComplete } = createRepairLoopTracker(3);

    onIterationComplete(iterationWith([{ id: 'a1', name: 'applyPatch', result: { success: true, path: 'x.go', created: false, diff: '' } }]));
    onIterationComplete(iterationWith([{ id: 'f1', name: 'runGoFmt', result: { success: true, path: 'x.go', changed: true, stderr: '' } }]));
    const result = onIterationComplete(iterationWith([passingTestResult()]));

    assert.equal(result, undefined);
    assert.equal(state.status, 'test_passed');
    assert.equal(state.attempts, 0);
    assert.equal(state.lastTestResult?.success, true);
  });

  it('transitions patch -> format -> test failure -> repair -> format -> test success, counting exactly one attempt', () => {
    const { state, onIterationComplete } = createRepairLoopTracker(3);

    onIterationComplete(iterationWith([{ id: 'a1', name: 'applyPatch', result: { success: true, path: 'x.go', created: false, diff: '' } }]));
    onIterationComplete(iterationWith([{ id: 'f1', name: 'runGoFmt', result: { success: true, path: 'x.go', changed: false, stderr: '' } }]));
    const afterFailure = onIterationComplete(iterationWith([failingTestResult('t1')]));

    assert.equal(afterFailure, undefined, 'a failure below the limit must not force a stop');
    assert.equal(state.status, 'test_failed');
    assert.equal(state.attempts, 1);

    // Repair round: another patch, format, then a passing test.
    onIterationComplete(iterationWith([{ id: 'a2', name: 'applyPatch', result: { success: true, path: 'x.go', created: false, diff: '' } }]));
    onIterationComplete(iterationWith([{ id: 'f2', name: 'runGoFmt', result: { success: true, path: 'x.go', changed: true, stderr: '' } }]));
    const afterRepair = onIterationComplete(iterationWith([passingTestResult('t2')]));

    assert.equal(afterRepair, undefined);
    assert.equal(state.status, 'test_passed');
    assert.equal(state.attempts, 1, 'attempts should reflect failures seen, not test runs in general');
    assert.equal(state.lastTestResult?.success, true);
  });

  it('injects stop-and-summarize feedback (without forcing a hard stop) on the attempt that reaches the limit', async () => {
    const { state, onIterationComplete } = createRepairLoopTracker(2);

    await onIterationComplete(iterationWith([failingTestResult('t1')]));
    assert.equal(state.attempts, 1);
    assert.equal(state.status, 'test_failed');

    const result = await onIterationComplete(iterationWith([failingTestResult('t2')]));
    assert.equal(state.attempts, 2);
    assert.equal(state.status, 'blocked');
    assert.equal(result?.continue, undefined, 'the model should still get a turn to write its final answer');
    assert.match(result?.feedback ?? '', /maximum of 2 repair attempts/i);
  });

  it('force-stops if the model ignores the limit and fails another test anyway', async () => {
    const { state, onIterationComplete } = createRepairLoopTracker(1);

    const atLimit = await onIterationComplete(iterationWith([failingTestResult('t1')]));
    assert.equal(atLimit?.continue, undefined);
    assert.equal(state.status, 'blocked');

    const pastLimit = await onIterationComplete(iterationWith([failingTestResult('t2')]));
    assert.equal(pastLimit?.continue, false, 'a model that keeps retrying past the limit must be force-stopped');
    assert.equal(state.attempts, 2);
  });

  it('a later successful test after being blocked still updates status back to test_passed', () => {
    const { state, onIterationComplete } = createRepairLoopTracker(1);

    onIterationComplete(iterationWith([failingTestResult('t1')]));
    assert.equal(state.status, 'blocked');

    onIterationComplete(iterationWith([passingTestResult('t2')]));
    assert.equal(state.status, 'test_passed');
  });

  it('ignores a tool result carrying an error instead of a real runGoTest output', () => {
    const { state, onIterationComplete } = createRepairLoopTracker(3);
    const result = onIterationComplete(
      iterationWith([{ id: 't1', name: 'runGoTest', result: undefined, error: new Error('tool crashed') }]),
    );

    assert.equal(result, undefined);
    assert.equal(state.attempts, 0);
    assert.equal(state.status, 'pending');
  });

  it('two trackers never share state', () => {
    const trackerA = createRepairLoopTracker(3);
    const trackerB = createRepairLoopTracker(3);

    trackerA.onIterationComplete(iterationWith([failingTestResult()]));

    assert.equal(trackerA.state.attempts, 1);
    assert.equal(trackerB.state.attempts, 0);
  });
});

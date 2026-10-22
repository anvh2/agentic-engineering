import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WorktreeManager } from '../worktree/worktree.ts';
import { mergeModelCalls, Scheduler, type ExecutorModelCall, type ExecutorOutcome } from './scheduler.ts';
import { fakeExecutor, makeRepo, makeStore, plan, tempDir, workerTask } from './test-helpers.ts';

const call = (attempt: number, extra: Partial<ExecutorModelCall> = {}): ExecutorModelCall => ({
  attempt, provider: 'codex', model: 'gpt-test', startedAt: 1_000 + attempt, inferenceMs: 250, inputTokens: 100, outputTokens: 20, usageSupport: 'tokens', ...extra,
});

describe('worker invocation telemetry persistence', () => {
  it('attributes calls to their run and worker, keeps unreported counts null, and drops what cannot be attributed', () => {
    const merged = mergeModelCalls(undefined, 'run-1', 'worker-1', [call(1, { inputTokens: null, outputTokens: null, usageSupport: 'none' }), call(2)]);
    assert.deepEqual(merged.map((c) => [c.runId, c.workerId, c.attempt, c.inputTokens, c.outputTokens, c.usageSupport]), [
      ['run-1', 'worker-1', 1, null, null, 'none'],
      ['run-1', 'worker-1', 2, 100, 20, 'tokens'],
    ]);
    assert.deepEqual(mergeModelCalls(undefined, undefined, 'worker-1', [call(1)]), [], 'no run id: not attributable, not recorded');
    assert.deepEqual(mergeModelCalls(undefined, null, 'worker-1', [call(1)]), []);
    const malformed = [
      call(0), call(1.5), call(3, { provider: '' }), call(4, { model: 'x'.repeat(201) }), call(5, { inferenceMs: -1 }),
      { ...call(6), inputTokens: -5, outputTokens: 1.5, startedAt: Number.NaN, usageSupport: 'free' as never },
    ];
    const kept = mergeModelCalls(undefined, 'run-1', 'worker-1', malformed);
    assert.deepEqual(kept.map((c) => [c.attempt, c.inputTokens, c.outputTokens, c.startedAt, c.usageSupport]), [[6, null, null, null, 'unknown']]);
  });

  it('never double-counts: completing the same run again replaces its calls, other runs are kept, duplicates in one run are ignored', () => {
    const first = mergeModelCalls(undefined, 'run-1', 'worker-1', [call(1), call(1, { inputTokens: 999 })]);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.inputTokens, 100);
    const replayed = mergeModelCalls(first, 'run-1', 'worker-1', [call(1, { inputTokens: 101 })]);
    assert.deepEqual(replayed.map((c) => [c.runId, c.attempt, c.inputTokens]), [['run-1', 1, 101]]);
    const requeued = mergeModelCalls(replayed, 'run-2', 'worker-2', [call(1), call(2)]);
    assert.deepEqual(requeued.map((c) => [c.runId, c.workerId, c.attempt]), [['run-1', 'worker-1', 1], ['run-2', 'worker-2', 1], ['run-2', 'worker-2', 2]]);
    assert.deepEqual(mergeModelCalls(requeued, 'run-3', 'worker-1', []), requeued, 'a run without responses adds nothing');
    const many = Array.from({ length: 120 }, (_, i) => call(i + 1));
    assert.equal(mergeModelCalls(undefined, 'run-big', 'w', many).length, 100);
  });

  it('complete() persists the run telemetry on every terminal branch with the recorded run id and lease owner', async () => {
    const outcomes: Record<string, ExecutorOutcome> = {
      rt: { status: 'RUNTIME_FAILURE', reasons: ['provider down'], codingAttempts: 0, runtimeRetries: 1, modelCalls: [call(1)] },
      ex: { status: 'ESCALATED_TO_CLAUDE', reasons: ['coding_attempts_exhausted'], codingAttempts: 2, runtimeRetries: 0, modelCalls: [call(1), call(2, { inputTokens: null })] },
      none: { status: 'ESCALATED_TO_CLAUDE', reasons: ['x'], codingAttempts: 1, runtimeRetries: 0 },
    };
    const executor = fakeExecutor({ behavior: (input) => outcomes[input.task.id] });
    const store = makeStore();
    store.createBatch(plan(makeRepo(), Object.keys(outcomes).map((id) => workerTask(id))));
    store.promote();
    const scheduler = new Scheduler({ store, executor, workspace: new WorktreeManager(join(tempDir('mc-wt-'), 'worktrees')), config: { pollMs: 20 } });
    await scheduler.run();
    const persisted = (id: string) => store.requireTask(id).artifacts.modelCalls as { runId: string; workerId: string; attempt: number; inputTokens: number | null }[] | undefined;
    const owner = store.events().find((e) => e.taskId === 'rt' && e.to === 'CLAIMED')?.actor;
    assert.ok(owner);
    assert.deepEqual(persisted('rt')?.map((c) => [c.runId, c.workerId, c.attempt]), [['run-rt-1', owner, 1]]);
    assert.deepEqual(persisted('ex')?.map((c) => [c.runId, c.attempt, c.inputTokens]), [['run-ex-1', 1, 100], ['run-ex-1', 2, null]]);
    assert.equal(persisted('none'), undefined, 'no telemetry reported: nothing persisted, not an empty measurement');
    assert.deepEqual(store.requireTask('rt').runIds, ['run-rt-1']);
  });
});

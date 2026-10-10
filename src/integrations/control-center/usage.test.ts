import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeUsage } from './usage.ts';
import { modelCallSchema, unknownUsage, type ModelCall } from './contract.ts';
const call = (id: string, extra: Partial<ModelCall> = {}): ModelCall => ({
  id,
  objectiveId: 'B1',
  taskId: 'task-a',
  runId: 'run-a',
  workerId: 'worker-1',
  provider: 'codex',
  modelId: null,
  attempt: 1,
  startedAt: 1,
  finishedAt: 2,
  status: 'COMPLETED',
  usage: {
    ...unknownUsage(),
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 50,
    reasoningTokens: 5,
    latencyMs: 50,
    source: 'core.model-call',
    completeness: 'partial',
  },
  ...extra,
});
test('retries, failed and cancelled calls count exactly once within scope', () => {
  const a = call('a');
  const b = call('b', { status: 'FAILED', attempt: 2 });
  const c = call('c', { status: 'CANCELLED', attempt: 3 });
  const usage = summarizeUsage([a, b, c, a, call('unrelated', { objectiveId: 'old-smoke' })], { objectiveId: 'B1' });
  assert.equal(usage.inputTokens, 300);
  assert.equal(usage.outputTokens, 60);
  assert.equal(usage.cachedInputTokens, 150);
  assert.equal(usage.reasoningTokens, 15);
  assert.equal(usage.actualCostUsd, null);
  assert.equal(usage.estimatedCost, null);
  assert.equal(summarizeUsage([a], { objectiveId: 'B1', provider: 'gemini' }).inputTokens, null);
});
test('missing telemetry is never zero or a misleading partial total', () => {
  assert.equal(summarizeUsage([], { objectiveId: 'B1' }).inputTokens, null);
  const partial = call('partial', { usage: { ...unknownUsage(), outputTokens: 4 } });
  const usage = summarizeUsage([call('ok'), partial], { objectiveId: 'B1' });
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, 24);
  assert.equal(usage.completeness, 'partial');
  assert.equal(modelCallSchema.safeParse(call('bad', { usage: { ...unknownUsage(), inputTokens: -1 } })).success, false);
});
test('running counts stay pending and reconnect cannot regress a completed call', () => {
  const pending = call('a', { status: 'RUNNING', finishedAt: null, usage: { ...unknownUsage(), completeness: 'pending' } });
  assert.equal(summarizeUsage([pending], { objectiveId: 'B1' }).completeness, 'pending');
  assert.equal(summarizeUsage([call('a'), pending], { objectiveId: 'B1' }).inputTokens, 100);
});

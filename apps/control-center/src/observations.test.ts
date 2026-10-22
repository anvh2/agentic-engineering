import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../src/integrations/control-center/__testing__/fixture.ts';
import { unknownUsage, type ModelCall } from '../../../src/integrations/control-center/contract.ts';
import { ATTENTION, callTokens, claimElapsedOrAbsence, currentTasks, filterByStatus, inspectorObservations, laneEvidence, needsAttention, observedActivity, priced, taskUsage, usageAbsence, usageForCalls, usageValue } from './observations.ts';

function call(id: string, runId: string, input: number | null, extra: Partial<ModelCall> = {}): ModelCall {
  return {
    id,
    runId,
    objectiveId: 'B1',
    taskId: 'task-a',
    workerId: 'worker-1',
    provider: 'ollama',
    modelId: 'model-v1',
    attempt: 1,
    startedAt: 1,
    finishedAt: 2,
    status: 'COMPLETED',
    usage: {
      ...unknownUsage(),
      inputTokens: input,
      outputTokens: 12,
      cachedInputTokens: 3,
      reasoningTokens: 2,
      source: 'core.model-call',
      completeness: 'partial',
    },
    ...extra,
  };
}
test('current run and historical usage stay disjoint, scoped, and replay-safe', (t) => {
  const f = fixture();
  t.after(f.close);
  const claim = f.claim();
  f.store.recordRun('task-a', claim.fence, 'current');
  const snapshot = f.reader.snapshot('B1');
  const agent = snapshot.agents.find((a) => a.id === 'ollama')!;
  const current = call('new', 'current', 25);
  snapshot.calls = [
    current,
    current,
    call('old', 'previous', 70),
    call('retry', 'previous', 10, { status: 'CANCELLED', attempt: 2 }),
    call('unrelated', 'smoke', 999, { objectiveId: 'other' }),
  ];
  let view = inspectorObservations(snapshot, agent);
  assert.equal(view.currentUsage.inputTokens, 25);
  assert.equal(view.historicalUsage.inputTokens, 80);
  assert.equal(view.current.length, 1);
  assert.equal(view.historicalUsage.cachedInputTokens, 6);
  assert.equal(view.historicalUsage.outputTokens, 24);
  snapshot.calls.push(current);
  view = inspectorObservations(snapshot, agent);
  assert.equal(view.currentUsage.inputTokens, 25);
  assert.equal(taskUsage(snapshot, snapshot.tasks[0]!).inputTokens, 105);
});
test('missing metrics remain unknown, partial totals do not become zero, costs require provenance', () => {
  assert.equal(usageForCalls([], 'B1').inputTokens, null);
  assert.equal(usageForCalls([call('a', 'run', null), call('b', 'run', 2)], 'B1').inputTokens, null);
  const raw = { ...unknownUsage(), actualCostUsd: 0.2 };
  assert.equal(priced(raw), false);
  const known = call('a', 'run', 20, {
    usage: { ...raw, estimatedCost: { usd: 0.1, modelId: 'model-v1', pricingSource: 'explicit fixture pricing', pricedAt: 1 } },
  });
  assert.equal(priced(usageForCalls([known], 'B1')), true);
  assert.equal(priced(usageForCalls([{ ...known, modelId: null }], 'B1')), false);
});
test('activity comes from the contract, never historical calls; expired leases and disconnect lose live status', (t) => {
  const f = fixture();
  t.after(f.close);
  const claim = f.claim();
  f.store.recordRun('task-a', claim.fence, 'current');
  const snapshot = f.reader.snapshot('B1');
  const agent = snapshot.agents.find((a) => a.id === 'ollama')!;
  snapshot.calls = [call('a', 'current', 30)];
  assert.equal(observedActivity(agent, currentTasks(snapshot, agent), true, snapshot.observedAt), 'UNKNOWN');
  agent.activity = 'RUNNING';
  assert.equal(observedActivity(agent, currentTasks(snapshot, agent), true, snapshot.observedAt), 'RUNNING');
  assert.equal(observedActivity(agent, currentTasks(snapshot, agent), false, snapshot.observedAt), 'UNKNOWN');
  assert.equal(observedActivity(agent, currentTasks(snapshot, agent), true, snapshot.observedAt + 1001), 'UNKNOWN');
  agent.activity = 'OFFLINE';
  assert.equal(observedActivity(agent, [], true, snapshot.observedAt), 'OFFLINE');
  agent.activity = 'IDLE';
  assert.equal(observedActivity(agent, [], true, snapshot.observedAt), 'IDLE');
  f.store.transition('task-a', 'CANCELLED', { actor: 'human' });
  const historical = f.reader.snapshot('B1');
  historical.calls = snapshot.calls;
  const view = inspectorObservations(
    historical,
    historical.agents.find((a) => a.id === 'ollama'),
  );
  assert.equal(view.currentUsage.inputTokens, null);
  assert.equal(view.historicalUsage.inputTokens, 30);
});

test('in-flight calls retain pending telemetry without inventing token values', () => {
  const pending = call('pending', 'run', null, {
    status: 'RUNNING',
    finishedAt: null,
    usage: { ...unknownUsage(), completeness: 'pending' },
  });
  const usage = usageForCalls([pending, pending], 'B1');
  assert.equal(usage.completeness, 'pending');
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, null);
});

test('absent evidence is labelled by cause and never becomes zero', (t) => {
  const f = fixture(); t.after(f.close);
  const snapshot = f.reader.snapshot('B1');
  const task = snapshot.tasks[0]!;
  assert.equal(usageAbsence(unknownUsage(), true), 'NOT RECORDED');
  assert.equal(usageAbsence(unknownUsage(), false), 'UNAVAILABLE');
  assert.equal(usageAbsence({ ...unknownUsage(), source: 'core.model-call', completeness: 'partial' }, true), 'UNKNOWN');
  assert.equal(usageValue(null, unknownUsage(), true), 'NOT RECORDED');
  assert.equal(usageValue(0, { ...unknownUsage(), source: 'core.model-call', completeness: 'complete', inputTokens: 0 }, true), 0);
  assert.equal(claimElapsedOrAbsence({ ...task, state: 'DONE' }, Date.now(), true), 'NOT APPLICABLE');
  assert.equal(claimElapsedOrAbsence({ ...task, state: 'CODING', stale: true }, Date.now(), true), 'UNKNOWN');
  assert.equal(claimElapsedOrAbsence({ ...task, state: 'CODING' }, Date.now(), false), 'UNAVAILABLE');
  assert.equal(needsAttention({ ...task, state: 'ESCALATED' }), true);
  assert.equal(needsAttention({ ...task, state: 'DONE' }), false);
});

test('lane ACTIVE does not outlive its lease between snapshots; needs-attention filter selects stopped work', (t) => {
  const f = fixture(); t.after(f.close);
  const claim = f.claim();
  f.store.transition('task-a', 'CODING', { actor: 'worker-1', fence: claim.fence });
  const snapshot = f.reader.snapshot('B1');
  const lane = snapshot.agents.find((a) => a.assignmentIds.includes('task-a'))!;
  const lease = snapshot.tasks.find((x) => x.id === 'task-a')!.leaseExpiresAt!;
  assert.equal(lane.evidence, 'ACTIVE');
  assert.equal(laneEvidence(lane, snapshot, true, lease - 1), 'ACTIVE');
  assert.equal(laneEvidence(lane, snapshot, true, lease + 1), 'OBSERVED');
  assert.equal(laneEvidence(lane, snapshot, false, lease - 1), 'UNAVAILABLE');
  assert.equal(laneEvidence({ ...lane, evidence: undefined }, snapshot, true, lease - 1), 'UNKNOWN');
  const tasks = snapshot.tasks.map((x, i) => ({ ...x, state: (i === 0 ? 'BLOCKED' : 'DONE') as typeof x.state }));
  assert.deepEqual(filterByStatus(tasks, ATTENTION).map((x) => x.id), [tasks[0]!.id]);
  assert.deepEqual(filterByStatus(tasks, 'DONE').map((x) => x.id), [tasks[1]!.id]);
  assert.equal(filterByStatus(tasks, '').length, tasks.length);
});

test('a recorded call distinguishes unsupported from unreported usage and keeps a reported zero', (t) => {
  const f = fixture(); t.after(f.close);
  const call = { id: 'c', objectiveId: 'B1', taskId: 'task-a', runId: 'r', workerId: 'w', provider: 'ollama', modelId: 'm', attempt: 1, startedAt: 1, finishedAt: 2, status: 'COMPLETED' as const, usage: unknownUsage() };
  assert.equal(callTokens(null, { ...call, usageSupport: 'none' }), 'NOT SUPPORTED');
  assert.equal(callTokens(null, { ...call, usageSupport: 'tokens' }), 'NOT REPORTED');
  assert.equal(callTokens(null, call), 'NOT REPORTED');
  assert.equal(callTokens(0, { ...call, usageSupport: 'tokens' }), 0);
});

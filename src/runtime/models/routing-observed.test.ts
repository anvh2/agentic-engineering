import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentStore } from '../agents/agent-store.ts';
import { makeRepo, makeStore, plan, workerTask } from '../scheduler/test-helpers.ts';
import { buildModelRuntime } from './config.ts';
import { observedModelEvidence, routeWorkerModel } from './routing.ts';

// Regression for the first live CloudFarm run: qwen2.5-coder:3b advertised tool support but answered every attempt with a
// JSON tool call as plain text, so it never edited a file. Observed history must outweigh what a model declares.
test('a model whose recent completed executions made no tool call is refused, with the observed reason', () => {
  const store = makeStore();
  store.createBatch(plan(makeRepo(), [workerTask('a', { files: ['a.go'] }), workerTask('b', { files: ['b.go'] }), workerTask('c', { files: ['c.go'] })]));
  const agents = new AgentStore(store.db);
  for (const id of ['a', 'b', 'c']) {
    agents.create({ executionId: `agx-${id}`, agentId: `coding-worker.${id}`, role: 'coding-worker', project: 'p', batchId: 'B1', taskId: id, claimEpoch: 1, runId: null, provider: 'ollama', assignedModel: 'ollama/m:3b', worktree: '/tmp', repositoryId: null, logPath: null, artifactDir: null });
    agents.update(`agx-${id}`, { status: 'COMPLETED', outcome: 'ESCALATED_TO_CLAUDE', toolCalls: 0 });
  }
  const observed = observedModelEvidence(store.db);
  assert.deepEqual(observed.get('ollama/m:3b|go'), { executions: 3, passes: 0, recentToolless: 3 });
  const resolver = buildModelRuntime({ OLLAMA_MODEL: 'm:3b' });
  const decision = routeWorkerModel({ taskId: 'x', agentId: 'coding-worker-go', language: 'go', complexity: 'small', risk: 'low' }, resolver, { ollama: new Map([['m:3b', 2e9]]), memoryBudgetGb: 8, observed });
  assert.equal(decision.outcome, 'refused');
  assert.match(decision.reason, /observed_no_tool_use/);
  // One execution that used tools ends the streak: the model is eligible again.
  agents.create({ executionId: 'agx-d', agentId: 'coding-worker.a', role: 'coding-worker', project: 'p', batchId: 'B1', taskId: 'a', claimEpoch: 2, runId: null, provider: 'ollama', assignedModel: 'ollama/m:3b', worktree: '/tmp', repositoryId: null, logPath: null, artifactDir: null });
  agents.update('agx-d', { status: 'COMPLETED', outcome: 'PASS', toolCalls: 4 });
  store.db.exec("UPDATE agent_executions SET spawned_at = spawned_at + 1000 WHERE execution_id = 'agx-d'");
  const again = routeWorkerModel({ taskId: 'x', agentId: 'coding-worker-go', language: 'go', complexity: 'small', risk: 'low' }, resolver, { ollama: new Map([['m:3b', 2e9]]), memoryBudgetGb: 8, observed: observedModelEvidence(store.db) });
  assert.equal(again.outcome, 'selected', again.reason);
  assert.match(again.reason, /observed/);
  store.close();
});

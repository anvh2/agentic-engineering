import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rosterSchema } from './agents-model.ts';

test('agent roster: status is a closed set and a missing binding stays null, never a guessed model', () => {
  const row = { registryKey: 'specialist_architect', agentId: 'specialist-architect', name: 'Architect', kind: 'specialist', status: 'registered', model: 'ollama/qwen3:8b', modelPinned: true, reason: null, tools: ['readFile'] };
  const roster = rosterSchema.parse({ source: 'mastra-registration', agents: [row, { ...row, registryKey: null, status: 'refused', model: null, modelPinned: null, reason: 'unauthorized_model: x' }], counts: { registered: 1, refused: 1, unavailable: 0 }, error: null });
  assert.equal(roster.agents[1].model, null);
  assert.throws(() => rosterSchema.parse({ ...roster, agents: [{ ...row, status: 'online' }] }));
});

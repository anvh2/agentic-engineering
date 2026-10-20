import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { findProjectRoot } from '../../../core/paths.ts';
import { loadPackRegistry } from '../../../runtime/knowledge/packs/loader.ts';
import { AGENT_ROLES, ModelRegistry, ModelResolver, type ModelRef } from '../../../runtime/models/index.ts';
import { fakeModelServer } from '../__testing__/fake-model-server.ts';
import { registerSpecialists, type SpecialistRegistration } from '../specialist-agents.ts';
import { createEngineeringCouncilWorkflow, type CouncilWorkflowResult } from './council-workflow.ts';
import { councilReadiness } from './readiness.ts';

/**
 * PR #55 (model registry) + PR #56 (council), combined: registration is the authority for a LIVE council. A specialist the
 * registry refused is never rebuilt, and an agent bound to anything but the local default model (a paid one included) never
 * runs. Every refusal happens in preflight with zero model calls and no meeting state. Calls are counted on a loopback server.
 */

const root = findProjectRoot()!;
const registry = loadPackRegistry(root);
const ok = { state: 'available' } as const;
const caps = { toolCalling: true, structuredOutput: true, contextTokens: 16384 };
const local = (modelId: string): ModelRef => ({ providerId: 'ollama', modelId });
const LIVE_ENV = { AGENTIC_COUNCIL_LIVE: '1', OLLAMA_NUM_CTX: '8192' };
const probe = async () => ({ id: 'ollama' as const, configured: true, basis: 'probe' as const, detail: 'endpoint reachable and model present', model: 'qwen3:8b' });

function resolverFor(url: string, assignments: Record<string, ModelRef> = {}): ModelResolver {
  const reg = new ModelRegistry()
    .addProvider({ providerId: 'ollama', kind: 'local', url, billing: 'local-free', credential: { env: 'OLLAMA_API_KEY', placeholder: 'ollama' }, availability: ok })
    .addProvider({ providerId: 'paidco', kind: 'cloud', url: 'https://paid.invalid/v1', billing: 'metered', credential: { env: 'PAIDCO_API_KEY' }, availability: ok })
    .addModel({ providerId: 'ollama', modelId: 'qwen3:8b', capabilities: caps, availability: ok, roles: AGENT_ROLES })
    .addModel({ providerId: 'ollama', modelId: 'qwen3:14b', capabilities: caps, availability: ok, roles: AGENT_ROLES })
    .addModel({ providerId: 'ollama', modelId: 'qwen3:gone', capabilities: caps, availability: { state: 'unavailable', reason: 'not installed' }, roles: AGENT_ROLES })
    .addModel({ providerId: 'paidco', modelId: 'frontier-1', capabilities: caps, availability: ok, roles: ['specialist'] });
  return new ModelResolver(reg, { defaults: { 'coding-worker': local('qwen3:8b'), specialist: local('qwen3:8b') }, assignments }, { OLLAMA_API_KEY: 'loopback', PAIDCO_API_KEY: 'loopback-not-a-credential' });
}

async function harness(assignments: Record<string, ModelRef>, reply = 'not a council reply') {
  const server = await fakeModelServer(reply);
  const workdir = mkdtempSync(join(tmpdir(), 'council-registry-'));
  const specialists = registerSpecialists(registry, { resolver: resolverFor(server.url, assignments) });
  const workflow = createEngineeringCouncilWorkflow({ workdir, registry, env: LIVE_ENV, allowedRoots: () => [root], probe });
  const mastra = new Mastra({ agents: specialists.agents, workflows: { engineeringCouncilWorkflow: workflow } });
  const run = async (meetingId: string, limits?: Record<string, number>) =>
    (await (await mastra.getWorkflow('engineeringCouncilWorkflow').createRun()).start({ inputData: { meetingId, mode: 'live', ...(limits ? { limits } : {}) } as never })) as unknown as { status: string; result?: CouncilWorkflowResult };
  const meetings = () => (existsSync(join(workdir, 'council')) ? readdirSync(join(workdir, 'council')).filter((n) => !n.startsWith('council.db')) : []);
  return { server, specialists, run, meetings, done: async () => { await server.close(); rmSync(workdir, { recursive: true, force: true }); } };
}

async function assertRefusedWithoutCalls(h: Awaited<ReturnType<typeof harness>>, meetingId: string, pattern: RegExp): Promise<void> {
  const r = await h.run(meetingId);
  assert.equal(r.status, 'success');
  assert.equal(r.result!.status, 'refused', JSON.stringify(r.result));
  assert.match(r.result!.reasons.join(' | '), pattern);
  assert.equal(r.result!.humanApproval, 'pending');
  assert.equal(h.server.seen.length, 0, 'no model call reached the wire');
  assert.deepEqual(h.meetings(), [], 'no meeting state was created');
}

test('a specialist the model registry refused is never rebuilt: LIVE preflight refuses with zero calls and status names the reason', async () => {
  const h = await harness({ 'specialist-architect': local('qwen3:gone') });
  try {
    assert.deepEqual(h.specialists.refused.map((r) => [r.id, r.code]), [['architect', 'model_unavailable']]);
    assert.equal(Object.hasOwn(h.specialists.agents, 'specialist_architect'), false);
    await assertRefusedWithoutCalls(h, 'refused-architect', /not_registered_in_mastra: architect/);

    const status = await councilReadiness({ specialists: h.specialists, env: LIVE_ENV, probe: true, probeImpl: probe });
    assert.equal(status.live.ready, false);
    assert.match(status.live.reasons.join(), /not_registered_in_mastra: architect \(model refused, model_unavailable/);
    assert.equal(h.server.seen.length, 0);
  } finally { await h.done(); }
});

test('a council seat assigned a paid model, or a local model other than the default, never runs and never spends', async () => {
  for (const [assignments, pattern] of [
    [{ 'specialist-security-reviewer': { providerId: 'paidco', modelId: 'frontier-1' } }, /model_binding_refused: security-reviewer is bound to paidco\/frontier-1/],
    [{ 'specialist-reliability-reviewer': local('qwen3:14b') }, /model_binding_refused: reliability-reviewer is bound to ollama\/qwen3:14b/],
  ] as [Record<string, ModelRef>, RegExp][]) {
    const h = await harness(assignments);
    try {
      assert.deepEqual(h.specialists.refused, [], 'registration accepted the explicit assignment; the council is what refuses it');
      await assertRefusedWithoutCalls(h, 'bound-elsewhere', pattern);
      const status = await councilReadiness({ specialists: h.specialists, env: LIVE_ENV, probe: true, probeImpl: probe });
      assert.equal(status.live.ready, false);
      assert.match(status.live.reasons.join(), pattern, 'status reports exactly what a run would refuse');
    } finally { await h.done(); }
  }
});

test('the registered, locally bound agents are the ones that answer: the default binding reaches the wire and the record', async () => {
  const h = await harness({});
  try {
    const status = await councilReadiness({ specialists: h.specialists as SpecialistRegistration, env: LIVE_ENV, probe: true, probeImpl: probe });
    assert.equal(status.live.ready, true, status.live.reasons.join());
    const r = await h.run('bound-default', { maxInvocations: 3 });
    assert.equal(r.status, 'success');
    assert.equal(r.result!.status, 'recorded', JSON.stringify(r.result));
    assert.ok(h.server.seen.length >= 1, 'the registered agent was called');
    assert.ok(h.server.seen.every((s) => s.model === 'qwen3:8b' && s.path === '/v1/chat/completions'), 'only the bound local model on the loopback endpoint');
    assert.ok(h.server.seen.every((s) => s.authorization === 'Bearer loopback'), 'the local provider credential, never the paid one');
    for (const seat of r.result!.panel) assert.deepEqual([seat.provider, seat.model], ['ollama', 'qwen3:8b']);
  } finally { await h.done(); }
});

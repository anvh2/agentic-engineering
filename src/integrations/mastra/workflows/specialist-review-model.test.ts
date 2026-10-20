import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { findProjectRoot } from '../../../core/paths.ts';
import { loadPackRegistry } from '../../../runtime/knowledge/packs/loader.ts';
import { AGENT_ROLES, ModelRegistry, ModelResolver, bindAgent, type ModelCapabilities, type ModelEntry, type ModelRef, type ProviderConfig } from '../../../runtime/models/index.ts';
import { createFixtureRepo } from '../../../workers/tools/__testing__/fixture-repo.ts';
import { createMastraSpecialist, specialistRegistryKey } from '../specialist-agents.ts';
import { report, scriptedModel } from '../__testing__/scripted-model.ts';
import { createSpecialistReviewWorkflow, type SpecialistReviewInput, type SpecialistReviewResult } from './specialist-review-workflow.ts';

const pack = loadPackRegistry(findProjectRoot()!);
const ok = { state: 'available' } as const;
const caps: ModelCapabilities = { toolCalling: true, structuredOutput: true, contextTokens: 16384 };
const ollama: ProviderConfig = { providerId: 'ollama', kind: 'local', url: 'http://127.0.0.1:1/v1', billing: 'local-free', credential: { env: 'OLLAMA_API_KEY', placeholder: 'ollama' }, availability: ok };
const entry = (modelId: string, over: Partial<ModelEntry> = {}): ModelEntry => ({ providerId: 'ollama', modelId, capabilities: caps, availability: ok, roles: AGENT_ROLES, ...over });
const ref = (modelId: string, providerId = 'ollama'): ModelRef => ({ providerId, modelId });
const AGENT = 'specialist-go-reviewer';

function resolver(build: (r: ModelRegistry) => void = () => {}, assignments: Record<string, ModelRef> = {}): ModelResolver {
  const registry = new ModelRegistry().addProvider(ollama).addModel(entry('qwen3:8b')).addModel(entry('qwen3:14b'));
  build(registry);
  return new ModelResolver(registry, { defaults: { 'coding-worker': ref('qwen3:8b'), specialist: ref('qwen3:8b') }, assignments });
}

const input = (repository: string, over: Partial<SpecialistReviewInput> = {}): SpecialistReviewInput => ({
  specialistId: 'go-reviewer', repository, taskId: 'task-1', language: 'go', taskType: 'review', objective: 'Review CalculateTotal.', focusPaths: ['internal/service.go'], ...over,
});

async function harness(modelResolver: ModelResolver, reply: string = report()) {
  const fixture = await createFixtureRepo('CalculateTotal');
  const scripted = scriptedModel([{ text: reply }]);
  const seen: Record<string, unknown>[] = [];
  const deps = {
    registry: pack, allowedRoots: () => [fixture.parent], modelResolver,
    resolveAgent: (manifest: Parameters<typeof createMastraSpecialist>[0]) => {
      const agent = createMastraSpecialist(manifest, { model: scripted.model });
      return { generate: (prompt: string, options: Record<string, unknown>) => { seen.push(options); return agent.generate(prompt, options as never) as never; } };
    },
  };
  const run = async (over: Partial<SpecialistReviewInput> = {}) => {
    const r = await (await createSpecialistReviewWorkflow(deps).createRun()).start({ inputData: input(fixture.root, over) as never });
    assert.equal(r.status, 'success');
    return (r as unknown as { result: SpecialistReviewResult }).result;
  };
  return { fixture, scripted, seen, run, done: () => fixture.cleanup() };
}

const metadataOf = (options: Record<string, unknown>) => (options as { tracingOptions: { metadata: Record<string, unknown> } }).tracingOptions.metadata;

test('the result and every model call carry agentId, providerId and modelId as separate, correct fields', async () => {
  const h = await harness(resolver());
  try {
    const result = await h.run();
    assert.equal(result.status, 'REPORTED');
    assert.deepEqual(result.model, { agentId: AGENT, role: 'specialist', providerId: 'ollama', modelId: 'qwen3:8b' });
    assert.equal(result.specialistId, 'go-reviewer', 'the role id is not the model or the agent binding');
    const meta = metadataOf(h.seen[0]!);
    assert.equal(meta.agentId, AGENT);
    assert.equal(meta.providerId, 'ollama');
    assert.equal(meta.modelId, 'qwen3:8b');
    assert.equal(meta.agentRole, 'specialist');
    assert.equal(meta.specialistId, 'go-reviewer');
    assert.equal(meta.workflowRunId, result.workflowRunId);
    assert.ok(!JSON.stringify(result.model).includes('key'), 'no credential in the binding');
  } finally { await h.done(); }
});

test('assigning another model changes the model binding and nothing else about the run', async () => {
  const base = await harness(resolver());
  const moved = await harness(resolver(() => {}, { [AGENT]: ref('qwen3:14b') }));
  try {
    const [a, b] = [await base.run(), await moved.run()];
    assert.equal(a.status, 'REPORTED');
    assert.equal(b.status, 'REPORTED');
    assert.equal(a.model!.modelId, 'qwen3:8b');
    assert.equal(b.model!.modelId, 'qwen3:14b');
    for (const key of ['specialistId', 'manifestVersion', 'manifestDigest', 'reviewId'] as const) assert.equal(a[key], b[key], key);
    assert.equal(a.model!.agentId, b.model!.agentId);
    assert.deepEqual(a.report, b.report);
    assert.equal(metadataOf(moved.seen[0]!).modelId, 'qwen3:14b');
  } finally { await base.done(); await moved.done(); }
});

test('negative: a refused model assignment ends the run before any model call, with a stable code and no model binding', async () => {
  const cases: [string, ModelResolver, RegExp][] = [
    ['unknown model', resolver(() => {}, { [AGENT]: ref('absent') }), /model_refused: unknown_model/],
    ['unknown provider', resolver(() => {}, { [AGENT]: ref('qwen3:8b', 'nowhere') }), /model_refused: unknown_provider/],
    ['unavailable model', resolver((r) => r.addModel(entry('retired', { availability: { state: 'unavailable', reason: 'removed' } })), { [AGENT]: ref('retired') }), /model_refused: model_unavailable.*removed/],
    ['unsupported capability', resolver((r) => r.addModel(entry('no-tools', { capabilities: { toolCalling: false, structuredOutput: true } })), { [AGENT]: ref('no-tools') }), /model_refused: capability_unsupported.*toolCalling/],
    ['unauthorized role', resolver((r) => r.addModel(entry('workers-only', { roles: ['coding-worker'] })), { [AGENT]: ref('workers-only') }), /model_refused: unauthorized_model/],
    ['unauthorized agent', resolver((r) => r.addModel(entry('someone-elses', { agents: ['specialist-security-reviewer'] })), { [AGENT]: ref('someone-elses') }), /model_refused: unauthorized_model.*agent specialist-go-reviewer/],
    ['unavailable provider', resolver((r) => r.addProvider({ ...ollama, providerId: 'down', availability: { state: 'unavailable', reason: 'maintenance' } }).addModel(entry('qwen3:8b', { providerId: 'down' })), { [AGENT]: ref('qwen3:8b', 'down') }), /model_refused: provider_unavailable.*maintenance/],
  ];
  for (const [name, r, pattern] of cases) {
    const h = await harness(r);
    try {
      const result = await h.run();
      assert.equal(result.status, 'REFUSED', name);
      assert.match(result.reasons.join(';'), pattern, name);
      assert.equal(result.inferenceCalls, 0, name);
      assert.equal(h.scripted.calls(), 0, `${name}: the model was never called`);
      assert.equal(result.model, null, name);
      assert.equal(result.report, null, name);
    } finally { await h.done(); }
  }
});

test('the context window comes from the model registry: undeclared or too small is refused, declared and large enough runs', async () => {
  const cases: [number | undefined, string, RegExp | null][] = [
    [undefined, 'undeclared', /context window is not declared/],
    [4096, 'too small', /below the required 8192/],
    [16384, 'large enough', null],
  ];
  for (const [contextTokens, name, refusal] of cases) {
    const model = entry('sized', { capabilities: { toolCalling: true, structuredOutput: true, ...(contextTokens ? { contextTokens } : {}) } });
    const h = await harness(resolver((r) => r.addModel(model), { [AGENT]: ref('sized') }));
    try {
      const result = await h.run();
      if (refusal) {
        assert.equal(result.status, 'REFUSED', name);
        assert.match(result.reasons.join(), refusal, name);
        assert.equal(h.scripted.calls(), 0, name);
        assert.equal(result.model?.modelId, 'sized', `${name}: the refusal still says which model was considered`);
      } else {
        assert.equal(result.status, 'REPORTED', name);
        assert.equal(h.scripted.calls(), 1, name);
      }
    } finally { await h.done(); }
  }
});

test('negative: a model on a provider the specialist manifest does not declare is refused as unsupported, not run', async () => {
  const other: ProviderConfig = { ...ollama, providerId: 'vllm-local', credential: { env: 'VLLM_API_KEY', placeholder: 'vllm' } };
  const h = await harness(resolver((r) => r.addProvider(other).addModel(entry('big', { providerId: 'vllm-local' })), { [AGENT]: ref('big', 'vllm-local') }));
  try {
    const result = await h.run();
    assert.equal(result.status, 'REFUSED');
    assert.match(result.reasons.join(), /unsupported: go-reviewer does not declare support for provider vllm-local/);
    assert.equal(h.scripted.calls(), 0);
    assert.deepEqual(result.model, { agentId: AGENT, role: 'specialist', providerId: 'vllm-local', modelId: 'big' }, 'the refusal names the model that was considered');
  } finally { await h.done(); }
});

test('a registered agent bound to a different model than the one authorized for the run is refused before any call', async () => {
  const fixture = await createFixtureRepo('CalculateTotal');
  const manifest = pack.agentById.get('go-reviewer')!;
  const key = specialistRegistryKey(manifest);
  try {
    const run = async (boundTo: string) => {
      const scripted = scriptedModel([{ text: report() }]);
      // A scripted-model agent that claims a binding: stands in for an agent registered at startup under an older config.
      const registered = bindAgent(createMastraSpecialist(manifest, { model: scripted.model }), { agentId: AGENT, role: 'specialist', providerId: 'ollama', modelId: boundTo });
      const workflow = createSpecialistReviewWorkflow({ registry: pack, allowedRoots: () => [fixture.parent], modelResolver: resolver() });
      const mastra = new Mastra({ agents: { [key]: registered }, workflows: { review: workflow } });
      const r = await (await mastra.getWorkflow('review').createRun()).start({ inputData: input(fixture.root) as never });
      assert.equal(r.status, 'success');
      return { result: (r as unknown as { result: SpecialistReviewResult }).result, calls: scripted.calls() };
    };
    const stale = await run('qwen3:14b');
    assert.equal(stale.result.status, 'REFUSED');
    assert.match(stale.result.reasons.join(), /model_binding_mismatch: .*ollama\/qwen3:14b.*ollama\/qwen3:8b/);
    assert.equal(stale.calls, 0);
    const current = await run('qwen3:8b');
    assert.equal(current.result.status, 'REPORTED');
    assert.equal(current.calls, 1);
  } finally { await fixture.cleanup(); }
});

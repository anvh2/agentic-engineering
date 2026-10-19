import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findProjectRoot } from '../../core/paths.ts';
import { loadPackRegistry } from '../../runtime/knowledge/packs/loader.ts';
import { renderAgentInstructions } from '../../runtime/knowledge/packs/agents.ts';
import { AGENT_ROLES, ModelRegistry, ModelResolutionError, ModelResolver, bindingOf, type ModelEntry, type ModelRef } from '../../runtime/models/index.ts';
import { codingWorkerGo, codingWorkerJs, createCodingWorker } from '../../workers/coding-worker.ts';
import { createOllamaProvider } from '../../workers/providers/ollama.ts';
import { createMastraSpecialist, registerSpecialists, resolveSpecialistModel, specialistRegistryKey } from './specialist-agents.ts';
import { fakeModelServer } from './__testing__/fake-model-server.ts';

const pack = loadPackRegistry(findProjectRoot()!);
const manifest = (id: string) => pack.agentById.get(id)!;
const ok = { state: 'available' } as const;
const caps = { toolCalling: true, structuredOutput: true, contextTokens: 16384 };
const local = (modelId: string): ModelRef => ({ providerId: 'ollama', modelId });

/** A resolver whose local provider points at `url`; `qwen3:8b` is the default and `qwen3:14b` an alternative the operator may assign. */
function resolverFor(url: string, assignments: Record<string, ModelRef> = {}, extraModels: ModelEntry[] = []): ModelResolver {
  const registry = new ModelRegistry()
    .addProvider({ providerId: 'ollama', kind: 'local', url, billing: 'local-free', credential: { env: 'OLLAMA_API_KEY', placeholder: 'ollama' }, availability: ok })
    .addModel({ providerId: 'ollama', modelId: 'qwen3:8b', capabilities: caps, availability: ok, roles: AGENT_ROLES })
    .addModel({ providerId: 'ollama', modelId: 'qwen3:14b', capabilities: caps, availability: ok, roles: AGENT_ROLES });
  for (const m of extraModels) registry.addModel(m);
  return new ModelResolver(registry, { defaults: { 'coding-worker': local('qwen3:8b'), specialist: local('qwen3:8b') }, assignments }, { OLLAMA_API_KEY: 'key-for-test' });
}

test('the shipped coding workers and a default specialist are bound to the local Ollama/Qwen default with separate agent ids', async () => {
  assert.deepEqual(bindingOf(codingWorkerGo), { agentId: 'coding-worker-go', role: 'coding-worker', providerId: 'ollama', modelId: process.env.OLLAMA_MODEL ?? 'qwen3:8b' });
  assert.deepEqual(bindingOf(codingWorkerJs), { agentId: 'coding-worker-js', role: 'coding-worker', providerId: 'ollama', modelId: process.env.OLLAMA_MODEL ?? 'qwen3:8b' });
  assert.equal(codingWorkerGo.id, 'coding-worker-go');
  assert.equal(codingWorkerJs.id, 'coding-worker-js');
  const model = (await codingWorkerGo.getModel()) as { modelId: string; provider: string };
  assert.equal(model.provider, 'ollama');
  assert.equal(model.modelId, process.env.OLLAMA_MODEL ?? 'qwen3:8b');
});

test('two specialists share one model on the wire but keep their own role, instructions and tool permissions', async () => {
  const server = await fakeModelServer('hello');
  try {
    const resolver = resolverFor(server.url);
    const security = createMastraSpecialist(manifest('security-reviewer'), { resolver });
    const explorer = createMastraSpecialist(manifest('code-explorer'), { resolver });

    // Identity: one model, two agents.
    const [a, b] = [bindingOf(security)!, bindingOf(explorer)!];
    assert.equal(a.providerId, b.providerId);
    assert.equal(a.modelId, b.modelId);
    assert.notEqual(a.agentId, b.agentId);
    assert.equal(a.agentId, 'specialist-security-reviewer');
    assert.equal(b.agentId, 'specialist-code-explorer');

    await security.generate('review the design');
    await explorer.generate('explore the repository');
    const [first, second] = server.seen;
    assert.equal(server.seen.length, 2);

    // The same model, endpoint and key were used for both...
    for (const seen of [first!, second!]) {
      assert.equal(seen.path, '/v1/chat/completions');
      assert.equal(seen.model, 'qwen3:8b');
      assert.equal(seen.authorization, 'Bearer key-for-test');
    }
    // ...but each agent offered the model only its own manifest's tools, with its own instructions.
    assert.deepEqual(first!.tools, [...manifest('security-reviewer').tools].sort());
    assert.deepEqual(second!.tools, [...manifest('code-explorer').tools].sort());
    assert.ok(first!.tools.includes('gitDiff') && !second!.tools.includes('gitDiff'), 'sharing a model grants no tool');
    assert.equal(first!.system, renderAgentInstructions(manifest('security-reviewer')));
    assert.equal(second!.system, renderAgentInstructions(manifest('code-explorer')));
    assert.notEqual(first!.system, second!.system);
    // No execution state leaks between them: the second agent never saw the first one's conversation.
    assert.match(second!.user, /explore the repository/);
    assert.doesNotMatch(second!.user, /review the design/);
  } finally { await server.close(); }
});

test('a specialist moves to another compatible model without changing its id, role, instructions or tools', async () => {
  const server = await fakeModelServer('hello');
  try {
    const m = manifest('code-explorer');
    const before = createMastraSpecialist(m, { resolver: resolverFor(server.url) });
    const after = createMastraSpecialist(m, { resolver: resolverFor(server.url, { 'specialist-code-explorer': local('qwen3:14b') }) });
    assert.equal(after.id, before.id);
    assert.equal(after.name, before.name);
    assert.equal(await after.getInstructions(), await before.getInstructions());
    assert.deepEqual(Object.keys(await after.listTools()).sort(), Object.keys(await before.listTools()).sort());
    assert.equal(bindingOf(before)!.modelId, 'qwen3:8b');
    assert.equal(bindingOf(after)!.modelId, 'qwen3:14b');
    assert.equal(bindingOf(after)!.agentId, bindingOf(before)!.agentId);

    await before.generate('q');
    await after.generate('q');
    assert.deepEqual(server.seen.map((s) => s.model), ['qwen3:8b', 'qwen3:14b']);
    assert.deepEqual(server.seen[0]!.tools, server.seen[1]!.tools);
    assert.equal(server.seen[0]!.system, server.seen[1]!.system);
  } finally { await server.close(); }
});

test('the Go and JS coding workers share one model but never one tool set; the resolved model reaches the wire', async () => {
  const server = await fakeModelServer('done');
  try {
    const resolver = resolverFor(server.url);
    const go = createCodingWorker('go', 'writeFile', resolver);
    const js = createCodingWorker('js', 'writeFile', resolver);
    assert.equal(bindingOf(go)!.modelId, bindingOf(js)!.modelId);
    assert.notEqual(bindingOf(go)!.agentId, bindingOf(js)!.agentId);
    await go.generate('go task');
    await js.generate('js task');
    assert.ok(server.seen[0]!.tools.includes('runGoTest') && !server.seen[0]!.tools.includes('runJestTest'));
    assert.ok(server.seen[1]!.tools.includes('runJestTest') && !server.seen[1]!.tools.includes('runGoTest'));
    assert.deepEqual(server.seen.map((s) => [s.model, s.authorization]), [['qwen3:8b', 'Bearer key-for-test'], ['qwen3:8b', 'Bearer key-for-test']]);
  } finally { await server.close(); }
});

test('negative: a coding worker refuses to be built on an unauthorized, unavailable or incapable model; there is no fallback', () => {
  const url = 'http://127.0.0.1:1/v1';
  const withModel = (over: Partial<ModelEntry> & { modelId: string }): ModelEntry => ({ providerId: 'ollama', capabilities: caps, availability: ok, roles: AGENT_ROLES, ...over });
  const assign = (modelId: string, extra: ModelEntry) => resolverFor(url, { 'coding-worker-go': local(modelId) }, [extra]);
  const refused = (resolver: ModelResolver, code: string) => assert.throws(() => createCodingWorker('go', 'writeFile', resolver), (e: unknown) => e instanceof ModelResolutionError && e.code === code);
  refused(assign('specialists-only', withModel({ modelId: 'specialists-only', roles: ['specialist'] })), 'unauthorized_model');
  refused(assign('gone', withModel({ modelId: 'gone', availability: { state: 'unavailable', reason: 'not installed' } })), 'model_unavailable');
  refused(assign('no-tools', withModel({ modelId: 'no-tools', capabilities: { toolCalling: false, structuredOutput: true } })), 'capability_unsupported');
  refused(resolverFor(url, { 'coding-worker-go': local('never-registered') }), 'unknown_model');
});

test('registration reports each specialist the model policy refused instead of dropping it silently or substituting a model', () => {
  const url = 'http://127.0.0.1:1/v1';
  const reserved: ModelEntry = { providerId: 'ollama', modelId: 'reserved', capabilities: caps, availability: ok, roles: ['specialist'], agents: ['specialist-security-reviewer'] };
  const resolver = resolverFor(url, { 'specialist-code-explorer': local('reserved') }, [reserved]);
  const { agents, refused, error } = registerSpecialists(pack, { resolver });
  assert.equal(error, undefined);
  assert.deepEqual(refused.map((r) => [r.id, r.code]), [['code-explorer', 'unauthorized_model']]);
  assert.equal(Object.keys(agents).length, pack.agents.length - 1);
  assert.ok(!(specialistRegistryKey(manifest('code-explorer')) in agents));
  assert.equal(bindingOf(agents[specialistRegistryKey(manifest('security-reviewer'))])!.modelId, 'qwen3:8b', 'the others kept the default');
});

test('registration with an unavailable default provider registers nothing and says why for each specialist', () => {
  const registry = new ModelRegistry()
    .addProvider({ providerId: 'ollama', kind: 'local', url: 'http://127.0.0.1:1/v1', billing: 'local-free', credential: { env: 'OLLAMA_API_KEY', placeholder: 'ollama' }, availability: { state: 'unavailable', reason: 'disabled by operator' } })
    .addModel({ providerId: 'ollama', modelId: 'qwen3:8b', capabilities: caps, availability: ok, roles: AGENT_ROLES });
  const resolver = new ModelResolver(registry, { defaults: { 'coding-worker': local('qwen3:8b'), specialist: local('qwen3:8b') } });
  const { agents, refused } = registerSpecialists(pack, { resolver });
  assert.deepEqual(Object.keys(agents), []);
  assert.equal(refused.length, pack.agents.length);
  assert.ok(refused.every((r) => r.code === 'provider_unavailable' && /disabled by operator/.test(r.reason)));
});

test('an invalid model configuration file registers no specialists and reports the configuration error', () => {
  const before = process.env.AGENTIC_MODEL_CONFIG;
  process.env.AGENTIC_MODEL_CONFIG = '/nonexistent/models.json';
  try {
    const { agents, error } = registerSpecialists(pack);
    assert.deepEqual(Object.keys(agents), []);
    assert.match(error!, /cannot read AGENTIC_MODEL_CONFIG/);
  } finally {
    if (before === undefined) delete process.env.AGENTIC_MODEL_CONFIG; else process.env.AGENTIC_MODEL_CONFIG = before;
  }
});

test('a specialist manifest never selects a model: manifests carry no model field and resolution depends only on runtime configuration', () => {
  for (const m of pack.agents) assert.ok(!('model' in m) && !('modelId' in m), m.id);
  const url = 'http://127.0.0.1:1/v1';
  const base = resolveSpecialistModel(manifest('go-reviewer'), resolverFor(url));
  const moved = resolveSpecialistModel(manifest('go-reviewer'), resolverFor(url, { 'specialist-go-reviewer': local('qwen3:14b') }));
  assert.deepEqual([base.binding.modelId, moved.binding.modelId], ['qwen3:8b', 'qwen3:14b']);
  assert.equal(base.binding.agentId, moved.binding.agentId);
});

test('the ollama worker provider labels and probes the model its agent is bound to, and refuses an agent bound to another provider', async () => {
  const url = 'http://127.0.0.1:1/v1';
  const moved = createCodingWorker('go', 'writeFile', resolverFor(url, { 'coding-worker-go': local('qwen3:14b') }));
  const provider = createOllamaProvider(moved, {}, { OLLAMA_MODEL: 'qwen3:8b' });
  assert.equal(provider.provider.identity.id, 'ollama');
  assert.equal(provider.provider.identity.model, 'qwen3:14b', 'the run is labelled with the bound model, not the environment default');
  const probed: string[] = [];
  const fakeFetch = (async (input: unknown) => { probed.push(String(input)); return new Response(JSON.stringify({ models: [{ name: 'qwen3:14b' }] }), { status: 200 }); }) as typeof fetch;
  const { probeOllama } = await import('../../workers/providers/ollama.ts');
  assert.equal((await probeOllama({ OLLAMA_MODEL: 'qwen3:8b' }, fakeFetch, 'qwen3:14b')).state, 'available');
  assert.equal((await probeOllama({ OLLAMA_MODEL: 'qwen3:8b' }, fakeFetch)).state, 'unavailable', 'without a bound model the environment default is probed');

  const lmstudio = { providerId: 'lmstudio', kind: 'local' as const, url: 'http://127.0.0.1:2/v1', billing: 'local-free' as const, credential: { env: 'LMSTUDIO_API_KEY', placeholder: 'lm' }, availability: ok };
  const other = createCodingWorker('go', 'writeFile', (() => {
    const registry = new ModelRegistry().addProvider({ ...lmstudio }).addProvider({ ...lmstudio, providerId: 'ollama', url })
      .addModel({ providerId: 'lmstudio', modelId: 'qwen3-coder', capabilities: caps, availability: ok, roles: AGENT_ROLES })
      .addModel({ providerId: 'ollama', modelId: 'qwen3:8b', capabilities: caps, availability: ok, roles: AGENT_ROLES });
    return new ModelResolver(registry, { defaults: { 'coding-worker': local('qwen3:8b'), specialist: local('qwen3:8b') }, assignments: { 'coding-worker-go': { providerId: 'lmstudio', modelId: 'qwen3-coder' } } });
  })());
  assert.equal(bindingOf(other)!.providerId, 'lmstudio');
  assert.throws(() => createOllamaProvider(other), /cannot run agent coding-worker-go: it is bound to provider lmstudio/);
});

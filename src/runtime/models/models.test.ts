import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_ROLES, ModelConfigError, ModelRegistry, ModelResolutionError, ModelResolver, bindAgent, bindingMetadata, bindingOf, buildModelRuntime, loadModelConfigFile, modelResolverFromEnv, ollamaSettings, parseModelConfig, type ModelCapabilities, type ModelEntry, type ProviderConfig } from './index.ts';

const ok = { state: 'available' } as const;
const full: ModelCapabilities = { toolCalling: true, structuredOutput: true, contextTokens: 16384 };
const ollama: ProviderConfig = { providerId: 'ollama', kind: 'local', url: 'http://localhost:11434/v1', billing: 'local-free', credential: { env: 'OLLAMA_API_KEY', placeholder: 'ollama' }, availability: ok };
const cloud: ProviderConfig = { providerId: 'cloudco', kind: 'cloud', url: 'https://api.cloudco.example/v1', billing: 'metered', credential: { env: 'CLOUDCO_API_KEY' }, availability: ok };
const model = (over: Partial<ModelEntry> & { modelId: string }): ModelEntry => ({ providerId: 'ollama', capabilities: full, availability: ok, roles: AGENT_ROLES, ...over });

function registry(extra: (r: ModelRegistry) => void = () => {}): ModelRegistry {
  const r = new ModelRegistry().addProvider(ollama).addProvider(cloud).addModel(model({ modelId: 'qwen3:8b' })).addModel(model({ modelId: 'qwen3:14b' }));
  extra(r);
  return r;
}
const defaults = { 'coding-worker': { providerId: 'ollama', modelId: 'qwen3:8b' }, specialist: { providerId: 'ollama', modelId: 'qwen3:8b' } };
const spec = (agentId = 'specialist-security-reviewer') => ({ agentId, role: 'specialist' as const, requires: { toolCalling: true, structuredOutput: true } });
const refuses = (fn: () => unknown, code: string, pattern?: RegExp) =>
  assert.throws(fn, (err: unknown) => err instanceof ModelResolutionError && err.code === code && (!pattern || pattern.test(err.message)), `expected ${code}`);

test('the default configuration is exactly the local Ollama/Qwen wiring the workers used before the registry', () => {
  const r = buildModelRuntime({}).resolve(spec());
  assert.deepEqual(r.model, { providerId: 'ollama', modelId: 'qwen3:8b', url: 'http://localhost:11434/v1', apiKey: 'ollama' });
  assert.equal(r.billing, 'local-free');
  assert.equal(r.source, 'role-default');
  assert.equal(r.capabilities.contextTokens, undefined, 'an undeclared context window is never guessed');

  const env = { OLLAMA_BASE_URL: 'http://gpu-box:1234/', OLLAMA_MODEL: 'qwen3:14b', OLLAMA_API_KEY: 'from-env', OLLAMA_NUM_CTX: '16384' };
  const configured = buildModelRuntime(env).resolve({ agentId: 'coding-worker-go', role: 'coding-worker', requires: { toolCalling: true } });
  assert.deepEqual(configured.model, { providerId: 'ollama', modelId: 'qwen3:14b', url: 'http://gpu-box:1234/v1', apiKey: 'from-env' });
  assert.equal(configured.capabilities.contextTokens, 16384);
  assert.equal(ollamaSettings({ OLLAMA_NUM_CTX: 'abc' }).contextTokens, undefined);
  assert.equal(ollamaSettings({ OLLAMA_NUM_CTX: '0' }).contextTokens, undefined);
});

test('agentId, providerId and modelId are separate fields and flat metadata keys; no credential reaches the binding', () => {
  const r = new ModelResolver(registry(), { defaults }, { OLLAMA_API_KEY: 'distinct-key-value' }).resolve(spec('specialist-code-explorer'));
  assert.equal(r.model.apiKey, 'distinct-key-value');
  assert.deepEqual(r.binding, { agentId: 'specialist-code-explorer', role: 'specialist', providerId: 'ollama', modelId: 'qwen3:8b' });
  assert.deepEqual(bindingMetadata(r.binding), { agentId: 'specialist-code-explorer', agentRole: 'specialist', providerId: 'ollama', modelId: 'qwen3:8b' });
  assert.ok(!JSON.stringify([r.binding, bindingMetadata(r.binding)]).includes('distinct-key-value'));
  const agent = bindAgent({}, r.binding);
  assert.deepEqual(bindingOf(agent), r.binding);
  assert.equal(bindingOf({}), undefined);
  assert.throws(() => { (bindingOf(agent) as { modelId: string }).modelId = 'other'; }, TypeError, 'a recorded binding is immutable');
});

test('an assignment selects a different model for one agent without touching any other agent', () => {
  const resolver = new ModelResolver(registry(), { defaults, assignments: { 'specialist-security-reviewer': { providerId: 'ollama', modelId: 'qwen3:14b' } } });
  assert.equal(resolver.resolve(spec('specialist-security-reviewer')).binding.modelId, 'qwen3:14b');
  assert.equal(resolver.resolve(spec('specialist-security-reviewer')).source, 'assignment');
  assert.equal(resolver.resolve(spec('specialist-code-explorer')).binding.modelId, 'qwen3:8b');
});

test('resolution results are independent objects: sharing a model shares no state', () => {
  const resolver = new ModelResolver(registry(), { defaults });
  const a = resolver.resolve(spec('specialist-a'));
  const b = resolver.resolve(spec('specialist-b'));
  assert.notEqual(a.model, b.model);
  assert.notEqual(a.binding, b.binding);
  (a.model as { modelId: string }).modelId = 'tampered';
  assert.equal(resolver.resolve(spec('specialist-c')).model.modelId, 'qwen3:8b');
  assert.equal(b.model.modelId, 'qwen3:8b');
});

test('negative: an unknown model is refused', () => {
  const resolver = new ModelResolver(registry(), { defaults, assignments: { x: { providerId: 'ollama', modelId: 'does-not-exist' } } });
  refuses(() => resolver.resolve(spec('x')), 'unknown_model', /ollama\/does-not-exist/);
});

test('negative: an unknown provider is refused', () => {
  const resolver = new ModelResolver(registry(), { defaults, assignments: { x: { providerId: 'nowhere', modelId: 'qwen3:8b' } } });
  refuses(() => resolver.resolve(spec('x')), 'unknown_provider', /nowhere/);
});

test('negative: a model that lacks a required capability is refused, naming the capability', () => {
  const r = registry((reg) => reg.addModel(model({ modelId: 'tiny', capabilities: { toolCalling: false, structuredOutput: true } })).addModel(model({ modelId: 'chatty', capabilities: { toolCalling: true, structuredOutput: false } })));
  const resolver = new ModelResolver(r, { defaults, assignments: { x: { providerId: 'ollama', modelId: 'tiny' }, y: { providerId: 'ollama', modelId: 'chatty' } } });
  refuses(() => resolver.resolve(spec('x')), 'capability_unsupported', /toolCalling/);
  refuses(() => resolver.resolve(spec('y')), 'capability_unsupported', /structuredOutput/);
  // The same model is fine for an agent that does not need the capability: requirements narrow, they do not forbid.
  assert.equal(resolver.resolve({ agentId: 'x', role: 'specialist' }).binding.modelId, 'tiny');
});

test('negative: an unavailable provider or model is refused, and the available default is NOT substituted', () => {
  const down: ProviderConfig = { ...ollama, providerId: 'ollama-down', availability: { state: 'unavailable', reason: 'maintenance' } };
  const r = registry((reg) => reg.addProvider(down).addModel(model({ providerId: 'ollama-down', modelId: 'qwen3:8b' })).addModel(model({ modelId: 'pulled-out', availability: { state: 'unavailable', reason: 'not installed' } })));
  const resolver = new ModelResolver(r, { defaults, assignments: { p: { providerId: 'ollama-down', modelId: 'qwen3:8b' }, m: { providerId: 'ollama', modelId: 'pulled-out' } } });
  refuses(() => resolver.resolve(spec('p')), 'provider_unavailable', /maintenance/);
  refuses(() => resolver.resolve(spec('m')), 'model_unavailable', /not installed/);
  assert.equal(resolver.resolve(spec('other')).binding.modelId, 'qwen3:8b', 'the default still works for agents that were never assigned elsewhere');
});

test('negative: a model not authorized for the role or the agent is refused', () => {
  const r = registry((reg) => reg
    .addModel(model({ modelId: 'workers-only', roles: ['coding-worker'] }))
    .addModel(model({ modelId: 'reserved', agents: ['specialist-security-reviewer'] })));
  const resolver = new ModelResolver(r, { defaults, assignments: {
    'specialist-code-explorer': { providerId: 'ollama', modelId: 'workers-only' },
    'specialist-spec-miner': { providerId: 'ollama', modelId: 'reserved' },
    'specialist-security-reviewer': { providerId: 'ollama', modelId: 'reserved' },
  } });
  refuses(() => resolver.resolve(spec('specialist-code-explorer')), 'unauthorized_model', /role specialist/);
  refuses(() => resolver.resolve(spec('specialist-spec-miner')), 'unauthorized_model', /agent specialist-spec-miner/);
  assert.equal(resolver.resolve(spec('specialist-security-reviewer')).binding.modelId, 'reserved');
});

test('a paid provider can never be a default, and is used only when assigned to the exact agent', () => {
  const r = registry((reg) => reg.addModel({ providerId: 'cloudco', modelId: 'big', capabilities: full, availability: ok, roles: ['specialist'] }));
  assert.throws(() => new ModelResolver(r, { defaults: { ...defaults, specialist: { providerId: 'cloudco', modelId: 'big' } } }), ModelConfigError);
  const env = { CLOUDCO_API_KEY: 'test-value' };
  const resolver = new ModelResolver(r, { defaults, assignments: { 'specialist-security-reviewer': { providerId: 'cloudco', modelId: 'big' } } }, env);
  const paid = resolver.resolve(spec('specialist-security-reviewer'));
  assert.equal(paid.billing, 'metered');
  assert.equal(paid.model.apiKey, 'test-value');
  // Neighbours stay on the free local default; nothing drifts to the paid model.
  assert.equal(resolver.resolve(spec('specialist-code-explorer')).binding.providerId, 'ollama');
  // The credential comes from the named variable only; without it the paid model is refused rather than called unauthenticated.
  refuses(() => new ModelResolver(r, { defaults, assignments: { x: { providerId: 'cloudco', modelId: 'big' } } }, {}).resolve(spec('x')), 'credential_missing', /CLOUDCO_API_KEY/);
});

test('a default that is not registered is a configuration error at construction, not a late surprise', () => {
  assert.throws(() => new ModelResolver(registry(), { defaults: { ...defaults, specialist: { providerId: 'ollama', modelId: 'missing' } } }), ModelConfigError);
  assert.throws(() => new ModelResolver(registry(), { defaults: { 'coding-worker': defaults['coding-worker'] } as never }), /no default model configured for role specialist/);
});

test('the registry rejects duplicates and models on unregistered providers; assignments cannot reach Object.prototype', () => {
  assert.throws(() => registry().addProvider(ollama), /already registered/);
  assert.throws(() => registry().addModel(model({ modelId: 'qwen3:8b' })), /already registered/);
  assert.throws(() => registry().addModel(model({ providerId: 'ghost', modelId: 'm' })), /not registered/);
  const resolver = new ModelResolver(registry(), { defaults });
  assert.equal(resolver.resolve(spec('constructor')).source, 'role-default');
  assert.equal(resolver.resolve(spec('__proto__')).source, 'role-default');
});

// --- configuration file ---

const fileText = (over: Record<string, unknown> = {}) => JSON.stringify({
  schema: 'agentic.model-config/1',
  providers: [{ providerId: 'lmstudio', kind: 'local', url: 'http://localhost:1234/v1', billing: 'local-free', credential: { env: 'LMSTUDIO_API_KEY', placeholder: 'lm-studio' } }],
  models: [{ providerId: 'lmstudio', modelId: 'qwen3-coder', capabilities: { toolCalling: true, structuredOutput: true, contextTokens: 32768 }, roles: ['specialist'] }],
  assignments: [{ agentId: 'specialist-security-reviewer', providerId: 'lmstudio', modelId: 'qwen3-coder' }],
  ...over,
});

test('a config file extends the default: the local default stays, and only the named agent moves', () => {
  const resolver = buildModelRuntime({}, parseModelConfig(fileText()));
  assert.deepEqual(resolver.resolve(spec('specialist-security-reviewer')).model, { providerId: 'lmstudio', modelId: 'qwen3-coder', url: 'http://localhost:1234/v1', apiKey: 'lm-studio' });
  assert.equal(resolver.resolve(spec('specialist-code-explorer')).binding.providerId, 'ollama');
  // The new model is authorized for specialists only, so a coding worker assigned to it is refused.
  const worker = buildModelRuntime({}, parseModelConfig(fileText({ assignments: [{ agentId: 'coding-worker-go', providerId: 'lmstudio', modelId: 'qwen3-coder' }] })));
  refuses(() => worker.resolve({ agentId: 'coding-worker-go', role: 'coding-worker', requires: { toolCalling: true } }), 'unauthorized_model');
});

test('negative: an invalid config file is rejected, never partially applied or replaced by the default', () => {
  const bad = (text: string, pattern: RegExp) => assert.throws(() => parseModelConfig(text), (e: unknown) => e instanceof ModelConfigError && pattern.test(e.message));
  bad('{nope', /not valid JSON/);
  bad(fileText({ schema: 'something/else' }), /schema/);
  bad(fileText({ surprise: true }), /surprise|Unrecognized/i);
  bad(fileText({ providers: [{ providerId: 'x-ai', kind: 'cloud', url: 'https://x.example/v1', billing: 'local-free', credential: { env: 'X_KEY' } }] }), /cloud provider cannot be billed 'local-free'/);
  bad(fileText({ providers: [{ providerId: 'x-ai', kind: 'cloud', url: 'http://x.example/v1', billing: 'metered', credential: { env: 'X_KEY' } }] }), /must use https/);
  bad(fileText({ providers: [{ providerId: 'x-ai', kind: 'cloud', url: 'https://x.example/v1', billing: 'metered', credential: { env: 'X_KEY', placeholder: 'anything' } }] }), /placeholder/);
  bad(fileText({ providers: [{ providerId: 'x-ai', kind: 'local', url: 'http://user:pw@h/v1', billing: 'local-free', credential: { env: 'X_KEY' } }] }), /embed credentials/);
  bad(fileText({ providers: [{ providerId: 'x-ai', kind: 'local', url: 'ftp://h/v1', billing: 'local-free', credential: { env: 'X_KEY' } }] }), /http\(s\)/);
  bad(fileText({ providers: [{ providerId: 'x-ai', kind: 'local', url: 'not a url', billing: 'local-free', credential: { env: 'X_KEY' } }] }), /not a valid URL/);
  bad(fileText({ providers: [{ providerId: 'x-ai', kind: 'local', url: 'http://h/v1', billing: 'local-free', credential: { env: 'lowercase' } }] }), /credential/);
  // A key pasted where a variable name belongs.
  bad(fileText({ providers: [{ providerId: 'x-ai', kind: 'local', url: 'http://h/v1', billing: 'local-free', credential: { env: 'X_KEY', placeholder: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }] }), /looks like a credential/);
  // Duplicate / unregistered references are caught when the runtime is built.
  assert.throws(() => buildModelRuntime({}, parseModelConfig(fileText({ providers: [{ providerId: 'ollama', kind: 'local', url: 'http://h/v1', billing: 'local-free', credential: { env: 'K_ENV' } }] }))), /already registered/);
  assert.throws(() => buildModelRuntime({}, parseModelConfig(fileText({ assignments: [{ agentId: 'a', providerId: 'lmstudio', modelId: 'qwen3-coder' }, { agentId: 'a', providerId: 'lmstudio', modelId: 'qwen3-coder' }] }))), /assigned a model twice/);
  assert.throws(() => buildModelRuntime({}, parseModelConfig(fileText({ defaults: { specialist: { providerId: 'lmstudio', modelId: 'missing' } } }))), /not registered/);
});

test('a paid provider declared in a file still cannot become a default', () => {
  const paid = fileText({
    providers: [{ providerId: 'cloudco', kind: 'cloud', url: 'https://api.cloudco.example/v1', billing: 'metered', credential: { env: 'CLOUDCO_API_KEY' } }],
    models: [{ providerId: 'cloudco', modelId: 'big', capabilities: { toolCalling: true, structuredOutput: true }, roles: ['specialist'] }],
    assignments: [],
    defaults: { specialist: { providerId: 'cloudco', modelId: 'big' } },
  });
  assert.throws(() => buildModelRuntime({ CLOUDCO_API_KEY: 'v' }, parseModelConfig(paid)), /never be a default/);
});

test('AGENTIC_MODEL_CONFIG: a missing or invalid file fails loudly instead of falling back to the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-config-'));
  const good = join(dir, 'models.json');
  writeFileSync(good, fileText());
  assert.equal(modelResolverFromEnv({ AGENTIC_MODEL_CONFIG: good }).resolve(spec('specialist-security-reviewer')).binding.providerId, 'lmstudio');
  assert.equal(loadModelConfigFile(good).models.length, 1);
  assert.throws(() => modelResolverFromEnv({ AGENTIC_MODEL_CONFIG: join(dir, 'absent.json') }), /cannot read AGENTIC_MODEL_CONFIG/);
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{"schema":"agentic.model-config/1","models":[{}]}');
  assert.throws(() => modelResolverFromEnv({ AGENTIC_MODEL_CONFIG: broken }), ModelConfigError);
  assert.equal(modelResolverFromEnv({}).resolve(spec()).binding.providerId, 'ollama', 'no variable, no file: the local default');
});

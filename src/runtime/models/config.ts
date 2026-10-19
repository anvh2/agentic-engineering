/**
 * Model runtime configuration.
 *
 * Default: local Ollama serving `OLLAMA_MODEL` (qwen3:8b), exactly the endpoint, model and key the coding workers and
 * specialists used before this registry existed. That is the ONLY thing configured unless the operator points
 * `AGENTIC_MODEL_CONFIG` at a JSON file, which can add providers, models and per-agent assignments. A file that is unreadable or
 * invalid fails loudly; it is never ignored in favour of the default.
 *
 * Credentials never appear in configuration: a provider names the environment variable that holds its key.
 */
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { scanForSecrets } from '../knowledge/canonical.ts';
import { AGENT_ROLES, ModelConfigError, ModelRegistry, type AgentRole, type ModelEntry, type ModelRef, type ProviderConfig } from './registry.ts';
import { ModelResolver, type ModelPolicy } from './resolver.ts';

export const MODEL_CONFIG_SCHEMA = 'agentic.model-config/1';
export const MODEL_CONFIG_ENV = 'AGENTIC_MODEL_CONFIG';
const MAX_CONFIG_BYTES = 256 * 1024;

export const OLLAMA_PROVIDER_ID = 'ollama';

/** The one place the local-model defaults live. Reading the environment contacts nothing. */
export function ollamaSettings(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; modelId: string; contextTokens: number | undefined } {
  const ctx = Number(env.OLLAMA_NUM_CTX);
  return {
    baseUrl: (env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, ''),
    modelId: env.OLLAMA_MODEL ?? 'qwen3:8b',
    contextTokens: env.OLLAMA_NUM_CTX && Number.isSafeInteger(ctx) && ctx > 0 ? ctx : undefined,
  };
}

function defaultRuntime(env: NodeJS.ProcessEnv): { registry: ModelRegistry; policy: ModelPolicy } {
  const ollama = ollamaSettings(env);
  const registry = new ModelRegistry()
    .addProvider({
      providerId: OLLAMA_PROVIDER_ID,
      kind: 'local',
      url: `${ollama.baseUrl}/v1`, // Ollama exposes an OpenAI-compatible API under /v1.
      billing: 'local-free',
      credential: { env: 'OLLAMA_API_KEY', placeholder: 'ollama' },
      availability: { state: 'available' },
    })
    .addModel({
      providerId: OLLAMA_PROVIDER_ID,
      modelId: ollama.modelId,
      // Declared, not measured: the workers already depend on tool calling, and specialists reply with a JSON report.
      capabilities: { toolCalling: true, structuredOutput: true, ...(ollama.contextTokens !== undefined ? { contextTokens: ollama.contextTokens } : {}) },
      availability: { state: 'available' },
      roles: AGENT_ROLES,
    });
  const local: ModelRef = { providerId: OLLAMA_PROVIDER_ID, modelId: ollama.modelId };
  return { registry, policy: { defaults: { 'coding-worker': local, specialist: local }, assignments: {} } };
}

const providerId = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
const modelId = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const agentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/);
const role = z.enum(AGENT_ROLES);
const availability = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('available') }),
  z.strictObject({ state: z.literal('unavailable'), reason: z.string().min(1).max(300) }),
]);
const ref = z.strictObject({ providerId, modelId });

const providerSchema = z.strictObject({
  providerId,
  kind: z.enum(['local', 'cloud']),
  url: z.string().max(300),
  billing: z.enum(['local-free', 'metered', 'subscription-quota']),
  credential: z.strictObject({ env: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), placeholder: z.string().min(1).max(64).optional() }),
  availability: availability.default({ state: 'available' }),
});

const modelSchema = z.strictObject({
  providerId,
  modelId,
  capabilities: z.strictObject({
    toolCalling: z.boolean(),
    structuredOutput: z.boolean(),
    contextTokens: z.number().int().min(2048).max(10_000_000).optional(),
  }),
  availability: availability.default({ state: 'available' }),
  roles: z.array(role).min(1).max(AGENT_ROLES.length),
  agents: z.array(agentId).min(1).max(64).optional(),
});

export const modelConfigFileSchema = z.strictObject({
  schema: z.literal(MODEL_CONFIG_SCHEMA),
  providers: z.array(providerSchema).max(16).default([]),
  models: z.array(modelSchema).max(64).default([]),
  assignments: z.array(z.strictObject({ agentId, providerId, modelId })).max(128).default([]),
  defaults: z.strictObject({ 'coding-worker': ref.optional(), specialist: ref.optional() }).default({}),
});
export type ModelConfigFile = z.infer<typeof modelConfigFileSchema>;

function checkProvider(p: ModelConfigFile['providers'][number]): void {
  let url: URL;
  try { url = new URL(p.url); } catch { throw new ModelConfigError(`provider ${p.providerId}: url is not a valid URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ModelConfigError(`provider ${p.providerId}: url must be http(s)`);
  if (url.username || url.password) throw new ModelConfigError(`provider ${p.providerId}: url must not embed credentials; name an environment variable in "credential.env"`);
  // A cloud provider labelled 'local-free' would slip past the rule that paid models need an explicit assignment.
  if (p.kind === 'cloud' && p.billing === 'local-free') throw new ModelConfigError(`provider ${p.providerId}: a cloud provider cannot be billed 'local-free'`);
  if (p.kind === 'cloud' && url.protocol !== 'https:') throw new ModelConfigError(`provider ${p.providerId}: a cloud provider must use https`);
  if (p.kind === 'cloud' && p.credential.placeholder !== undefined) throw new ModelConfigError(`provider ${p.providerId}: only a local provider may use a credential placeholder`);
}

/** Parses and validates configuration text. Throws ModelConfigError; never returns a partially valid file. */
export function parseModelConfig(text: string): ModelConfigFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ModelConfigError('model config is not valid JSON'); }
  const parsed = modelConfigFileSchema.safeParse(raw);
  if (!parsed.success) throw new ModelConfigError(`model config invalid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`);
  if (scanForSecrets(parsed.data).length) throw new ModelConfigError('model config contains something that looks like a credential; name an environment variable instead');
  parsed.data.providers.forEach(checkProvider);
  return parsed.data;
}

export function loadModelConfigFile(path: string): ModelConfigFile {
  let size: number;
  try { size = statSync(path).size; } catch (err) { throw new ModelConfigError(`cannot read ${MODEL_CONFIG_ENV} file ${path}: ${(err as Error).message}`); }
  if (size > MAX_CONFIG_BYTES) throw new ModelConfigError(`model config ${path} is larger than ${MAX_CONFIG_BYTES} bytes`);
  return parseModelConfig(readFileSync(path, 'utf8'));
}

/** Builds registry and policy: the local Ollama default, extended by `file` when given. A duplicate id is an error, not an override. */
export function buildModelRuntime(env: NodeJS.ProcessEnv = process.env, file?: ModelConfigFile): ModelResolver {
  const { registry, policy } = defaultRuntime(env);
  const assignments: Record<string, ModelRef> = {};
  const defaults: Record<AgentRole, ModelRef> = { ...policy.defaults };
  if (file) {
    for (const p of file.providers) registry.addProvider(p as ProviderConfig);
    for (const m of file.models) registry.addModel(m as ModelEntry);
    for (const a of file.assignments) {
      if (Object.hasOwn(assignments, a.agentId)) throw new ModelConfigError(`agent ${a.agentId} is assigned a model twice`);
      assignments[a.agentId] = { providerId: a.providerId, modelId: a.modelId };
    }
    for (const r of AGENT_ROLES) if (file.defaults[r]) defaults[r] = file.defaults[r]!;
  }
  return new ModelResolver(registry, { defaults, assignments }, env);
}

/** The resolver for this process: the default local model plus the file named by AGENTIC_MODEL_CONFIG, if any. */
export function modelResolverFromEnv(env: NodeJS.ProcessEnv = process.env): ModelResolver {
  const path = env[MODEL_CONFIG_ENV];
  return buildModelRuntime(env, path ? loadModelConfigFile(path) : undefined);
}

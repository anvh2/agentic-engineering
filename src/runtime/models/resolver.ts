/**
 * ModelResolver: turns "this agent, in this role, needs these capabilities" into an authorized runtime model configuration.
 *
 * Every refusal is an explicit, coded error. There is NO fallback: an unknown, unauthorized, unavailable or incapable model never
 * results in a different model being chosen on the caller's behalf. Candidates are only ever
 *   1. the model explicitly assigned to the agent id, else
 *   2. the configured default for the agent's role (which the constructor guarantees is a local, free model).
 * A model on a provider that is not 'local-free' therefore runs only when an operator assigned it to that exact agent.
 */
import type { AgentRole, ModelCapabilities, ModelRef, ModelRegistry, ProviderConfig } from './registry.ts';
import { AGENT_ROLES, ModelConfigError } from './registry.ts';

export type ModelResolutionCode =
  | 'no_assignment'
  | 'unknown_provider'
  | 'unknown_model'
  | 'unauthorized_model'
  | 'paid_requires_assignment'
  | 'provider_unavailable'
  | 'model_unavailable'
  | 'capability_unsupported'
  | 'credential_missing';

export class ModelResolutionError extends Error {
  readonly code: ModelResolutionCode;
  readonly agentId: string;
  constructor(code: ModelResolutionCode, agentId: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ModelResolutionError';
    this.code = code;
    this.agentId = agentId;
  }
}

/** What an agent definition may ask for. Declaring a requirement never grants a model; it can only narrow what is acceptable. */
export interface ModelRequirements {
  toolCalling?: boolean;
  structuredOutput?: boolean;
}

export interface AgentModelRequest {
  /** Stable agent identity, e.g. `specialist-security-reviewer`, `coding-worker-go`. Never derived from a model name. */
  agentId: string;
  role: AgentRole;
  requires?: ModelRequirements;
}

/** The identity triple that execution metadata, traces and results carry. Contains no credentials. */
export interface ModelBinding {
  agentId: string;
  role: AgentRole;
  providerId: string;
  modelId: string;
}

/** Shape Mastra accepts for an OpenAI-compatible model. Holds the credential: pass it to the agent, never log or persist it. */
export interface RuntimeModelConfig {
  providerId: string;
  modelId: string;
  url: string;
  apiKey: string;
}

export interface ResolvedModel {
  binding: ModelBinding;
  model: RuntimeModelConfig;
  capabilities: Readonly<ModelCapabilities>;
  billing: ProviderConfig['billing'];
  source: 'assignment' | 'role-default';
}

export interface ModelPolicy {
  /** agentId -> the model that agent runs on. The only way to select a model that is not a free local default. */
  assignments?: Readonly<Record<string, ModelRef>>;
  /** role -> default model. Must exist and be 'local-free'; checked when the resolver is constructed. */
  defaults: Readonly<Record<AgentRole, ModelRef>>;
}

export class ModelResolver {
  private readonly registry: ModelRegistry;
  private readonly policy: ModelPolicy;
  private readonly env: NodeJS.ProcessEnv;

  constructor(registry: ModelRegistry, policy: ModelPolicy, env: NodeJS.ProcessEnv = process.env) {
    for (const role of AGENT_ROLES) {
      const ref = policy.defaults[role];
      if (!ref) throw new ModelConfigError(`no default model configured for role ${role}`);
      const provider = registry.provider(ref.providerId);
      if (!provider || !registry.model(ref)) throw new ModelConfigError(`default model for role ${role} (${ref.providerId}/${ref.modelId}) is not registered`);
      if (provider.billing !== 'local-free') throw new ModelConfigError(`default model for role ${role} is on provider ${provider.providerId} (${provider.billing}); a paid model can only be assigned to a named agent, never be a default`);
    }
    this.registry = registry;
    this.policy = policy;
    this.env = env;
  }

  resolve(request: AgentModelRequest): ResolvedModel {
    const { agentId, role } = request;
    const assigned = Object.hasOwn(this.policy.assignments ?? {}, agentId) ? this.policy.assignments![agentId] : undefined;
    const ref = assigned ?? this.policy.defaults[role];
    const source = assigned ? 'assignment' : 'role-default';
    if (!ref) throw new ModelResolutionError('no_assignment', agentId, `no model is assigned to ${agentId} and role ${role} has no default`);

    const provider = this.registry.provider(ref.providerId);
    if (!provider) throw new ModelResolutionError('unknown_provider', agentId, `provider "${ref.providerId}" is not registered`);
    const model = this.registry.model(ref);
    if (!model) throw new ModelResolutionError('unknown_model', agentId, `model ${ref.providerId}/${ref.modelId} is not registered`);

    if (!model.roles.includes(role)) throw new ModelResolutionError('unauthorized_model', agentId, `model ${ref.providerId}/${ref.modelId} is not authorized for role ${role}`);
    if (model.agents && !model.agents.includes(agentId)) throw new ModelResolutionError('unauthorized_model', agentId, `model ${ref.providerId}/${ref.modelId} is not authorized for agent ${agentId}`);
    if (provider.billing !== 'local-free' && source !== 'assignment') throw new ModelResolutionError('paid_requires_assignment', agentId, `provider ${provider.providerId} is ${provider.billing}; it can only be used when assigned to the agent explicitly`);

    if (provider.availability.state !== 'available') throw new ModelResolutionError('provider_unavailable', agentId, `provider ${provider.providerId} is unavailable: ${provider.availability.reason}`);
    if (model.availability.state !== 'available') throw new ModelResolutionError('model_unavailable', agentId, `model ${ref.providerId}/${ref.modelId} is unavailable: ${model.availability.reason}`);

    const missing = (['toolCalling', 'structuredOutput'] as const).filter((cap) => request.requires?.[cap] && !model.capabilities[cap]);
    if (missing.length) throw new ModelResolutionError('capability_unsupported', agentId, `model ${ref.providerId}/${ref.modelId} lacks required capability: ${missing.join(', ')}`);

    const apiKey = this.env[provider.credential.env] || provider.credential.placeholder;
    if (!apiKey) throw new ModelResolutionError('credential_missing', agentId, `environment variable ${provider.credential.env} is not set for provider ${provider.providerId}`);

    return {
      binding: { agentId, role, providerId: provider.providerId, modelId: model.modelId },
      model: { providerId: provider.providerId, modelId: model.modelId, url: provider.url, apiKey },
      capabilities: model.capabilities,
      billing: provider.billing,
      source,
    };
  }
}

/** Flat, credential-free trace/metadata fields for a binding. The three ids stay separate keys on purpose. */
export const bindingMetadata = (binding: ModelBinding): Record<string, string> => ({ agentId: binding.agentId, agentRole: binding.role, providerId: binding.providerId, modelId: binding.modelId });

// An Agent carries no metadata slot of its own, so the binding it was constructed with is kept beside it. This lets a caller
// holding only the agent (for instance from `mastra.getAgent`) ask which model it is actually bound to.
const bindings = new WeakMap<object, ModelBinding>();
export const bindAgent = <T extends object>(agent: T, binding: ModelBinding): T => (bindings.set(agent, Object.freeze({ ...binding })), agent);
export const bindingOf = (agent: object | undefined | null): ModelBinding | undefined => (agent ? bindings.get(agent) : undefined);

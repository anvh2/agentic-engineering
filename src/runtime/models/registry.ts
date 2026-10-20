/**
 * Model registry: which inference providers and models exist, what each can do, and who may use it.
 *
 * Vocabulary (see docs/engineering/adr-agent-model-role-boundaries.md): a model and a provider are not an agent. An agent has
 * a stable `agentId` and a `role`; it is *bound* to a (providerId, modelId) pair per run by the ModelResolver, never by its own
 * manifest. Nothing here is an authorization principal for tools, review or verification: this only decides which model an agent
 * may be run on, and that decision is made by runtime configuration, never by the model or the agent definition.
 */

export const AGENT_ROLES = ['coding-worker', 'specialist'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export type Availability = { state: 'available' } | { state: 'unavailable'; reason: string };

export interface ProviderConfig {
  providerId: string;
  kind: 'local' | 'cloud';
  /** OpenAI-compatible endpoint root (Ollama: `http://localhost:11434/v1`). */
  url: string;
  /** Anything other than 'local-free' spends money or quota and can only be used when explicitly assigned. */
  billing: 'local-free' | 'metered' | 'subscription-quota';
  /**
   * The NAME of the environment variable holding the key; a key itself never appears in configuration. `placeholder` is the
   * literal sent when the variable is unset, for local servers that ignore the key (Ollama).
   */
  credential: { env: string; placeholder?: string };
  /** Configured state. A live reachability check is a separate, async concern (see probeOllama). */
  availability: Availability;
}

export interface ModelCapabilities {
  toolCalling: boolean;
  structuredOutput: boolean;
  /** Context window the operator declared; undefined when unknown. Never guessed. */
  contextTokens?: number;
}

export interface ModelEntry extends ModelRef {
  capabilities: ModelCapabilities;
  availability: Availability;
  /** Roles allowed to run on this model. This is authorization, not a hint. */
  roles: readonly AgentRole[];
  /** When present, only these agent ids may run on the model, in addition to the role check. */
  agents?: readonly string[];
}

export class ModelConfigError extends Error {
  readonly code = 'invalid_model_config';
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

const keyOf = (ref: ModelRef): string => JSON.stringify([ref.providerId, ref.modelId]);

/** Typed catalog. Registration is strict and additive: a duplicate or a model on an unregistered provider is a configuration error. */
export class ModelRegistry {
  private readonly providers = new Map<string, ProviderConfig>();
  private readonly models = new Map<string, ModelEntry>();

  addProvider(provider: ProviderConfig): this {
    if (this.providers.has(provider.providerId)) throw new ModelConfigError(`provider "${provider.providerId}" is already registered`);
    this.providers.set(provider.providerId, Object.freeze({ ...provider }));
    return this;
  }

  addModel(model: ModelEntry): this {
    if (!this.providers.has(model.providerId)) throw new ModelConfigError(`model "${model.modelId}" names provider "${model.providerId}", which is not registered`);
    if (this.models.has(keyOf(model))) throw new ModelConfigError(`model ${model.providerId}/${model.modelId} is already registered`);
    this.models.set(keyOf(model), Object.freeze({ ...model, capabilities: Object.freeze({ ...model.capabilities }) }));
    return this;
  }

  provider(providerId: string): ProviderConfig | undefined {
    return this.providers.get(providerId);
  }

  model(ref: ModelRef): ModelEntry | undefined {
    return this.models.get(keyOf(ref));
  }

  listProviders(): readonly ProviderConfig[] {
    return [...this.providers.values()];
  }

  listModels(): readonly ModelEntry[] {
    return [...this.models.values()];
  }
}

import type { ProviderAvailability, ProviderDescriptor, TaskType } from '../../runtime/execution/worker-provider.ts';
import type { WorkerProvider } from './provider.ts';

/**
 * Providers the runtime can run a task on. Selection is explicit: a task names a provider id or gets DEFAULT_PROVIDER_ID.
 * There is no fallback between providers here: a provider that is unavailable fails the task, and moving it elsewhere is a
 * decision for the Lead (a cloud provider is paid/quota-limited and is never switched to silently).
 */

export const DEFAULT_PROVIDER_ID = 'ollama';

export interface ProviderContext {
  taskType: TaskType;
  /** Mastra handle for providers that run through an agent (the local model). */
  mastra?: { getAgent(id: string): unknown };
  tracingContext?: unknown;
}

export interface ProviderEntry {
  id: string;
  /** Static description, available without constructing or contacting anything. */
  describe(): ProviderDescriptor;
  probe(): Promise<ProviderAvailability>;
  create(ctx: ProviderContext): WorkerProvider;
}

export class UnknownProviderError extends Error {
  readonly code = 'unknown_provider';
  constructor(id: string, known: string[]) {
    super(`unknown worker provider "${id}"; registered: ${known.join(', ') || 'none'}`);
    this.name = 'UnknownProviderError';
  }
}

export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderEntry>();

  register(entry: ProviderEntry): this {
    if (this.entries.has(entry.id)) throw new Error(`worker provider "${entry.id}" is already registered`);
    this.entries.set(entry.id, entry);
    return this;
  }

  get(id: string = DEFAULT_PROVIDER_ID): ProviderEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new UnknownProviderError(id, this.ids());
    return entry;
  }

  ids(): string[] {
    return [...this.entries.keys()].sort();
  }

  /** What each provider is and whether it can run now (the basis of `lead providers`). */
  async survey(): Promise<{ id: string; descriptor: ProviderDescriptor; availability: ProviderAvailability }[]> {
    return Promise.all(this.ids().map(async (id) => ({ id, descriptor: this.get(id).describe(), availability: await this.get(id).probe() })));
  }
}

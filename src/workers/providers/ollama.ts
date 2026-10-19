import type { Agent } from '@mastra/core/agent';
import type { WorkerLike } from '../../runtime/execution/coding-task-runner.ts';
import type { ProviderAvailability, ProviderDescriptor, TaskType } from '../../runtime/execution/worker-provider.ts';
import { OLLAMA_PROVIDER_ID, bindingOf, ollamaSettings } from '../../runtime/models/index.ts';
import { asStreamingWorker } from '../streaming-worker.ts';
import type { WorkerProvider } from './provider.ts';

/**
 * The default provider: the local Ollama model driven through a Mastra agent. Behavior is exactly what it was before
 * providers existed (same agent, same scoped tools, same stream-and-wait transport, same machine-wide 'ollama' permit);
 * this only adds the descriptor and the availability probe.
 */

export function ollamaDescriptor(env: NodeJS.ProcessEnv = process.env): ProviderDescriptor {
  return {
    identity: { id: 'ollama', kind: 'local', model: ollamaSettings(env).modelId },
    capabilities: {
      taskTypes: ['go', 'js'] satisfies TaskType[],
      editsFiles: 'via-runtime-tools',
      fileScope: 'tool-enforced', // repository tools refuse protected paths; the runner re-checks the filesystem regardless
      cancellation: 'abort-signal',
      usage: 'tokens',
      billing: 'local-free',
    },
    capacity: { resource: 'ollama', defaultPermits: 1 },
  };
}

export async function probeOllama(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, modelId?: string): Promise<ProviderAvailability> {
  const { baseUrl: base, modelId: defaultModel } = ollamaSettings(env);
  const model = modelId ?? defaultModel;
  try {
    const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return { state: 'unavailable', detail: `Ollama at ${base} answered HTTP ${res.status}` };
    const names = ((await res.json()) as { models?: { name?: string }[] }).models?.map((m) => m.name) ?? [];
    return names.includes(model) ? { state: 'available', detail: `${model} is installed at ${base}` } : { state: 'unavailable', detail: `Ollama is up at ${base} but model ${model} is not installed (have: ${names.slice(0, 8).join(', ') || 'none'})` };
  } catch (err) {
    return { state: 'unavailable', detail: `Ollama not reachable at ${base}: ${(err as Error).message}` };
  }
}

/**
 * Wraps a Mastra coding agent as a provider. `providerRequest` is the contract's per-call context; the Mastra agent has no use for it and never sees it.
 * The model named in the identity (and probed) is the one the agent is bound to, so a worker assigned another Ollama model is
 * labelled and probed as that model. This provider's capacity permit and probe are Ollama-specific, so an agent bound to any
 * other provider is refused here rather than run under a label that would be wrong.
 */
export function createOllamaProvider(agent: Pick<Agent, 'stream'>, defaults: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): WorkerProvider {
  const binding = bindingOf(agent);
  if (binding && binding.providerId !== OLLAMA_PROVIDER_ID) throw new Error(`the ${OLLAMA_PROVIDER_ID} worker provider cannot run agent ${binding.agentId}: it is bound to provider ${binding.providerId}`);
  const base = ollamaDescriptor(env);
  const descriptor: ProviderDescriptor = binding ? { ...base, identity: { ...base.identity, model: binding.modelId } } : base;
  const inner: WorkerLike = asStreamingWorker(agent, defaults);
  return {
    provider: descriptor,
    probe: () => probeOllama(env, fetch, binding?.modelId),
    generate: (prompt, options) => {
      const { providerRequest: _providerRequest, ...agentOptions } = options;
      return inner.generate(prompt, agentOptions);
    },
  };
}

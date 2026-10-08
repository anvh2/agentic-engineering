import type { Agent } from '@mastra/core/agent';
import type { WorkerLike } from '../../runtime/execution/coding-task-runner.ts';
import type { ProviderAvailability, ProviderDescriptor, TaskType } from '../../runtime/execution/worker-provider.ts';
import { asStreamingWorker } from '../streaming-worker.ts';
import type { WorkerProvider } from './provider.ts';

/**
 * The default provider: the local Ollama model driven through a Mastra agent. Behavior is exactly what it was before
 * providers existed (same agent, same scoped tools, same stream-and-wait transport, same machine-wide 'ollama' permit);
 * this only adds the descriptor and the availability probe.
 */

export function ollamaDescriptor(env: NodeJS.ProcessEnv = process.env): ProviderDescriptor {
  return {
    identity: { id: 'ollama', kind: 'local', model: env.OLLAMA_MODEL ?? 'qwen3:8b' },
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

export async function probeOllama(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<ProviderAvailability> {
  const base = (env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
  const model = env.OLLAMA_MODEL ?? 'qwen3:8b';
  try {
    const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return { state: 'unavailable', detail: `Ollama at ${base} answered HTTP ${res.status}` };
    const names = ((await res.json()) as { models?: { name?: string }[] }).models?.map((m) => m.name) ?? [];
    return names.includes(model) ? { state: 'available', detail: `${model} is installed at ${base}` } : { state: 'unavailable', detail: `Ollama is up at ${base} but model ${model} is not installed (have: ${names.slice(0, 8).join(', ') || 'none'})` };
  } catch (err) {
    return { state: 'unavailable', detail: `Ollama not reachable at ${base}: ${(err as Error).message}` };
  }
}

/** Wraps a Mastra coding agent as a provider. `providerRequest` is the contract's per-call context; the Mastra agent has no use for it and never sees it. */
export function createOllamaProvider(agent: Pick<Agent, 'stream'>, defaults: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): WorkerProvider {
  const inner: WorkerLike = asStreamingWorker(agent, defaults);
  return {
    provider: ollamaDescriptor(env),
    probe: () => probeOllama(env),
    generate: (prompt, options) => {
      const { providerRequest: _providerRequest, ...agentOptions } = options;
      return inner.generate(prompt, agentOptions);
    },
  };
}

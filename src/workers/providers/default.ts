import { workerAgentIdFor } from '../../runtime/execution/delegation.ts';
import { codingWorkerGo, codingWorkerJs } from '../coding-worker.ts';
import { codexEntry } from './codex.ts';
import { createOllamaProvider, ollamaDescriptor, probeOllama } from './ollama.ts';
import { ProviderRegistry } from './registry.ts';

/**
 * The providers this runtime ships. Local Ollama/Qwen is the default. Cloud adapters are registered so they can be surveyed
 * (probing makes no model call) but run a task only when that task explicitly names them; nothing falls back to them.
 */
export function defaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry().register(codexEntry()).register({
    id: 'ollama',
    describe: () => ollamaDescriptor(),
    probe: () => probeOllama(),
    create: ({ taskType, mastra, tracingContext }) => {
      const agentId = workerAgentIdFor(taskType);
      const fallback = agentId === 'codingWorkerJs' ? codingWorkerJs : codingWorkerGo;
      return createOllamaProvider((mastra?.getAgent(agentId) as typeof fallback | undefined) ?? fallback, tracingContext ? { tracingContext } : {});
    },
  });
}

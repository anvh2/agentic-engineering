import { workerAgentIdFor } from '../../runtime/execution/delegation.ts';
import { codingWorkerGo, codingWorkerJs } from '../coding-worker.ts';
import { createOllamaProvider, ollamaDescriptor, probeOllama } from './ollama.ts';
import { ProviderRegistry } from './registry.ts';

/** The providers this runtime ships. Local Ollama/Qwen is the default and the only one registered until another adapter is verified. */
export function defaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry().register({
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

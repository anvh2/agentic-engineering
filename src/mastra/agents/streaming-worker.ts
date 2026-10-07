import type { Agent } from '@mastra/core/agent';
import type { WorkerLike } from '../workflows/coding-task-runner.ts';

/**
 * Runs an agent through stream() and waits for the full output, exposing the same shape as generate().
 *
 * Why: a non-streaming Ollama completion sends no HTTP headers until generation finishes, so a long
 * thinking pass (>300s) trips undici's default headers timeout and surfaces as a spurious runtime
 * failure. Streaming sends headers immediately. Model, prompt, tools and loop are unchanged; this is
 * transport only. `defaults` (e.g. a workflow step's tracingContext) are merged under the runner's own options.
 */
export function asStreamingWorker(agent: Pick<Agent, 'stream'>, defaults: Record<string, unknown> = {}): WorkerLike {
  return {
    async generate(prompt, options) {
      const output = await agent.stream(prompt, { ...defaults, ...options } as never);
      const full = await output.getFullOutput();
      return {
        text: full.text,
        finishReason: full.finishReason,
        steps: full.steps as unknown[],
        usage: (full.totalUsage ?? full.usage) as { inputTokens?: number; outputTokens?: number },
      };
    },
  };
}

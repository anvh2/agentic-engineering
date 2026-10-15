/**
 * Test-only: a deterministic, offline language model for Mastra agents.
 *
 * Each script step either asks for a tool call, replies with text, or fails. Everything the model is shown (prompts, tool
 * results) is recorded so tests can assert on what actually reached the model, and the abort signal passed by the agent is
 * honoured so timeout and cancellation behave like a real provider call. No network, no provider, no cost.
 */
export type ScriptStep =
  | { toolCall: { name: string; args: Record<string, unknown> } }
  | { text: string }
  | { error: Error }
  | { waitForAbort: true };

export interface ScriptedModel {
  /** Pass as `model` to `new Agent(...)`. */
  model: any;
  /** Number of times the model was invoked (== inference calls). */
  calls: () => number;
  /** The prompt messages seen on each call. */
  prompts: () => unknown[][];
  /** All text the model has been shown, flattened (user text and tool results). */
  seenText: () => string;
}

export function scriptedModel(script: readonly ScriptStep[] | ((call: number) => ScriptStep)): ScriptedModel {
  const prompts: unknown[][] = [];
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  const stepFor = (call: number): ScriptStep => (typeof script === 'function' ? script(call) : script[Math.min(call, script.length - 1)]!);
  const model = {
    specificationVersion: 'v2',
    provider: 'scripted',
    modelId: 'scripted-1',
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown[]; abortSignal?: AbortSignal }) {
      const call = prompts.length;
      prompts.push(options.prompt);
      const step = stepFor(call);
      if ('error' in step) throw step.error;
      if ('waitForAbort' in step) {
        await new Promise<void>((_, reject) => {
          if (options.abortSignal?.aborted) return reject(new Error('aborted'));
          options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      if ('toolCall' in step) {
        return { content: [{ type: 'tool-call', toolCallId: `call-${call}`, toolName: step.toolCall.name, input: JSON.stringify(step.toolCall.args) }], finishReason: 'tool-calls', usage, warnings: [] };
      }
      return { content: [{ type: 'text', text: (step as { text: string }).text }], finishReason: 'stop', usage, warnings: [] };
    },
    async doStream() { throw new Error('streaming is not scripted'); },
  };
  return {
    model,
    calls: () => prompts.length,
    prompts: () => prompts,
    seenText: () => JSON.stringify(prompts),
  };
}

export const report = (over: Record<string, unknown> = {}): string => JSON.stringify({
  summary: 'Inspected the repository.', status: 'no-issues', findings: [], unknowns: [], ...over,
});

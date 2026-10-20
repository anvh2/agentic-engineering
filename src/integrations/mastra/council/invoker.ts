import { RequestContext } from '@mastra/core/request-context';
import { COUNCIL_LIMITS } from '../../../runtime/council/contract.ts';
import type { SpecialistCall, SpecialistInvoker, SpecialistResult } from '../../../runtime/council/participant.ts';
import { REPOSITORY_ROOT_CONTEXT_KEY } from '../../../workers/tools/repository-tools.ts';

/** The slice of a Mastra Agent the council uses, so a test can hand in a scripted one. */
export interface CouncilAgentLike {
  /** The Mastra agent id (`specialist-<id>` live, `council-scripted-<id>` offline); recorded so a record names the agent that answered. */
  id?: string;
  generate(prompt: string, options: Record<string, unknown>): Promise<{ text?: string; steps?: readonly unknown[]; toolCalls?: readonly unknown[]; toolResults?: readonly unknown[]; usage?: Record<string, unknown>; totalUsage?: Record<string, unknown>; traceId?: string; runId?: string }>;
}

export interface MastraInvokerOptions {
  /** Looks up the Mastra agent for a specialist id: the registered `specialist_*` agent live, a scripted one offline. */
  resolveAgent: (specialistId: string) => CouncilAgentLike;
  /** Absolute repository root the read-only tools may read. Chosen by the runtime from a checked path, never by a model. */
  repositoryRoot: string;
  workflowRunId: string;
  /** The enclosing workflow step's tracing context, so agent and tool spans nest under the workflow run in Studio. */
  tracingContext?: unknown;
  maxSteps?: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function toolCounts(result: Awaited<ReturnType<CouncilAgentLike['generate']>>): { tool: string; count: number }[] {
  const counts = new Map<string, number>();
  const add = (item: unknown) => {
    const rec = item as { toolName?: unknown; payload?: { toolName?: unknown } } | undefined;
    const name = rec?.toolName ?? rec?.payload?.toolName;
    if (typeof name === 'string') counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const steps = (result.steps ?? []) as readonly { toolCalls?: readonly unknown[] }[];
  if (steps.length) steps.forEach((s) => (s.toolCalls ?? []).forEach(add));
  else (result.toolCalls ?? result.toolResults ?? []).forEach(add);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tool, count]) => ({ tool, count }));
}

/**
 * One bounded, read-only specialist call through a registered Mastra agent. The repository root travels in RequestContext;
 * the agent's tools are the runtime-owned read-only table (see specialist-agents.ts), so a prompt cannot widen them. The call
 * is aborted by the caller's signal, and an abort is never a reply: Mastra can return normally with partial text after one.
 */
export function createMastraInvoker(options: MastraInvokerOptions): SpecialistInvoker {
  return {
    async invoke(call: SpecialistCall): Promise<SpecialistResult> {
      const agent = options.resolveAgent(call.seat.specialistId);
      const requestContext = new RequestContext();
      requestContext.set(REPOSITORY_ROOT_CONTEXT_KEY, options.repositoryRoot);
      requestContext.set('specialist-id', call.seat.specialistId);
      requestContext.set('council-meeting-id', call.meetingId);
      requestContext.set('workflow-run-id', options.workflowRunId);
      const started = Date.now();
      const result = await agent.generate(call.prompt, {
        instructions: call.instructions,
        requestContext,
        maxSteps: options.maxSteps ?? COUNCIL_LIMITS.maxSteps,
        abortSignal: call.signal,
        tracingContext: options.tracingContext,
        tracingOptions: {
          metadata: { councilMeetingId: call.meetingId, specialistId: call.seat.specialistId, manifestVersion: call.seat.manifestVersion, phase: call.phase, round: call.round, turn: call.turn, attempt: call.attempt, workflowRunId: options.workflowRunId },
          tags: ['council', call.seat.specialistId, call.phase],
        },
      });
      if (call.signal.aborted) throw new Error(`${call.seat.specialistId}: the call was aborted before a complete reply`);
      const usage = result.totalUsage ?? result.usage ?? {};
      return {
        text: result.text ?? '',
        steps: result.steps?.length ?? null,
        toolCalls: toolCounts(result),
        inputTokens: num(usage.inputTokens ?? usage.promptTokens),
        outputTokens: num(usage.outputTokens ?? usage.completionTokens),
        agentId: typeof agent.id === 'string' ? agent.id : null,
        runId: result.runId ?? `${options.workflowRunId}:${call.seat.specialistId}:r${call.round}a${call.attempt}`,
        traceId: result.traceId ?? null,
        inferenceMs: Date.now() - started,
      };
    },
  };
}

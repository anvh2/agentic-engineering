import type { TraceEvent } from './coding-task-trace.ts';

/**
 * Coarse operational phase of a delegated task, derived ONLY from the runner's trace events (never from model
 * prose or chain-of-thought). This is what the Mastra workflow publishes for Studio.
 */
export type CodingPhase =
  | 'preparing'
  | 'worker_running'
  | 'verifying'
  | 'retrying'
  | 'passed'
  | 'failed'
  | 'escalated'
  | 'runtime_failed'
  | 'kept_by_claude';

export interface PhaseUpdate {
  phase: CodingPhase;
  attempt?: number;
  detail?: string;
}

export function phaseOf(event: TraceEvent): PhaseUpdate | undefined {
  const d = event.data;
  switch (event.type) {
    case 'attempt_started':
      return { phase: 'worker_running', attempt: Number(d.attempt), detail: `coding attempt ${d.attempt}/${d.maxAttempts}` };
    case 'model_started':
      return { phase: 'worker_running', attempt: Number(d.attempt), detail: Number(d.runtimeTry) > 0 ? 'model runtime retry' : 'model call' };
    case 'verification_started':
      return { phase: 'verifying', detail: String((d.command as string[]).join(' ')) };
    case 'runtime_retry':
      return { phase: 'retrying', attempt: Number(d.attempt), detail: 'runtime retry (does not consume a coding attempt)' };
    case 'coding_retry':
      return { phase: 'retrying', attempt: Number(d.toAttempt), detail: `coding retry: fresh-context attempt ${d.toAttempt}` };
    case 'task_passed':
      return { phase: 'passed', detail: `PASS after ${d.attempts} coding attempt(s)` };
    case 'task_failed':
      return { phase: 'failed', detail: `FAIL (${d.category}) after ${d.attempts} coding attempt(s)` };
    default:
      return undefined;
  }
}

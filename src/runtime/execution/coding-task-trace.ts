import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Structured event trace for a coding-task run. Events are observability
 * only: nothing here is evidence of correctness. In particular `worker_status`
 * carries the model's short visible message (never hidden chain-of-thought)
 * and is diagnostic.
 *
 * Model-runtime retries (`runtime_retry`) and coding/verification retries
 * (`coding_retry`) are distinct event types so they can never be conflated.
 */
export type TraceEventType =
  | 'task_started'
  | 'attempt_started'
  | 'model_started'
  | 'model_finished'
  | 'provider_unresponsive'
  | 'provider_settled_late'
  | 'worker_status'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'file_read'
  | 'file_write'
  | 'file_hash'
  | 'verification_started'
  | 'verification_finished'
  | 'attempt_failed'
  | 'runtime_retry'
  | 'coding_retry'
  | 'task_passed'
  | 'task_failed';

export interface TraceEvent {
  seq: number;
  ts: string;
  type: TraceEventType;
  data: Record<string, unknown>;
}

export interface TraceSink {
  emit(type: TraceEventType, data?: Record<string, unknown>): void;
  readonly events: TraceEvent[];
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL)/i;
const SECRET_PATTERNS: RegExp[] = [/sk-[A-Za-z0-9_-]{10,}/g, /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g];

/** Replaces values of secret-looking environment variables and well-known token shapes. Never persists the environment itself. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_NAME.test(name)) out = out.split(value).join('[REDACTED]');
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

export function createTraceSink(options: { jsonlPath?: string; print?: (line: string) => void; onEvent?: (event: TraceEvent) => void } = {}): TraceSink {
  const events: TraceEvent[] = [];
  let dirReady = false;
  return {
    events,
    emit(type, data = {}) {
      const event: TraceEvent = { seq: events.length + 1, ts: new Date().toISOString(), type, data };
      events.push(event);
      if (options.jsonlPath) {
        if (!dirReady) {
          mkdirSync(dirname(options.jsonlPath), { recursive: true });
          dirReady = true;
        }
        appendFileSync(options.jsonlPath, `${redact(JSON.stringify(event))}\n`);
      }
      try {
        options.onEvent?.(event);
      } catch {
        // observability must never break a run
      }
      const line = options.print ? formatEvent(event) : undefined;
      if (line) options.print!(redact(line));
    },
  };
}

function clip(value: unknown, max = 160): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One concise human-readable line per event (undefined = not printed). */
export function formatEvent(e: TraceEvent): string | undefined {
  const d = e.data;
  switch (e.type) {
    case 'task_started':
      return `[TASK] ${d.taskId}: ${clip(d.objective, 140)}`;
    case 'attempt_started':
      return `[ATTEMPT ${d.attempt}/${d.maxAttempts}]`;
    case 'model_started':
      return `[MODEL] ${d.model} started${Number(d.runtimeTry) > 0 ? ` (runtime retry ${d.runtimeTry})` : ''}`;
    case 'model_finished':
      return d.error
        ? `[MODEL] failed: ${clip(d.error, 120)}`
        : `[MODEL] finished (${d.finishReason}, ${d.durationMs}ms, ${d.steps} step(s), ${d.outputTokens ?? '?'} out tokens)`;
    case 'worker_status':
      return `[STATUS] ${clip(d.text, 140)}`;
    case 'tool_call_finished':
      return `[TOOL] ${d.name}${d.path ? ` ${d.path}` : ''}${d.ok === false ? ' ✗ FAILED' : ''}`;
    case 'file_hash':
      return `[FILE] ${d.path} ${String(d.before).slice(0, 8)} -> ${String(d.after).slice(0, 8)}`;
    case 'verification_finished':
      return `[VERIFY] ${(d.command as string[]).join(' ')} ${d.exitCode === 0 ? 'PASS' : `FAIL (exit ${d.exitCode}${d.timedOut ? ', timed out' : ''})`}`;
    case 'attempt_failed':
      return `[VERDICT] attempt ${d.attempt} failed: ${d.category}${d.reason ? ` - ${clip(d.reason, 100)}` : ''}`;
    case 'runtime_retry':
      return `[RUNTIME-RETRY] model runtime failed (${clip(d.reason, 100)}); retrying same coding attempt ${d.attempt} (does not consume a coding attempt)`;
    case 'coding_retry':
      return `[CODING-RETRY] verification failed; starting fresh-context coding attempt ${d.toAttempt}`;
    case 'task_passed':
      return `[RESULT] PASS after ${d.attempts} coding attempt(s)`;
    case 'task_failed':
      return `[RESULT] FAIL (${d.category}) after ${d.attempts} coding attempt(s)`;
    default:
      return undefined;
  }
}

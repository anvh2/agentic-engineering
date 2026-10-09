import { parseAllowList } from '../../src/runtime/execution/worker-provider.ts';
import { GEMINI_MOVING_MODELS } from '../../src/workers/providers/gemini.ts';

/**
 * The gates in front of the ONE real Codex-through-Mastra-HTTP smoke. It is disabled unless the operator opts in, it accepts
 * no task input (the single objective is the disposable fixture in scheduler-smoke.ts), and it needs the operator's provider
 * allow-list, which the harness then hands, narrowed to this one task, to BOTH the scheduler and the Mastra server.
 */

export const HTTP_SMOKE_OPT_IN_ENV = 'AGENTIC_REAL_PROVIDER_SMOKE';
export const HTTP_SMOKE_OPT_IN_VALUE = 'codex-http';
export const GEMINI_HTTP_SMOKE_OPT_IN_VALUE = 'gemini-http';
export const HTTP_SMOKE_TASK_ID = 'smoke-double';

/** The cloud provider a smoke runs. Each has its OWN opt-in value, so enabling one never enables the other. */
export type SmokeProvider = 'codex' | 'gemini';
const OPT_IN: Record<SmokeProvider, string> = { codex: HTTP_SMOKE_OPT_IN_VALUE, gemini: GEMINI_HTTP_SMOKE_OPT_IN_VALUE };
const LABEL: Record<SmokeProvider, string> = { codex: 'Codex', gemini: 'Gemini' };
const QUOTA: Record<SmokeProvider, string> = { codex: "the operator's Codex quota", gemini: "the operator's Gemini quota or API budget" };

/** The hard bounds of the real run. Each is enforced by code, not by this document: see the notes on where. */
export const HTTP_SMOKE_LIMITS = {
  objectives: 1, //                      one disposable fixture task, nothing else is accepted
  maxClaims: 1, //                       scheduler: the task is claimed once, never requeued for a second paid call
  maxProviderInvocations: 1, //          smoke server: a second `codex exec` is refused before it starts (limitInvocations)
  automaticRuntimeRetries: 0, //         Codex descriptor limits.maxRuntimeRetries
  perCallTimeoutMs: 300_000, //          process group is terminated at this deadline
  taskActiveTimeoutMs: 420_000, //       scheduler: active-execution budget, then the run is cancelled and confirmed
  cancelConfirmationMs: 45_000, //       after SIGINT/SIGTERM
} as const;

/** Gemini smoke budget ceilings, enforced by the CLI (turn limit) and by the API (per-request output tokens). */
export const GEMINI_SMOKE_BUDGET = { maxTurns: 8, maxOutputTokens: 16_384 } as const;

/** The Gemini smoke needs an exact model id: an alias, or a name the CLI may replace with a newer model, has no knowable price. */
export function checkGeminiSmokeModel(model: string | undefined): { ok: true; model: string } | { ok: false; reason: string } {
  if (!model) return { ok: false, reason: 'AGENTIC_GEMINI_MODEL is required: name one exact model id (for example gemini-3.8-flash). The CLI default routes between models and cannot be priced.' };
  if ((GEMINI_MOVING_MODELS as readonly string[]).includes(model)) return { ok: false, reason: `AGENTIC_GEMINI_MODEL=${model} is an alias or a name the CLI silently replaces with a newer model (flash and gemini-3.5-flash both became gemini-3.8-flash with an API key). Name the exact id instead, e.g. gemini-3.8-flash.` };
  return { ok: true, model };
}

export type HttpSmokeAuthorization = { ok: true; allowProviders: string[] } | { ok: false; reason: string };

export function checkHttpSmokeAuthorization(env: NodeJS.ProcessEnv, argv: readonly string[] = [], provider: SmokeProvider = 'codex'): HttpSmokeAuthorization {
  if (env[HTTP_SMOKE_OPT_IN_ENV] !== OPT_IN[provider]) {
    return { ok: false, reason: `the real ${LABEL[provider]} HTTP smoke is disabled by default; it calls a cloud model and spends ${QUOTA[provider]}. Opt in with ${HTTP_SMOKE_OPT_IN_ENV}=${OPT_IN[provider]}` };
  }
  if (argv.length > 0) {
    return { ok: false, reason: `this smoke takes no arguments (${argv.join(' ')}): it runs one fixed disposable objective and cannot be pointed at a server, a repository or a task` };
  }
  const allow = parseAllowList(env.AGENTIC_ALLOW_PROVIDERS);
  if (!allow.includes(provider) && !allow.includes(`${provider}:${HTTP_SMOKE_TASK_ID}`)) {
    return { ok: false, reason: `no operator authorization for the cloud provider: set AGENTIC_ALLOW_PROVIDERS=${provider}:${HTTP_SMOKE_TASK_ID} (entries seen: ${allow.join(', ') || 'none'})` };
  }
  // Whatever the operator allowed, only this provider and only this task get it, in the scheduler AND in the server.
  return { ok: true, allowProviders: [`${provider}:${HTTP_SMOKE_TASK_ID}`] };
}

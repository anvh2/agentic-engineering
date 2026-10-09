import { parseAllowList } from '../../src/runtime/execution/worker-provider.ts';

/**
 * The gates in front of the ONE real Codex-through-Mastra-HTTP smoke. It is disabled unless the operator opts in, it accepts
 * no task input (the single objective is the disposable fixture in scheduler-smoke.ts), and it needs the operator's provider
 * allow-list, which the harness then hands, narrowed to this one task, to BOTH the scheduler and the Mastra server.
 */

export const HTTP_SMOKE_OPT_IN_ENV = 'AGENTIC_REAL_PROVIDER_SMOKE';
export const HTTP_SMOKE_OPT_IN_VALUE = 'codex-http';
export const HTTP_SMOKE_TASK_ID = 'smoke-double';

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

export type HttpSmokeAuthorization = { ok: true; allowProviders: string[] } | { ok: false; reason: string };

export function checkHttpSmokeAuthorization(env: NodeJS.ProcessEnv, argv: readonly string[] = []): HttpSmokeAuthorization {
  if (env[HTTP_SMOKE_OPT_IN_ENV] !== HTTP_SMOKE_OPT_IN_VALUE) {
    return { ok: false, reason: `the real Codex HTTP smoke is disabled by default; it calls a cloud model and spends the operator's Codex quota. Opt in with ${HTTP_SMOKE_OPT_IN_ENV}=${HTTP_SMOKE_OPT_IN_VALUE}` };
  }
  if (argv.length > 0) {
    return { ok: false, reason: `this smoke takes no arguments (${argv.join(' ')}): it runs one fixed disposable objective and cannot be pointed at a server, a repository or a task` };
  }
  const allow = parseAllowList(env.AGENTIC_ALLOW_PROVIDERS);
  if (!allow.includes('codex') && !allow.includes(`codex:${HTTP_SMOKE_TASK_ID}`)) {
    return { ok: false, reason: `no operator authorization for the cloud provider: set AGENTIC_ALLOW_PROVIDERS=codex:${HTTP_SMOKE_TASK_ID} (entries seen: ${allow.join(', ') || 'none'})` };
  }
  // Whatever the operator allowed, only this task gets it, in the scheduler AND in the server.
  return { ok: true, allowProviders: [`codex:${HTTP_SMOKE_TASK_ID}`] };
}

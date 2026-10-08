/**
 * WorkerProvider: what the runtime needs to know about a coding worker, whoever runs it (a local model behind Mastra, or a
 * cloud coding CLI). It is deliberately a thin extension of the existing `WorkerLike` seam in coding-task-runner.ts, not a
 * new execution path: the same runner still owns the attempts, the filesystem mutation policy, formatting and verification,
 * and PASS can only come from the runtime verifier.
 *
 *   provider           proposes. It edits the isolated worktree it is given and reports what it did and what it consumed.
 *   runner (runtime)   decides. File scope is judged from the filesystem after the provider returns (forbidden changes
 *                      fail the task and restore the tree), whatever the provider claims or enforces itself.
 *   scheduler/review   unchanged: a runtime PASS creates a review request, never a completed task.
 *
 * Measured values are never invented: anything a provider cannot report is the literal 'UNKNOWN', not 0 and not absent,
 * so a cost or quota comparison cannot silently treat "not reported" as "free".
 */

export const UNKNOWN = 'UNKNOWN' as const;
export type Measured<T> = T | typeof UNKNOWN;

export type TaskType = 'go' | 'js';

export interface ProviderIdentity {
  /** Stable registry id: 'ollama' | 'codex' | 'gemini'. */
  id: string;
  kind: 'local' | 'cloud';
  /** Model as configured for this run (or 'UNKNOWN' when the CLI picks its own default and does not say). */
  model: string;
  /** Installed CLI version when there is a CLI. */
  cliVersion?: string;
}

export interface ProviderCapabilities {
  /** Task types the provider is cleared to run. */
  taskTypes: readonly TaskType[];
  /** How file edits happen: through the runtime's scoped tools, or by the provider editing the worktree itself. */
  editsFiles: 'via-runtime-tools' | 'directly';
  /**
   * How the allowed-file scope is enforced BEFORE the runtime's own check. The runtime's post-hoc filesystem comparison
   * always applies on top; 'runtime-verified-only' means the provider could write anywhere in the worktree and the runner
   * catches it afterwards (never acceptable together with network or credentials access).
   */
  fileScope: 'tool-enforced' | 'os-sandbox' | 'runtime-verified-only';
  /** What stops a running call: an AbortSignal handed to an in-process client, or termination of a child process group. */
  cancellation: 'abort-signal' | 'process-group';
  /** What the provider can report about its consumption. */
  usage: 'tokens' | 'tokens-and-cost' | 'none';
  billing: 'local-free' | 'metered' | 'subscription-quota' | 'unknown';
}

/** Which machine-wide concurrency limit the provider's calls queue on (src/runtime/capacity). */
export interface ProviderCapacity {
  resource: string;
  /** Used only when the capacity database has no permit count for the resource yet. */
  defaultPermits: number;
}

export interface ProviderDescriptor {
  identity: ProviderIdentity;
  capabilities: ProviderCapabilities;
  capacity: ProviderCapacity;
  /**
   * Retry ceilings for a provider whose every call costs money or quota. The runner applies the smaller of these and its own
   * settings; they can only lower a budget, never raise it. Absent: the runner's defaults (free local model).
   */
  limits?: { maxRuntimeRetries: number; maxCodingAttempts: number };
}

/** Installation/auth state. Never carries credentials, tokens or account identifiers. */
export interface ProviderAvailability {
  state: 'available' | 'not_installed' | 'not_authenticated' | 'unsupported_version' | 'unavailable';
  detail: string;
  version?: string;
}

/** What the runner hands a provider besides the prompt. */
export interface ProviderRequest {
  /** The isolated git worktree. A provider must not touch anything outside it. */
  workdir: string;
  allowedFiles: readonly string[];
  contextFiles: readonly string[];
  taskType: TaskType;
  /** Hard wall-clock cap for this call; the call's AbortSignal fires at this deadline too. */
  timeoutMs: number;
}

export interface ProviderUsage {
  inputTokens: Measured<number>;
  outputTokens: Measured<number>;
  costUsd: Measured<number>;
  /** Quota/credits consumed or remaining, as the provider words it. */
  quota: Measured<string>;
}

/** Per-call measurement recorded on every attempt. Always complete; unreported values are 'UNKNOWN'. */
export interface ProviderTelemetry {
  provider: string;
  model: string;
  inferenceMs: number;
  usage: ProviderUsage;
}

export interface RawUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  quota?: string;
}

/** Fills every unreported field with 'UNKNOWN'; a local-free provider's cost is known to be 0. */
export function normalizeUsage(raw: RawUsage | undefined, billing?: ProviderCapabilities['billing']): ProviderUsage {
  const num = (v: unknown): Measured<number> => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : UNKNOWN);
  return {
    inputTokens: num(raw?.inputTokens),
    outputTokens: num(raw?.outputTokens),
    costUsd: raw?.costUsd !== undefined ? num(raw.costUsd) : billing === 'local-free' ? 0 : UNKNOWN,
    quota: typeof raw?.quota === 'string' && raw.quota ? raw.quota : UNKNOWN,
  };
}

// ---- selection and authorization ---------------------------------------------------------------------------------

/** The provider a task runs on unless it names another: the free local model. */
export const DEFAULT_PROVIDER_ID = 'ollama';

/** Environment variable holding the OPERATOR's allow-list for non-default providers. */
export const ALLOW_PROVIDERS_ENV = 'AGENTIC_ALLOW_PROVIDERS';

export const providerOf = (request: { provider?: string } | undefined): string => request?.provider ?? DEFAULT_PROVIDER_ID;

/**
 * Entries are `<provider>` (any task) or `<provider>:<taskId>` (that one task only). The default provider needs no entry.
 * The list comes from the operator's environment or command line, never from a task, a plan or a Lead: a task can only
 * REQUEST a provider, so no plan, however it was written, can start cloud execution by itself.
 */
export function parseAllowList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((e) => e.trim()).filter(Boolean);
}

export function allowedProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseAllowList(env[ALLOW_PROVIDERS_ENV]);
}

export function authorizeProvider(provider: string, taskId: string, allow: readonly string[]): { ok: true } | { ok: false; reason: string } {
  if (provider === DEFAULT_PROVIDER_ID) return { ok: true };
  if (allow.includes(provider) || allow.includes(`${provider}:${taskId}`)) return { ok: true };
  return { ok: false, reason: `provider_not_authorized: task ${taskId} asks for provider "${provider}", which the operator has not allowed (set ${ALLOW_PROVIDERS_ENV}=${provider}:${taskId} or pass --allow-provider ${provider}:${taskId}; a plan cannot authorize it)` };
}

/**
 * Deterministic worker-provider routing (M12): which provider a claimed task runs on, why, and what it may spend.
 *
 * A task only REQUESTS a provider (default: the free local model). The decision below is a pure function of that request,
 * the provider's static descriptor, the operator's allow-list and the operator's budget; no model is involved and nothing is
 * guessed. Checks run in a fixed order and the first failure refuses the task:
 *
 *   provider_known       the requested provider is registered (its descriptor exists)
 *   language_supported   the provider is cleared for the task's language (descriptor.capabilities.taskTypes)
 *   operator_authorized  the default provider, or an operator allow-list entry (worker-provider.ts)
 *   budget               a provider that is not 'local-free' (metered, subscription, or unknown billing) also needs an
 *                        operator budget entry with claims left; the claim is charged when it is selected
 *
 * There is NO fallback: a refused task is never moved to another provider, paid or free. Moving it is a new plan by the Lead.
 * Budgets are counted in claims (one scheduler dispatch of the task to the provider); a claim may make up to the provider's
 * `limits.maxCodingAttempts` calls. Like the allow-list, budgets come from the operator's environment or command line, never
 * from a task or a plan.
 */
import { authorizeProvider, DEFAULT_PROVIDER_ID, type ProviderCapabilities, type ProviderDescriptor, type TaskType } from './worker-provider.ts';

export const ROUTING_SCHEMA = 'agentic.routing/1' as const;

/** Environment variable holding the OPERATOR's budgets for providers that are not local-free. */
export const PROVIDER_BUDGETS_ENV = 'AGENTIC_PROVIDER_BUDGETS';

/** Largest budget one entry may grant, in claims. A larger spend is a series of explicit operator decisions. */
export const MAX_BUDGET_CLAIMS = 20;

/** `codex=2` (all tasks on codex share 2 claims) or `codex:<taskId>=1` (that task alone). */
export interface ProviderBudgetEntry {
  provider: string;
  taskId?: string;
  claims: number;
}

export class ProviderBudgetError extends Error {
  readonly code = 'invalid_provider_budget';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderBudgetError';
  }
}

const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const TASK_ID = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * Parses `<provider>[:<taskId>]=<claims>` entries separated by commas. Malformed, duplicate or oversized entries throw: an
 * operator's budget is never half-applied or silently widened. An empty value is no budget at all.
 */
export function parseProviderBudgets(raw: string | undefined): ProviderBudgetEntry[] {
  if (!raw?.trim()) return [];
  const entries: ProviderBudgetEntry[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const entry = part.trim();
    const match = /^([^:=\s]+)(?::([^=\s]+))?=(\d{1,6})$/.exec(entry);
    if (!match) throw new ProviderBudgetError(`budget entry ${JSON.stringify(entry)} must be <provider>=<claims> or <provider>:<taskId>=<claims>`);
    const [, provider, taskId, digits] = match;
    if (!PROVIDER_ID.test(provider)) throw new ProviderBudgetError(`budget entry ${JSON.stringify(entry)}: provider "${provider}" is not a provider id`);
    if (taskId !== undefined && !TASK_ID.test(taskId)) throw new ProviderBudgetError(`budget entry ${JSON.stringify(entry)}: "${taskId}" is not a task id`);
    const claims = Number(digits);
    if (claims > MAX_BUDGET_CLAIMS) throw new ProviderBudgetError(`budget entry ${JSON.stringify(entry)} exceeds ${MAX_BUDGET_CLAIMS} claims`);
    const key = `${provider}:${taskId ?? ''}`;
    if (seen.has(key)) throw new ProviderBudgetError(`budget for ${taskId ? `${provider}:${taskId}` : provider} is given twice`);
    seen.add(key);
    entries.push({ provider, ...(taskId !== undefined ? { taskId } : {}), claims });
  }
  return entries;
}

export function providerBudgetsFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderBudgetEntry[] {
  return parseProviderBudgets(env[PROVIDER_BUDGETS_ENV]);
}

export type RoutingCode =
  | 'local_default'
  | 'local_authorized'
  | 'authorized_within_budget'
  | 'unknown_provider'
  | 'language_unsupported'
  | 'provider_not_authorized'
  | 'budget_not_approved'
  | 'budget_exhausted';

export interface RoutingCheck {
  check: 'provider_known' | 'language_supported' | 'operator_authorized' | 'budget';
  ok: boolean;
  detail: string;
}

export interface BudgetUse {
  scope: 'task' | 'provider';
  limit: number;
  /** Claims already charged in this scope before this decision. */
  spentBefore: number;
}

export interface RoutingDecision {
  schema: typeof ROUTING_SCHEMA;
  taskId: string;
  requested: string;
  outcome: 'selected' | 'refused';
  /** On 'selected' the provider the task runs on; always the requested one, since there is no fallback. */
  provider: string;
  model: string;
  code: RoutingCode;
  reason: string;
  language: TaskType | null;
  billing: ProviderCapabilities['billing'];
  /** True when this decision spent one claim of an operator budget. */
  charged: boolean;
  budget: BudgetUse[];
  checks: RoutingCheck[];
  fallback: 'none';
}

export interface RoutingInput {
  taskId: string;
  /** The language of the task's allowed files; undefined when the task carries none (the delegation gate judges it). */
  language: TaskType | undefined;
  requested?: string;
  /** Static descriptor of the requested provider; undefined if it is not registered. */
  descriptor: ProviderDescriptor | undefined;
  allow: readonly string[];
  budgets: readonly ProviderBudgetEntry[];
  /** Claims already charged to the requested provider: across all tasks, and to this task alone. */
  spent: { provider: number; task: number };
}

/** The deterministic decision. Pure: the caller makes it atomic with the spend it records (see Scheduler). */
export function decideRoute(input: RoutingInput): RoutingDecision {
  const requested = input.requested ?? DEFAULT_PROVIDER_ID;
  const checks: RoutingCheck[] = [];
  const d = input.descriptor;
  const base = {
    schema: ROUTING_SCHEMA,
    taskId: input.taskId,
    requested,
    provider: requested,
    model: d?.identity.model ?? 'UNKNOWN',
    language: input.language ?? null,
    billing: d?.capabilities.billing ?? 'unknown',
    budget: [] as BudgetUse[],
    checks,
    fallback: 'none' as const,
  };
  const refuse = (code: RoutingCode, reason: string): RoutingDecision => ({ ...base, outcome: 'refused', code, reason: `${code}: ${reason}; no fallback provider is tried`, charged: false });

  if (!d) {
    checks.push({ check: 'provider_known', ok: false, detail: `provider "${requested}" is not registered` });
    return refuse('unknown_provider', `task ${input.taskId} requests provider "${requested}", which is not registered`);
  }
  checks.push({ check: 'provider_known', ok: true, detail: `${d.identity.kind} provider ${requested}, model ${d.identity.model}` });

  if (input.language === undefined) {
    checks.push({ check: 'language_supported', ok: true, detail: 'the task names no language here; the delegation gate judges its files' });
  } else if (!d.capabilities.taskTypes.includes(input.language)) {
    checks.push({ check: 'language_supported', ok: false, detail: `${requested} is cleared for ${d.capabilities.taskTypes.join(', ') || 'nothing'}` });
    return refuse('language_unsupported', `provider "${requested}" is not cleared for ${input.language} tasks (cleared: ${d.capabilities.taskTypes.join(', ') || 'none'})`);
  } else {
    checks.push({ check: 'language_supported', ok: true, detail: `${input.language} is in ${d.capabilities.taskTypes.join(', ')}` });
  }

  const auth = authorizeProvider(requested, input.taskId, input.allow);
  if (!auth.ok) {
    checks.push({ check: 'operator_authorized', ok: false, detail: 'no operator allow-list entry' });
    return refuse('provider_not_authorized', auth.reason.replace(/^provider_not_authorized: /, ''));
  }
  checks.push({ check: 'operator_authorized', ok: true, detail: requested === DEFAULT_PROVIDER_ID ? 'default provider' : 'operator allow-list entry' });

  if (d.capabilities.billing === 'local-free') {
    checks.push({ check: 'budget', ok: true, detail: 'local-free: nothing is spent' });
    const local = requested === DEFAULT_PROVIDER_ID;
    return { ...base, outcome: 'selected', code: local ? 'local_default' : 'local_authorized', reason: local ? `default local provider ${requested} (${d.identity.model})` : `operator-authorized local provider ${requested} (${d.identity.model})`, charged: false };
  }

  const applicable = input.budgets.filter((b) => b.provider === requested && (b.taskId === undefined || b.taskId === input.taskId));
  if (applicable.length === 0) {
    checks.push({ check: 'budget', ok: false, detail: `billing ${d.capabilities.billing}: no operator budget` });
    return refuse('budget_not_approved', `provider "${requested}" bills as ${d.capabilities.billing} and the operator has approved no budget for it (set ${PROVIDER_BUDGETS_ENV}=${requested}:${input.taskId}=1 or pass --provider-budget ${requested}:${input.taskId}=1; a plan cannot approve one)`);
  }
  const uses: BudgetUse[] = applicable.map((b) => ({ scope: b.taskId === undefined ? 'provider' : 'task', limit: b.claims, spentBefore: b.taskId === undefined ? input.spent.provider : input.spent.task }));
  const spentOut = uses.find((u) => u.spentBefore >= u.limit);
  if (spentOut) {
    checks.push({ check: 'budget', ok: false, detail: `${spentOut.scope} budget ${spentOut.spentBefore}/${spentOut.limit} claims spent` });
    return { ...refuse('budget_exhausted', `the ${spentOut.scope} budget for provider "${requested}" is spent (${spentOut.spentBefore}/${spentOut.limit} claims)`), budget: uses };
  }
  checks.push({ check: 'budget', ok: true, detail: uses.map((u) => `${u.scope} ${u.spentBefore + 1}/${u.limit}`).join(', ') });
  return { ...base, outcome: 'selected', code: 'authorized_within_budget', reason: `operator-authorized provider ${requested} within budget (${uses.map((u) => `${u.scope}: claim ${u.spentBefore + 1} of ${u.limit}`).join('; ')})`, charged: true, budget: uses };
}

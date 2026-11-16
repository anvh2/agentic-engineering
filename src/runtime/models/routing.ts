import { totalmem } from 'node:os';
import type { ModelEntry, ModelRef, ProviderConfig } from './registry.ts';
import { ModelResolutionError, type ModelResolver } from './resolver.ts';

/**
 * Per-task model routing for coding workers. The Engineering Lead plans tasks; this picks, for each task, which registered
 * model runs it, from the SAME registry the resolver uses (no second configuration system), and records why.
 *
 * Hard checks (any failure makes a model ineligible, with a reason):
 *   - the resolver accepts it for this agent and role with tool calling (registered, authorized, available, capable, credential)
 *   - a model that is not local-free must already be assigned to this agent by the operator (routing never grants a paid model)
 *   - a local Ollama model must be installed right now (live /api/tags), and fit the local memory budget
 *   - the model is cleared for the task's language, and its declared context window is large enough when one is required
 * Then eligible models are scored: benchmark evidence for the language, tier against task complexity, and footprint (latency).
 *
 * An explicitly requested model is the only candidate: if it is ineligible the task is refused, never moved to another model.
 * Nothing here contacts a model; the live probe only lists what is installed.
 */

export const MODEL_ROUTING_SCHEMA = 'agentic.model-routing/1' as const;

export interface WorkerModelRequest {
  taskId: string;
  agentId: string;
  language: 'go' | 'js' | undefined;
  complexity: 'small' | 'medium' | 'large';
  risk: 'low' | 'medium' | 'high';
  /** A model the plan names explicitly. Routing then only checks it. */
  requested?: ModelRef;
  /** Context the task needs, when the Lead estimated it. */
  contextTokens?: number;
}

export interface LiveModelInventory {
  /** Ollama models installed now with their size in bytes; null when the local server could not be listed (UNKNOWN). */
  ollama: Map<string, number> | null;
  /** Memory budget for one local model, in GB. */
  memoryBudgetGb: number;
}

export interface ModelCandidate {
  model: string;
  providerId: string;
  modelId: string;
  billing: ProviderConfig['billing'] | 'unknown';
  eligible: boolean;
  refusals: string[];
  score: number;
  factors: Record<string, string | number | null>;
}

export interface ModelRoutingDecision {
  schema: typeof MODEL_ROUTING_SCHEMA;
  taskId: string;
  agentId: string;
  outcome: 'selected' | 'refused';
  selected: ModelRef | null;
  reason: string;
  requested: ModelRef | null;
  candidates: ModelCandidate[];
  fallback: 'none';
  memoryBudgetGb: number;
  inventory: 'live' | 'unavailable';
}

const TIER_RANK = { small: 0, medium: 1, large: 2 } as const;

/** Default budget for one resident local model: AGENTIC_LOCAL_MODEL_MEMORY_GB, else 45% of physical memory. */
export function localMemoryBudgetGb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AGENTIC_LOCAL_MODEL_MEMORY_GB);
  if (env.AGENTIC_LOCAL_MODEL_MEMORY_GB && Number.isFinite(raw) && raw > 0) return raw;
  return Math.round((totalmem() / 1e9) * 0.45 * 10) / 10;
}

/** Lists installed Ollama models (name -> bytes). null when the server cannot be reached: availability is then UNKNOWN. */
export async function ollamaInventory(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<Map<string, number> | null> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    const models = ((await res.json()) as { models?: { name?: string; size?: number }[] }).models ?? [];
    return new Map(models.filter((m) => typeof m.name === 'string').map((m) => [m.name!, typeof m.size === 'number' ? m.size : 0]));
  } catch {
    return null;
  }
}

export function routeWorkerModel(request: WorkerModelRequest, resolver: ModelResolver, inventory: LiveModelInventory): ModelRoutingDecision {
  const registry = resolver.models;
  const pool = request.requested ? [registry.model(request.requested)].filter((m): m is ModelEntry => !!m) : registry.listModels().filter((m) => m.roles.includes('coding-worker'));
  const candidates: ModelCandidate[] = pool.map((m) => judge(m, request, resolver, inventory));
  const base = { schema: MODEL_ROUTING_SCHEMA, taskId: request.taskId, agentId: request.agentId, requested: request.requested ?? null, candidates, fallback: 'none' as const, memoryBudgetGb: inventory.memoryBudgetGb, inventory: inventory.ollama ? ('live' as const) : ('unavailable' as const) };
  if (request.requested && candidates.length === 0) {
    return { ...base, outcome: 'refused', selected: null, reason: `requested model ${request.requested.providerId}/${request.requested.modelId} is not registered; no other model is substituted` };
  }
  const eligible = candidates.filter((c) => c.eligible).sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));
  if (eligible.length === 0) {
    const why = candidates.map((c) => `${c.model}: ${c.refusals.join('; ')}`).join(' | ') || 'no coding-worker model is registered';
    return { ...base, outcome: 'refused', selected: null, reason: `${request.requested ? 'requested model is ineligible (no substitution)' : 'no eligible model'}: ${why}` };
  }
  const best = eligible[0];
  return {
    ...base,
    outcome: 'selected',
    selected: { providerId: best.providerId, modelId: best.modelId },
    reason: `${best.model} (score ${best.score}; ${Object.entries(best.factors).map(([k, v]) => `${k}=${v ?? 'UNKNOWN'}`).join(', ')})${eligible.length > 1 ? `; over ${eligible.slice(1).map((c) => `${c.model} (${c.score})`).join(', ')}` : ''}`,
  };
}

function judge(m: ModelEntry, request: WorkerModelRequest, resolver: ModelResolver, inventory: LiveModelInventory): ModelCandidate {
  const ref = { providerId: m.providerId, modelId: m.modelId };
  const provider = resolver.models.provider(m.providerId);
  const refusals: string[] = [];
  const factors: Record<string, string | number | null> = {};

  try {
    resolver.withAssignment(request.agentId, ref).resolve({ agentId: request.agentId, role: 'coding-worker', requires: { toolCalling: true } });
  } catch (err) {
    refusals.push(err instanceof ModelResolutionError ? `${err.code}` : (err as Error).message);
  }
  if (provider && provider.billing !== 'local-free') {
    // Routing never grants spend: a paid model runs only where the operator already assigned it to this exact agent.
    let assigned = false;
    try {
      const r = resolver.resolve({ agentId: request.agentId, role: 'coding-worker', requires: { toolCalling: true } });
      assigned = r.source === 'assignment' && r.binding.providerId === ref.providerId && r.binding.modelId === ref.modelId;
    } catch {
      assigned = false;
    }
    if (!assigned) refusals.push(`paid_not_authorized: ${provider.billing} model needs an operator assignment to ${request.agentId}`);
  }

  const routing = m.routing ?? {};
  let memoryGb: number | undefined = routing.memoryGb;
  if (m.providerId === 'ollama') {
    if (inventory.ollama === null) refusals.push('availability_unknown: the local model server could not be listed');
    else if (!inventory.ollama.has(m.modelId)) refusals.push('not_installed');
    else if (memoryGb === undefined && inventory.ollama.get(m.modelId)) memoryGb = Math.round((inventory.ollama.get(m.modelId)! / 1e9) * 1.2 * 10) / 10;
    if (memoryGb !== undefined && memoryGb > inventory.memoryBudgetGb) refusals.push(`exceeds_local_memory_budget: needs ~${memoryGb} GB, budget ${inventory.memoryBudgetGb} GB`);
  }
  factors.memoryGb = memoryGb ?? null;

  if (request.language && routing.languages && !routing.languages.includes(request.language)) refusals.push(`language_not_cleared: cleared for ${routing.languages.join(', ')}`);
  if (request.contextTokens !== undefined) {
    if (m.capabilities.contextTokens === undefined) factors.context = 'UNKNOWN';
    else if (m.capabilities.contextTokens < request.contextTokens) refusals.push(`context_too_small: ${m.capabilities.contextTokens} < ${request.contextTokens}`);
  }

  // Score: evidence first (0..60), tier fit (0..25), footprint (0..15). Missing evidence scores as unproven, never as proven.
  const evidence = request.language ? routing.evidence?.filter((e) => e.language === request.language) : undefined;
  const runs = evidence?.reduce((a, e) => a + e.runs, 0) ?? 0;
  const passRate = runs > 0 ? evidence!.reduce((a, e) => a + e.passRate * e.runs, 0) / runs : null;
  factors.evidence = passRate === null ? 'none' : `${Math.round(passRate * 100)}% over ${runs} run(s)`;
  const evidenceScore = passRate === null ? 15 : Math.round(passRate * 60 * Math.min(1, runs / 5));
  const want = request.complexity === 'small' ? 0 : request.complexity === 'medium' ? 1 : 2;
  const tier = routing.tier;
  factors.tier = tier ?? null;
  const tierScore = tier === undefined ? 10 : 25 - 10 * Math.abs(TIER_RANK[tier] - want) - (TIER_RANK[tier] < want ? 5 : 0);
  const footprintScore = memoryGb === undefined ? 5 : Math.max(0, Math.round(15 - memoryGb));
  return {
    model: `${m.providerId}/${m.modelId}`,
    providerId: m.providerId,
    modelId: m.modelId,
    billing: provider?.billing ?? 'unknown',
    eligible: refusals.length === 0,
    refusals,
    score: refusals.length === 0 ? Math.max(0, evidenceScore + tierScore + footprintScore) : 0,
    factors,
  };
}

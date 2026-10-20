import { SCRIPTED_MODEL } from '../../runtime/council/run.ts';
import { bindingOf, type ModelResolutionCode } from '../../runtime/models/index.ts';
import type { SpecialistRegistration } from '../mastra/specialist-agents.ts';
import { boundModelOf, specialistAgentId, specialistRegistryKey } from '../mastra/specialist-agents.ts';

/**
 * The agents this Mastra process actually registered, with the model each is bound to, for the Organization page.
 *
 * Read from the registration objects themselves (the same ones `new Mastra({ agents })` holds), never from a list of
 * names: an agent appears as registered only if an object exists, and its model is the resolver's binding, or UNKNOWN when it
 * has none. Specialists the model registry refused are listed with the resolver's code, split into `unavailable` (the provider
 * or model is unavailable) and `refused` (anything else: unauthorized, unknown, incapable, no credential). Nothing here calls a
 * model or a provider; availability of a registered model is not probed.
 */

export type AgentStatus = 'registered' | 'refused' | 'unavailable';
export interface AgentRow {
  registryKey: string | null;
  agentId: string;
  name: string;
  kind: 'coding-worker' | 'specialist' | 'council-scripted';
  status: AgentStatus;
  /** `provider/model` from the resolver binding; null when no binding exists (SCRIPTED agents, refused agents). */
  model: string | null;
  /** True only when the agent still runs on the exact model object it was bound to (Mastra can repoint an agent later). */
  modelPinned: boolean | null;
  reason: string | null;
  tools: string[];
}
export interface AgentRoster {
  source: 'mastra-registration';
  agents: AgentRow[];
  counts: Record<AgentStatus, number>;
  /** Why the specialist pack itself did not load, when that is the case. */
  error: string | null;
}

export interface RosterInput {
  specialists: Pick<SpecialistRegistration, 'agents' | 'registry' | 'error' | 'refused'>;
  codingWorkers?: Record<string, object & { id?: string; name?: string }>;
  /** The council's offline stand-ins: real Mastra agents on a canned model, labelled SCRIPTED. */
  councilAgents?: Record<string, object & { id?: string; name?: string }>;
}

const UNAVAILABLE: readonly ModelResolutionCode[] = ['provider_unavailable', 'model_unavailable'];
const label = (agent: object): { model: string | null; modelPinned: boolean | null } => {
  const binding = bindingOf(agent);
  if (!binding) return { model: null, modelPinned: null };
  const pinned = boundModelOf(agent);
  return { model: `${binding.providerId}/${binding.modelId}`, modelPinned: pinned ? (agent as { model?: unknown }).model === pinned : null };
};

export function agentRoster(input: RosterInput): AgentRoster {
  const rows: AgentRow[] = [];
  for (const [key, agent] of Object.entries(input.codingWorkers ?? {})) {
    rows.push({ registryKey: key, agentId: agent.id ?? key, name: agent.name ?? key, kind: 'coding-worker', status: 'registered', ...label(agent), reason: null, tools: [] });
  }
  const registry = input.specialists.registry;
  for (const manifest of registry?.agents ?? []) {
    const key = specialistRegistryKey(manifest);
    const agent = Object.hasOwn(input.specialists.agents, key) ? input.specialists.agents[key] : undefined;
    const refused = input.specialists.refused.find((r) => r.id === manifest.id);
    const base = { registryKey: key, agentId: specialistAgentId(manifest), name: manifest.name, kind: 'specialist' as const, tools: [...manifest.tools] };
    if (agent) rows.push({ ...base, status: 'registered', ...label(agent), reason: null });
    else rows.push({
      ...base, registryKey: null, model: null, modelPinned: null,
      status: refused && UNAVAILABLE.includes(refused.code as ModelResolutionCode) ? 'unavailable' : 'refused',
      reason: refused ? `${refused.code}: ${refused.reason}` : 'not registered (no reason recorded)',
    });
  }
  for (const [key, agent] of Object.entries(input.councilAgents ?? {})) {
    rows.push({ registryKey: key, agentId: agent.id ?? key, name: agent.name ?? key, kind: 'council-scripted', status: 'registered', model: `${SCRIPTED_MODEL.provider}/${SCRIPTED_MODEL.model}`, modelPinned: null, reason: 'SCRIPTED: canned replies for offline council runs, never a model', tools: [] });
  }
  const counts = { registered: 0, refused: 0, unavailable: 0 };
  for (const r of rows) counts[r.status] += 1;
  return { source: 'mastra-registration', agents: rows, counts, error: input.specialists.error ?? null };
}

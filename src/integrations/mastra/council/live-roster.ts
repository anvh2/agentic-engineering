import { bindingOf, OLLAMA_PROVIDER_ID, ollamaSettings } from '../../../runtime/models/index.ts';
import type { PackRegistry } from '../../../runtime/knowledge/packs/loader.ts';
import { specialistAgentId, specialistRegistryKey } from '../specialist-agents.ts';
import type { CouncilAgentLike } from './invoker.ts';

/** Looks an agent up by its Mastra registry key; undefined when the instance does not hold it. Never constructs one. */
export type AgentLookup = (key: string) => unknown;

export type LiveRoster = { ok: true; agents: ReadonlyMap<string, CouncilAgentLike> } | { ok: false; reasons: readonly string[] };

/**
 * The LIVE council runs only on the specialists the Mastra instance registered, and only on the local default model.
 *
 * Registration is the authority: a specialist the model registry refused is absent from the instance and is a refusal here,
 * never rebuilt. Each seat's agent must carry the model binding the resolver gave it, and that binding must be the local
 * Ollama default the council records and probes; an agent assigned any other model (a paid one included) is refused, so
 * a council can neither spend nor misreport the model that answered. Checked before the meeting opens: zero calls, no state.
 */
export function resolveLiveRoster(lookup: AgentLookup, registry: PackRegistry, seatIds: readonly string[], env: NodeJS.ProcessEnv = process.env): LiveRoster {
  const expectedModel = ollamaSettings(env).modelId;
  const reasons: string[] = [];
  const agents = new Map<string, CouncilAgentLike>();
  for (const id of seatIds) {
    const manifest = registry.agentById.get(id);
    if (!manifest) { reasons.push(`unknown_specialist: ${id} is not in the engineering pack`); continue; }
    let agent: unknown;
    try { agent = lookup(specialistRegistryKey(manifest)); } catch { agent = undefined; }
    if (!agent || typeof (agent as CouncilAgentLike).generate !== 'function') { reasons.push(`not_registered_in_mastra: ${id} (a specialist the model registry refused is never rebuilt)`); continue; }
    const binding = bindingOf(agent as object);
    if (!binding) { reasons.push(`model_binding_missing: ${id} was registered without a resolved model binding`); continue; }
    if (binding.agentId !== specialistAgentId(manifest) || binding.role !== 'specialist') { reasons.push(`model_binding_mismatch: ${id} is bound as ${binding.agentId}/${binding.role}`); continue; }
    if (binding.providerId !== OLLAMA_PROVIDER_ID || binding.modelId !== expectedModel) {
      reasons.push(`model_binding_refused: ${id} is bound to ${binding.providerId}/${binding.modelId}; the LIVE council runs only on the local default ${OLLAMA_PROVIDER_ID}/${expectedModel}`);
      continue;
    }
    agents.set(id, agent as CouncilAgentLike);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, agents };
}

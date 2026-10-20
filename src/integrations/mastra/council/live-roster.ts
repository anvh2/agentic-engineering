import { bindingOf, OLLAMA_PROVIDER_ID, ollamaSettings } from '../../../runtime/models/index.ts';
import type { PackRegistry } from '../../../runtime/knowledge/packs/loader.ts';
import { boundModelOf, specialistAgentId, specialistRegistryKey } from '../specialist-agents.ts';
import type { CouncilAgentLike } from './invoker.ts';

/** Looks an agent up by its Mastra registry key; undefined when the instance does not hold it. Never constructs one. */
export type AgentLookup = (key: string) => unknown;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const isLoopback = (url: string): boolean => { try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; } };

export type LiveRoster = { ok: true; agents: ReadonlyMap<string, CouncilAgentLike> } | { ok: false; reasons: readonly string[] };

/**
 * The LIVE council runs only on the specialists the Mastra instance registered, and only on the local default model.
 *
 * Registration is the authority: a specialist the model registry refused is absent from the instance and is a refusal here,
 * never rebuilt. Each seat's agent must carry the model binding the resolver gave it, and that binding must be the local
 * Ollama default the council records and probes; an agent assigned any other model (a paid one included) is refused, so
 * a council can neither spend nor misreport the model that answered. The binding is a record made at construction, so the
 * agent's current model must still be the very object the resolver produced (Mastra can repoint an agent afterwards), and
 * that model's endpoint must be a loopback address: "local" is checked, not inferred from a provider id. A resumed meeting
 * passes the model it was opened with, so its remaining turns cannot be answered by another one. Checked before the
 * meeting opens or resumes: zero calls, no state.
 */
export function resolveLiveRoster(lookup: AgentLookup, registry: PackRegistry, seatIds: readonly string[], env: NodeJS.ProcessEnv = process.env, expectedModelId?: string): LiveRoster {
  const expectedModel = expectedModelId ?? ollamaSettings(env).modelId;
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
      reasons.push(`model_binding_refused: ${id} is bound to ${binding.providerId}/${binding.modelId}; the LIVE council runs only on ${OLLAMA_PROVIDER_ID}/${expectedModel}`);
      continue;
    }
    const pinned = boundModelOf(agent as object);
    if (!pinned || (agent as { model?: unknown }).model !== pinned) { reasons.push(`model_changed_after_binding: ${id} no longer runs on the model it was bound to (${binding.providerId}/${binding.modelId})`); continue; }
    if (pinned.providerId !== binding.providerId || pinned.modelId !== binding.modelId) { reasons.push(`model_binding_mismatch: ${id} model config ${pinned.providerId}/${pinned.modelId} differs from its binding`); continue; }
    if (!isLoopback(pinned.url)) { reasons.push(`model_not_local: ${id}'s ${OLLAMA_PROVIDER_ID} endpoint is not a loopback address; the LIVE council never calls a remote endpoint`); continue; }
    agents.set(id, agent as CouncilAgentLike);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, agents };
}

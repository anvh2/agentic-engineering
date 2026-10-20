import { probeOllama, type ProviderReadiness } from '../../../runtime/knowledge/engineering-control.ts';
import type { PackRegistry } from '../../../runtime/knowledge/packs/loader.ts';
import { DEFAULT_SEATS, resolvePanel } from '../../../runtime/council/panel.ts';
import { declaredContext, SCRIPTED_CONTEXT_TOKENS } from '../../../runtime/council/run.ts';
import { specialistRegistryKey, type SpecialistRegistration } from '../specialist-agents.ts';
import { resolveLiveRoster } from './live-roster.ts';

export const COUNCIL_READINESS_SCHEMA = 'agentic.council-readiness/1';

export interface CouncilReadiness {
  schema: typeof COUNCIL_READINESS_SCHEMA;
  pack: { loaded: boolean; error?: string; digest?: string; manifests: number };
  /** Specialist agents the Mastra instance holds, by registry key. Missing ones are named; nothing is assumed. */
  mastra: { registered: number; panelRegistered: readonly string[]; panelMissing: readonly string[] };
  panel: { ok: boolean; seats: readonly { specialistId: string; chair: boolean; version: string; tools: readonly string[] }[]; reasons: readonly string[] };
  scripted: { ready: boolean; reasons: readonly string[] };
  live: { ready: boolean; reasons: readonly string[]; model: string; declaredContextTokens: number | null; probe: ProviderReadiness | 'not-run' };
  /** Always required: no specialist can adopt an ADR or act on a council's output. */
  humanApproval: 'required';
}

export interface ReadinessInput {
  specialists: Pick<SpecialistRegistration, 'agents' | 'registry' | 'error'> & Partial<Pick<SpecialistRegistration, 'refused'>>;
  env?: NodeJS.ProcessEnv;
  /** Contact a LOOPBACK Ollama to check the model is installed. Off by default: status must not depend on a network. */
  probe?: boolean;
  probeImpl?: () => Promise<ProviderReadiness>;
}

/** Every reason a council would refuse to start, as data. Both modes use the same panel gates; LIVE adds the opt-in and the model. */
export async function councilReadiness(input: ReadinessInput): Promise<CouncilReadiness> {
  const env = input.env ?? process.env;
  const registry: PackRegistry | undefined = input.specialists.registry;
  const ctx = declaredContext(env);
  const model = env.OLLAMA_MODEL ?? 'qwen3:8b';
  const wanted = DEFAULT_SEATS.map((s) => s.specialistId);

  const pack = registry ? { loaded: true, digest: registry.digest, manifests: registry.agents.length } : { loaded: false, error: input.specialists.error ?? 'engineering pack not loaded', manifests: 0 };
  const registeredKeys = new Set(Object.keys(input.specialists.agents));
  const panelRegistered = wanted.filter((id) => registeredKeys.has(specialistRegistryKey({ id } as never)));
  const panelMissing = wanted.filter((id) => !panelRegistered.includes(id));

  const scriptedPanel = registry ? resolvePanel({ registry, language: 'ts', contextTokens: SCRIPTED_CONTEXT_TOKENS }) : ({ ok: false, reasons: [`pack_unavailable: ${pack.error}`] } as const);
  const livePanel = registry ? resolvePanel({ registry, language: 'ts', contextTokens: ctx }) : scriptedPanel;

  const refusedById = new Map((input.specialists.refused ?? []).map((r) => [r.id, r]));
  const missingReason = (id: string) => { const r = refusedById.get(id); return r ? `not_registered_in_mastra: ${id} (model refused, ${r.code}: ${r.reason})` : `not_registered_in_mastra: ${id}`; };
  const scriptedReasons: string[] = [...(scriptedPanel.ok ? [] : scriptedPanel.reasons), ...panelMissing.map(missingReason)];
  // The workflow's own LIVE gate, evaluated on the registered agents: what status reports is what a run would refuse.
  const roster = registry && panelMissing.length === 0 ? resolveLiveRoster((key) => input.specialists.agents[key], registry, wanted, env) : null;
  // The same undeclared-context refusal comes back once per seat; say it once, with the fix.
  const undeclared = (r: string) => /context window is not declared/.test(r);
  const liveFromPanel = livePanel.ok ? [] : livePanel.reasons.filter((r) => !undeclared(r));
  const liveReasons: string[] = [
    ...(ctx === undefined && registry ? ['model_context_undeclared: set OLLAMA_NUM_CTX to the local model\'s context window (the council needs at least 8192 tokens); an undeclared window is refused, never guessed'] : []),
    ...liveFromPanel, ...panelMissing.map(missingReason), ...(roster && !roster.ok ? roster.reasons : []),
  ];
  if (env.AGENTIC_COUNCIL_LIVE !== '1') liveReasons.push('live_not_enabled: set AGENTIC_COUNCIL_LIVE=1 in the environment of the process that runs the council');
  let probe: ProviderReadiness | 'not-run' = 'not-run';
  if (input.probe) {
    probe = await (input.probeImpl ?? (() => probeOllama(env)))();
    if (!probe.configured) liveReasons.push(`model_not_ready: ${probe.detail} (model ${model})`);
  } else liveReasons.push(`model_not_checked: run status with --probe to check that ${model} is installed in the local Ollama`);

  return {
    schema: COUNCIL_READINESS_SCHEMA, pack,
    mastra: { registered: registeredKeys.size, panelRegistered, panelMissing },
    panel: { ok: scriptedPanel.ok, seats: scriptedPanel.ok ? scriptedPanel.seats.map((s) => ({ specialistId: s.specialistId, chair: s.chair, version: s.manifestVersion, tools: s.tools })) : [], reasons: scriptedPanel.ok ? [] : scriptedPanel.reasons },
    scripted: { ready: scriptedReasons.length === 0, reasons: scriptedReasons },
    live: { ready: liveReasons.length === 0, reasons: liveReasons, model, declaredContextTokens: ctx ?? null, probe },
    humanApproval: 'required',
  };
}

export function renderReadiness(r: CouncilReadiness): string {
  const mark = (ok: boolean) => (ok ? 'READY' : 'NOT READY');
  return [
    `Engineering council readiness (${r.schema})`,
    `- Pack: ${r.pack.loaded ? `loaded, ${r.pack.manifests} specialist manifests` : `NOT LOADED: ${r.pack.error}`}`,
    `- Mastra: ${r.mastra.registered} specialist agents registered; panel agents ${r.mastra.panelRegistered.join(', ') || 'none'}${r.mastra.panelMissing.length ? `; MISSING ${r.mastra.panelMissing.join(', ')}` : ''}`,
    `- Panel: ${r.panel.ok ? r.panel.seats.map((s) => `${s.specialistId}${s.chair ? ' (chair)' : ''} [${s.tools.join(', ')}]`).join('; ') : `REFUSED: ${r.panel.reasons.join('; ')}`}`,
    `- SCRIPTED mode (offline, no model): ${mark(r.scripted.ready)}${r.scripted.reasons.length ? ` — ${r.scripted.reasons.join('; ')}` : ''}`,
    `- LIVE mode (local Ollama ${r.live.model}, ctx ${r.live.declaredContextTokens ?? 'undeclared'}): ${mark(r.live.ready)}${r.live.reasons.length ? `\n    ${r.live.reasons.join('\n    ')}` : ''}`,
    `- Human approval: ${r.humanApproval}. Specialists are read-only and advisory; no council output is adopted automatically.`,
  ].join('\n');
}

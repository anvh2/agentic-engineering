/**
 * Panel selection: exactly three role-distinct, read-only specialists, chosen from the loaded pack by the existing capability
 * gates (`handles`, `negotiate`). A seat that cannot be filled makes the whole panel refuse with the reason; there is no silent
 * substitution of another specialist and no fan-out past three.
 */
import { hashValue } from '../knowledge/canonical.ts';
import { toolClassOf } from '../knowledge/engineering-hooks.ts';
import { handles, negotiate } from '../knowledge/packs/agents.ts';
import type { PackRegistry } from '../knowledge/packs/loader.ts';
import type { AgentManifest, TaskLanguage } from '../knowledge/packs/schema.ts';
import { ParticipantDirectory } from '../collaboration/directory.ts';
import type { ParticipantIdentity } from '../collaboration/types.ts';
import { COUNCIL_LIMITS } from './contract.ts';

export interface SeatSpec {
  specialistId: string;
  /** The chair synthesizes in round 3 and is the only seat that may record the proposed decision. Exactly one seat chairs. */
  chair?: boolean;
}

/** Default panel for a design question: design owner (chair), security, reliability. Overridable by id; never by count. */
export const DEFAULT_SEATS: readonly SeatSpec[] = Object.freeze([
  { specialistId: 'architect', chair: true },
  { specialistId: 'security-reviewer' },
  { specialistId: 'reliability-reviewer' },
]);

export const COUNCIL_OPERATOR_ID = 'council-operator';
export const councilParticipantId = (specialistId: string): string => `council-${specialistId}`;

export interface PanelSeat {
  /** Collaboration participant id (`council-<specialist>`). */
  participantId: string;
  specialistId: string;
  name: string;
  responsibility: string;
  chair: boolean;
  manifestVersion: string;
  /** Digest of the manifest as loaded, so the record names the exact definition that took part. */
  manifestDigest: string;
  tools: readonly string[];
  skills: readonly string[];
  taskTypes: readonly string[];
  guidance: readonly string[];
  /** What the specialist does when it cannot establish something, from its own manifest. */
  handoff: string;
}

export type PanelResult = { ok: true; seats: readonly PanelSeat[] } | { ok: false; reasons: readonly string[] };

export interface PanelInput {
  registry: PackRegistry;
  language: TaskLanguage;
  /** Declared context window of the local model; undefined means undeclared, which refuses (never guessed). */
  contextTokens: number | undefined;
  /** Which harness/provider runs the specialists. Scripted mode uses the same gates as live: it must not be easier to pass. */
  provider?: 'ollama';
  seats?: readonly SeatSpec[];
}

export function resolvePanel(input: PanelInput): PanelResult {
  const specs = input.seats ?? DEFAULT_SEATS;
  const reasons: string[] = [];
  if (specs.length !== COUNCIL_LIMITS.seats) reasons.push(`a council has exactly ${COUNCIL_LIMITS.seats} seats; ${specs.length} requested`);
  const ids = specs.map((s) => s.specialistId);
  if (new Set(ids).size !== ids.length) reasons.push('a specialist cannot hold two seats');
  if (specs.filter((s) => s.chair).length !== 1) reasons.push('exactly one seat must chair the council');
  if (reasons.length) return { ok: false, reasons };

  const seats: PanelSeat[] = [];
  for (const spec of specs) {
    const manifest: AgentManifest | undefined = input.registry.agentById.get(spec.specialistId);
    if (!manifest) { reasons.push(`unknown_specialist: ${spec.specialistId} is not in the engineering pack`); continue; }
    if (!handles(manifest, { language: input.language, taskType: 'design' })) { reasons.push(`out_of_scope: ${manifest.id} does not handle design in ${input.language}`); continue; }
    const fit = negotiate(manifest, 'mastra', input.provider ?? 'ollama', input.contextTokens, { requireKnownContext: true });
    if (!fit.supported) { reasons.push(`unsupported: ${fit.reason}`); continue; }
    // Defence in depth: the manifest loader already refuses non-read tools; a council re-checks because it grants repository reads.
    const bad = manifest.tools.filter((t) => toolClassOf(t) !== 'read');
    if (bad.length || manifest.tools.length === 0) { reasons.push(`tools_refused: ${manifest.id} ${bad.length ? `holds non-read tool(s) ${bad.join(', ')}` : 'has no tools to inspect the repository with'}`); continue; }
    seats.push({
      participantId: councilParticipantId(manifest.id), specialistId: manifest.id, name: manifest.name, responsibility: manifest.responsibility, chair: spec.chair === true,
      manifestVersion: manifest.version, manifestDigest: hashValue(manifest), tools: [...manifest.tools], skills: [...manifest.skills], taskTypes: [...manifest.taskTypes], guidance: [...manifest.guidance], handoff: manifest.escalation.handoff,
    });
  }
  if (reasons.length) return { ok: false, reasons };

  // Role-distinct: different responsibility text and a different required-skill set, so three copies of one role cannot sit.
  const distinct = new Set(seats.map((s) => s.responsibility));
  if (distinct.size !== seats.length) return { ok: false, reasons: ['seats are not role-distinct: two specialists share the same responsibility'] };
  const skillSets = new Set(seats.map((s) => [...s.skills].sort().join('|')));
  if (skillSets.size !== seats.length) return { ok: false, reasons: ['seats are not role-distinct: two specialists share the same required skills'] };
  // The chair speaks first in every round (turn order = seat order), so round 3 begins with the synthesis.
  const ordered = [...seats].sort((a, b) => Number(b.chair) - Number(a.chair));
  return { ok: true, seats: Object.freeze(ordered) };
}

export interface ModelIdentity {
  provider: string;
  model: string;
}

/**
 * The configured identities the store attributes messages to. The provider/model recorded for a seat is what actually runs it:
 * scripted runs carry `scripted/…`, so a record can never present canned text as a model's answer.
 */
export function councilDirectory(seats: readonly PanelSeat[], model: ModelIdentity): ParticipantDirectory {
  const identities: ParticipantIdentity[] = [
    ...seats.map((s): ParticipantIdentity => ({ id: s.participantId, role: s.chair ? 'architect' : 'reviewer', kind: s.chair ? 'worker' : 'reviewer', displayName: s.name, provider: model.provider, model: model.model })),
    { id: COUNCIL_OPERATOR_ID, role: 'operator', kind: 'operator', displayName: 'Council operator (human)' },
  ];
  return new ParticipantDirectory(identities);
}

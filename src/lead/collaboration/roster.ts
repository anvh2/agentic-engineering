import type { ProviderDescriptor } from '../../runtime/execution/worker-provider.ts';
import { ParticipantDirectory } from '../../runtime/collaboration/directory.ts';
import type { ParticipantIdentity, EngineeringRole } from '../../runtime/collaboration/types.ts';

/**
 * The engineering department's configured identities, as the collaboration store sees them. Built from what is actually
 * configured (the provider registry's static descriptors and operator ids the caller names), never from a model's claim:
 *
 *   claude-engineering-lead   the Lead (the actor id the scheduler and review already use); chairs meetings
 *   worker-<provider>         one implementer per registered worker provider (ollama, codex, gemini, ...)
 *   <operator id>             humans; they can open or cancel a meeting, never take a turn (no provider)
 *
 * Being in the roster grants nothing beyond speaking in threads one is invited to: provider permission stays with
 * AGENTIC_ALLOW_PROVIDERS and repair authorizations with LifecycleStore.authorize.
 */

export const ENGINEERING_LEAD_ID = 'claude-engineering-lead';

export interface RosterInput {
  /** Static descriptors, e.g. `registry.ids().map((id) => registry.get(id).describe())`. describe() contacts nothing. */
  workers: readonly ProviderDescriptor[];
  operators: readonly string[];
  /** The Lead's model when known; UNKNOWN otherwise (the Claude CLI picks its own default). */
  leadModel?: string;
  /** Additional named roles (an architect, a reviewer) backed by a registered provider. */
  extra?: readonly { id: string; role: Exclude<EngineeringRole, 'operator' | 'engineering_lead'>; provider: ProviderDescriptor }[];
}

export function engineeringRoster(input: RosterInput): ParticipantDirectory {
  const identities: ParticipantIdentity[] = [
    { id: ENGINEERING_LEAD_ID, role: 'engineering_lead', kind: 'lead', displayName: 'Claude Engineering Lead', provider: 'claude', model: input.leadModel ?? 'UNKNOWN' },
    ...input.workers.map((d): ParticipantIdentity => ({ id: `worker-${d.identity.id}`, role: 'implementer', kind: 'worker', provider: d.identity.id, model: d.identity.model })),
    ...(input.extra ?? []).map((x): ParticipantIdentity => ({ id: x.id, role: x.role, kind: x.role === 'reviewer' || x.role === 'verifier' ? 'reviewer' : 'worker', provider: x.provider.identity.id, model: x.provider.identity.model })),
    ...input.operators.map((id): ParticipantIdentity => ({ id, role: 'operator', kind: 'operator' })),
  ];
  return new ParticipantDirectory(identities);
}

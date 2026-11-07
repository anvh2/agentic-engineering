import type { SchedulerStore } from '../../../runtime/scheduler/store.ts';
import { LifecycleStore } from '../../lifecycle/store.ts';

/** Tests only: pins an objective through the real lifecycle store and moves it to the phase a suggestion needs. */
export function pinObjective(store: SchedulerStore, objectiveId: string, batchId: string, phase: 'PINNED' | 'EXECUTING' | 'ESCALATED' | 'NOT_ACCEPTED' = 'ESCALATED', evidenceHash = 'e'.repeat(64)): LifecycleStore {
  const lifecycle = new LifecycleStore(store);
  lifecycle.create({ objectiveId, batchId, baseCommit: 'b', actor: 'lead', oracle: { dir: '/o', files: {}, commands: [['true']], negativeControl: { mode: 'required' }, specHash: 'h', pinnedAt: 1, pinnedBy: 'lead' } });
  if (phase === 'PINNED') return lifecycle;
  lifecycle.transition(objectiveId, 'EXECUTING', { actor: 'test', expectFrom: 'PINNED' });
  if (phase === 'EXECUTING') return lifecycle;
  if (phase === 'ESCALATED') {
    lifecycle.transition(objectiveId, 'ESCALATED', { actor: 'test', expectFrom: 'EXECUTING', reason: 'task_dead_end' });
    return lifecycle;
  }
  lifecycle.transition(objectiveId, 'ACCEPTING', { actor: 'test', expectFrom: 'EXECUTING' });
  lifecycle.transition(objectiveId, 'NOT_ACCEPTED', { actor: 'lifecycle-acceptance', expectFrom: 'ACCEPTING', reason: `oracle_rejected: the candidate failed the pinned oracle`, detail: { evidenceHash } });
  return lifecycle;
}

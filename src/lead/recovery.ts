import type { SchedulerStore, TaskRow } from '../runtime/scheduler/store.ts';

/**
 * Audited recovery of a RUNTIME_FAILURE task. The scheduler never retries these on its own once their claim budget is spent
 * (a task that keeps failing must not loop), and `lead retry` refuses them; this is the explicit human/Lead decision, with
 * a mandatory reason, recorded three ways: the task event log (actor + reason), artifacts.recoveries and the new state.
 *
 *   retry     back to READY. If the claim budget is spent it is raised first (grantClaims, default +1, capped by the schema),
 *             so the task is not immediately a dead end again.
 *   escalate  ESCALATED, so the Lead can `claude take` it. No further worker attempt is made.
 *
 * Dependents blocked by the failure are released by the `promote` at the end (BLOCKED -> BACKLOG when the dependency recovers).
 */

export type RecoveryAction = { kind: 'retry'; grantClaims?: number } | { kind: 'escalate' };

export interface RecoveryResult {
  task: TaskRow;
  action: RecoveryAction['kind'];
  grantedClaims: number;
}

export function recoverRuntimeFailure(store: SchedulerStore, taskId: string, options: { actor?: string; reason: string; action: RecoveryAction }): RecoveryResult {
  const actor = options.actor ?? 'human';
  const reason = options.reason.trim();
  if (!reason) throw new Error('a recovery needs a reason (it is part of the audit trail)');
  const before = store.requireTask(taskId);
  if (before.state !== 'RUNTIME_FAILURE') throw new Error(`${taskId} is ${before.state}; only a RUNTIME_FAILURE task is recovered with this command`);

  let granted = 0;
  const record = (task: TaskRow, action: string) => [...((task.artifacts.recoveries as unknown[] | undefined) ?? []), { at: store.now(), actor, action, reason }];

  if (options.action.kind === 'escalate') {
    const task = store.transition(taskId, 'ESCALATED', {
      actor,
      reason: `runtime failure escalated: ${reason}`,
      expectFrom: 'RUNTIME_FAILURE',
      patch: { failureCategory: 'runtime_failure_escalated', artifacts: { recoveries: record(before, 'escalate') } },
    });
    store.promote('recovery', { batchId: before.batchId });
    return { task, action: 'escalate', grantedClaims: 0 };
  }

  let current = before;
  if (current.claims >= current.spec.maxClaims || options.action.grantClaims !== undefined) {
    granted = options.action.grantClaims ?? 1;
    current = store.grantClaims(taskId, granted, actor, reason);
  }
  const task = store.transition(taskId, 'READY', {
    actor,
    reason: `runtime failure retried: ${reason}`,
    expectFrom: 'RUNTIME_FAILURE',
    patch: { runtimeRequeues: current.runtimeRequeues + 1, failureCategory: null, artifacts: { recoveries: record(current, 'retry') } },
  });
  store.promote('recovery', { batchId: before.batchId });
  return { task: store.requireTask(taskId), action: 'retry', grantedClaims: granted };
}

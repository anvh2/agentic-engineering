import { cancelTaskRun, type CancelRunResult } from '../runtime/scheduler/cancel.ts';
import type { Executor } from '../runtime/scheduler/scheduler.ts';
import type { SchedulerStore, TaskRow } from '../runtime/scheduler/store.ts';

/**
 * `lead cancel`: the operator's decision to stop a task, in the only safe order.
 *
 *   1. CANCELLED is written first. That is the fence: the owning scheduler's next heartbeat is refused, and anything the
 *      worker produces after this point is discarded, never integrated.
 *   2. The workflow run is then cancelled and the cancellation CONFIRMED (run terminal, model permit released), so the
 *      inference does not keep running after the task is gone. Recording the state alone, as before, left both alive.
 *
 * Idempotent: on an already-cancelled task step 1 is skipped and step 2 is retried, which is how an unconfirmed stop
 * (server down, run still active) is finished later. The result says plainly whether the run is known to have stopped.
 */

export interface CancelTaskResult {
  task: TaskRow;
  alreadyCancelled: boolean;
  run: CancelRunResult;
  /** True only when the run is confirmed stopped, or there never was one. */
  clean: boolean;
}

export async function cancelTask(
  store: SchedulerStore,
  options: { taskId: string; reason?: string; actor?: string; executor: Pick<Executor, 'cancel'>; capacity?: Parameters<typeof cancelTaskRun>[0]['capacity']; graceMs?: number; log?: (line: string) => void },
): Promise<CancelTaskResult> {
  const actor = options.actor ?? 'human';
  const before = store.requireTask(options.taskId);
  const alreadyCancelled = before.state === 'CANCELLED';
  const task = alreadyCancelled
    ? before
    : store.transition(options.taskId, 'CANCELLED', { actor, reason: options.reason ?? 'cancelled by user', patch: { failureCategory: 'cancelled' } });
  if (!alreadyCancelled) store.promote('cancel');
  const run = await cancelTaskRun({ store, executor: options.executor, capacity: options.capacity, task, actor, reason: options.reason ?? 'cancelled by operator', graceMs: options.graceMs, log: options.log });
  return { task: store.requireTask(options.taskId), alreadyCancelled, run, clean: run.outcome === 'stopped' || run.outcome === 'no_run' };
}

import type { SchedulerStore, TaskRow } from './store.ts';
import type { Executor } from './scheduler.ts';

/**
 * Cancelling a task's run and CONFIRMING it stopped. One implementation shared by every way a run can be abandoned
 * (task timeout, queue-wait timeout, scheduler stop, `lead cancel`, a cancelled task noticed through a lost lease), so
 * none of them can leave an inference and a model permit running unsupervised.
 *
 * Asking is not stopping. After the executor's cancel returns, this waits (bounded) until the model is really free: the
 * workflow run reports a terminal status AND no permit is held or queued on behalf of THIS RUN. Anything short of that is
 * reported as `still_active`, never as success, and recorded in the task's audit trail.
 *
 * "This run" matters because a task id is not an execution: another run of the same id (a retry, another provider, another
 * process on the machine) may hold its own permit and is none of this cancellation's business. Ownership comes from the run
 * id the runner wrote into its permit (src/runtime/capacity/model-capacity.ts, RUN OWNERSHIP). A permit whose owner cannot be
 * established still blocks: a false "stopped" is the dangerous direction. Provider and resource are never consulted.
 */

export type CancelOutcome =
  | 'no_run' //        the task never recorded a run: nothing to stop
  | 'stopped' //       the run is terminal and the task holds no model permit and no queue entry
  | 'still_active' //  the run, or its model permit, is still live after the grace period
  | 'unreachable' //   the server could not be reached or the executor cannot cancel: nothing is known to have stopped
  | 'unconfirmed'; //  the executor cancelled but cannot confirm (no status probe)

export interface CancelReport {
  /** What the executor could establish about the run itself. */
  run: 'terminal' | 'still_active' | 'unreachable' | 'unconfirmed';
  runStatus?: string;
  detail?: string;
}

export interface CancelRunResult {
  taskId: string;
  runId?: string;
  outcome: CancelOutcome;
  /** Model permits/queue entries still engaged for this task after the grace period. */
  engaged: { kind: 'lease' | 'waiter'; holder: string; pid: number; run?: string }[];
  detail: string;
}

export interface CancelRunOptions {
  store: SchedulerStore;
  executor: Pick<Executor, 'cancel'>;
  /** Machine-wide model capacity probe; without it only the run's own status is confirmed. */
  capacity?: { engagedBy?(tag: string, scope?: { runId?: string }): { kind: 'lease' | 'waiter'; holder: string; pid: number; run?: string }[] };
  task: TaskRow;
  /** The run to stop when the task row does not carry it (a run started after the task lost its lease was never recorded). */
  runId?: string;
  actor: string;
  /** Why the run is being stopped ("task timeout", "scheduler stopped", "cancelled by operator"). */
  reason: string;
  /** How long to wait for the model to be released after the executor's cancel returns (default 15 s). */
  graceMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_GRACE_MS = 15_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function cancelTaskRun(options: CancelRunOptions): Promise<CancelRunResult> {
  const { store, executor, capacity, actor, reason } = options;
  const log = options.log ?? (() => {});
  // Re-read: the caller's row may predate the run id being recorded.
  const task = store.getTask(options.task.id) ?? options.task;
  const runId = options.runId ?? task.runId ?? undefined;
  const tag = task.spec.request?.contract.taskId ?? task.id; // what the runner names its permit/queue entry after
  const engagedNow = () => capacity?.engagedBy?.(tag, { runId }) ?? []; // this run's entries, plus any whose owner is unknown
  const record = (result: CancelRunResult): CancelRunResult => {
    log(`${task.id}: cancel (${reason}): ${result.outcome}${result.runId ? ` run ${result.runId}` : ''}${result.detail ? ` - ${result.detail}` : ''}`);
    try {
      store.audit(task.id, actor, `run cancellation (${reason}): ${result.outcome}`, { runId: result.runId, outcome: result.outcome, engaged: result.engaged, detail: result.detail });
    } catch (err) {
      log(`${task.id}: could not record the cancellation audit event: ${(err as Error).message}`);
    }
    return result;
  };

  if (!runId) return record({ taskId: task.id, outcome: 'no_run', engaged: [], detail: 'no workflow run was recorded for this task' });
  if (!executor.cancel) return record({ taskId: task.id, runId, outcome: 'unreachable', engaged: [], detail: 'this executor cannot cancel runs; the run, if any, continues' });

  let report: CancelReport | void;
  try {
    report = await executor.cancel({ task, runId, log });
  } catch (err) {
    return record({ taskId: task.id, runId, outcome: 'unreachable', engaged: engagedNow(), detail: `cancel request failed: ${(err as Error).message}; the run may still be executing` });
  }
  const runReport: CancelReport = report ?? { run: 'unconfirmed' };

  // The run being terminal does not prove the model is free: the step may still be unwinding. Wait for the permit to go.
  const deadline = Date.now() + (options.graceMs ?? DEFAULT_GRACE_MS);
  const pollMs = options.pollMs ?? 250;
  let engaged = engagedNow();
  while (engaged.length > 0 && Date.now() < deadline) {
    await sleep(pollMs);
    engaged = engagedNow();
  }

  const stoppedRun = runReport.run === 'terminal';
  const detail = [runReport.detail, runReport.runStatus ? `run status ${runReport.runStatus}` : undefined, engaged.length ? `model still engaged: ${engaged.map((e) => `${e.kind} pid ${e.pid}`).join(', ')}` : undefined].filter(Boolean).join('; ');
  if (runReport.run === 'unreachable') return record({ taskId: task.id, runId, outcome: 'unreachable', engaged, detail });
  if (runReport.run === 'still_active' || engaged.length > 0) return record({ taskId: task.id, runId, outcome: 'still_active', engaged, detail });
  return record({ taskId: task.id, runId, outcome: stoppedRun ? 'stopped' : 'unconfirmed', engaged, detail });
}

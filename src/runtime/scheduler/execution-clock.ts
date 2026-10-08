/**
 * A task's two budgets, kept apart.
 *
 *   ACTIVE execution budget (`taskTimeoutMs`): the time a task may spend doing work. It does NOT run while the task is
 *   queued for a model permit, so a task that waited behind two others still gets its full budget once it holds one.
 *
 *   CAPACITY WAIT budget (`maxCapacityWaitMs`): the cumulative time a task may spend queued for model permits. Exhausting
 *   it is its own explicit outcome (`capacity_wait_timeout`), not a task timeout and not a coding failure.
 *
 * Hard upper bound on wall clock, by construction: elapsed = active + waited < taskTimeoutMs + maxCapacityWaitMs. Neither
 * budget can be extended by the other, and nothing here is unbounded.
 *
 * The clock is sampled (`tick`), so each transition between waiting and working is accounted to within one tick: the
 * interval since the previous tick is charged to "waiting" iff the task was queued at the END of it.
 */
export type ClockVerdict = 'running' | 'active_timeout' | 'wait_budget_exhausted';

export class ExecutionClock {
  readonly startedAt: number;
  readonly activeBudgetMs: number;
  readonly waitBudgetMs: number;
  private last: number;
  private waited = 0;

  constructor(startedAt: number, activeBudgetMs: number, waitBudgetMs: number) {
    this.startedAt = startedAt;
    this.activeBudgetMs = activeBudgetMs;
    this.waitBudgetMs = waitBudgetMs;
    this.last = startedAt;
  }

  tick(now: number, waitingForModel: boolean): ClockVerdict {
    const dt = Math.max(0, now - this.last);
    this.last = Math.max(this.last, now);
    if (waitingForModel) this.waited += dt;
    if (this.waited >= this.waitBudgetMs) return 'wait_budget_exhausted';
    if (now - this.startedAt - this.waited >= this.activeBudgetMs) return 'active_timeout';
    return 'running';
  }

  /** Cumulative time charged to waiting for a model permit. */
  get waitedMs(): number {
    return this.waited;
  }

  /** Time charged to active execution as of the last tick. */
  activeMs(): number {
    return this.last - this.startedAt - this.waited;
  }
}

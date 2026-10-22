import { StoreError, type Fence, type SchedulerStore, type TaskRow } from './store.ts';
import { languageOfSpec, providerOfSpec, resolveConfig, type FailureCategory, type SchedulerConfig } from './types.ts';
import { WorkspaceError, type Workspace } from '../worktree/worktree.ts';
import { ExecutionClock } from './execution-clock.ts';
import { DEFAULT_PROVIDER_ID, type ProviderDescriptor } from '../execution/worker-provider.ts';
import { decideRoute, type ProviderBudgetEntry, type RoutingCode, type RoutingDecision } from '../execution/provider-routing.ts';
import { cancelTaskRun, type CancelReport, type CancelRunResult } from './cancel.ts';

/**
 * Worker-pool scheduler. It ASSIGNS work and RECORDS outcomes; it contains no coding, retry or verification logic:
 * every task executes through the injected `Executor` (production: the registered Mastra `coding-task-workflow`,
 * whose runner owns retries, verification and mutation checks). A runtime PASS never completes a task: it creates a
 * review request (REVIEW_PENDING) and stops there.
 */

export interface ExecutorOutcome {
  runId?: string;
  studioUrl?: string;
  /** Runtime verdict, decided by the existing runner. */
  status: 'PASS' | 'ESCALATED_TO_CLAUDE' | 'RUNTIME_FAILURE' | 'KEPT_BY_CLAUDE';
  reasons: string[];
  codingAttempts: number;
  runtimeRetries: number;
  failureCategory?: string;
  artifactDir?: string;
  /** Verifier command/exit for PASS (evidence shown to the reviewer). */
  verifier?: { command: string[]; exitCode: number | null } | null;
  diff?: string;
  /** Per-attempt worker invocation telemetry the runner recorded (one per attempt that got a model response). */
  modelCalls?: ExecutorModelCall[];
}

/**
 * One worker invocation as the runner measured it: the provider-reported totals of one attempt's model call, which may
 * span several agent steps. Failed tries inside an attempt (runtime retries) report no usage and are not listed.
 */
export interface ExecutorModelCall {
  attempt: number;
  provider: string;
  model: string;
  startedAt: number | null;
  inferenceMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  usageSupport: 'tokens' | 'tokens-and-cost' | 'none' | 'unknown';
}

/** Persisted under `artifacts.modelCalls` (no schema change): the invocation plus the run and lease owner it belongs to. */
export interface PersistedModelCall extends ExecutorModelCall {
  runId: string;
  workerId: string;
}

const MAX_PERSISTED_MODEL_CALLS = 100;
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= 200 ? v : null);

/**
 * Merges one run's invocations into a task's persisted list. Keyed by (runId, attempt): completing the same run again
 * replaces its entries instead of adding them, so a retried completion never double-counts. Malformed entries are dropped,
 * never repaired; without a run id nothing is recorded, because the measurement could not be attributed.
 */
export function mergeModelCalls(existing: unknown, runId: string | null | undefined, workerId: string, calls: readonly ExecutorModelCall[] | undefined): PersistedModelCall[] {
  const prior = (Array.isArray(existing) ? existing : []).filter((c): c is PersistedModelCall => !!c && typeof c === 'object' && typeof c.runId === 'string');
  if (!runId || !calls?.length) return prior;
  const fresh: PersistedModelCall[] = [];
  for (const c of calls) {
    const attempt = count(c?.attempt);
    const provider = text(c?.provider);
    const model = text(c?.model);
    const inferenceMs = count(c?.inferenceMs);
    if (!attempt || !provider || !model || inferenceMs === null || fresh.some((f) => f.attempt === attempt)) continue;
    fresh.push({
      runId, workerId, attempt, provider, model, inferenceMs,
      startedAt: count(c.startedAt),
      inputTokens: count(c.inputTokens),
      outputTokens: count(c.outputTokens),
      usageSupport: (['tokens', 'tokens-and-cost', 'none'] as const).find((u) => u === c.usageSupport) ?? 'unknown',
    });
  }
  return [...prior.filter((p) => p.runId !== runId), ...fresh].slice(-MAX_PERSISTED_MODEL_CALLS);
}

export interface ExecutorInput {
  task: TaskRow;
  repository: string; // the isolated worktree path
  signal: AbortSignal;
  /** Called as soon as the workflow run exists, so a crash can be reconciled against it. */
  onRunStart(info: { runId: string; studioUrl?: string }): void;
  log(line: string): void;
}

export interface Executor {
  run(input: ExecutorInput): Promise<ExecutorOutcome>;
  /**
   * After a crash/lease expiry: what became of the previous run? Return its outcome if it finished, or undefined if it
   * never completed / is unknown (the task then runs fresh). May wait for a still-running run, honoring `signal`.
   */
  reconcile?(input: { task: TaskRow; runId: string; signal: AbortSignal; log(line: string): void }): Promise<ExecutorOutcome | undefined>;
  /**
   * Stops a run the scheduler has given up on (task timeout, scheduler stop, operator cancel). Aborting `signal` only stops
   * waiting; without this the run would keep executing (and holding the model) unsupervised, and a run orphaned by a server
   * restart would stay "running" forever, so every later claim would re-attach to it and time out again. Should report what
   * it could CONFIRM about the run (a bare resolve counts as "unconfirmed"); see cancel.ts, which also checks the model permit.
   */
  cancel?(input: { task: TaskRow; runId: string; log(line: string): void }): Promise<CancelReport | void>;
}

/** A store error that is a transient database condition (lock contention), not a lifecycle decision. */
function isTransientDbError(err: unknown): boolean {
  return !(err instanceof StoreError) && /database is locked|SQLITE_BUSY|database table is locked/i.test((err as Error)?.message ?? '');
}

/** Consecutive transient database failures the scheduling loop tolerates before giving up. */
const MAX_CONSECUTIVE_DB_ERRORS = 20;

export interface RunSummary {
  claimed: string[];
  reviewPending: string[];
  failed: { id: string; state: string; category?: string | null }[];
  requeued: string[];
  /** Most tasks that were in their execution lifecycle at the same instant during this run (concurrency actually achieved). */
  peakInFlight: number;
  stopReason: 'idle' | 'aborted';
  /** Runs the scheduler cancelled (timeout, stop) whose stop could not be CONFIRMED: possibly still executing and holding the model. */
  stillActive: CancelRunResult[];
}

/** A refused routing decision fails the task with an existing category (the persisted vocabulary is unchanged). */
const ROUTING_FAILURE: Record<Exclude<RoutingCode, 'local_default' | 'local_authorized' | 'authorized_within_budget'>, FailureCategory> = {
  unknown_provider: 'provider_unavailable',
  language_unsupported: 'not_eligible',
  provider_not_authorized: 'provider_not_authorized',
  budget_not_approved: 'provider_not_authorized',
  budget_exhausted: 'provider_not_authorized',
};

/** What a scheduler without `describeProvider` knows: the default provider is the local model, which spends nothing. */
const LOCAL_DEFAULT_DESCRIPTOR: ProviderDescriptor = Object.freeze({
  identity: { id: DEFAULT_PROVIDER_ID, kind: 'local', model: 'UNKNOWN' },
  capabilities: { taskTypes: ['go', 'js'], editsFiles: 'via-runtime-tools', fileScope: 'tool-enforced', cancellation: 'abort-signal', usage: 'tokens', billing: 'local-free' },
  capacity: { resource: DEFAULT_PROVIDER_ID, defaultPermits: 1 },
}) as ProviderDescriptor;

export interface SchedulerDeps {
  store: SchedulerStore;
  executor: Executor;
  workspace: Workspace;
  config?: Partial<SchedulerConfig>;
  log?: (line: string) => void;
  /**
   * Where model-permit queueing can be observed (production: the machine-wide ModelCapacity). With it, `taskTimeoutMs`
   * becomes an ACTIVE-execution budget that pauses while the task is queued for a permit, and the queueing itself is
   * bounded by `maxCapacityWaitMs`. Without it the legacy single wall-clock deadline applies.
   */
  capacity?: { isWaiting(tag: string): boolean; engagedBy?(tag: string, scope?: { runId?: string }): { kind: 'lease' | 'waiter'; holder: string; pid: number; run?: string }[] };
  /** How long a cancelled run gets to release the model before it is reported as still active (default 15 s). */
  cancelGraceMs?: number;
  /** The operator's allow-list for non-default worker providers (`codex` or `codex:<taskId>`). Empty: only the local model runs. */
  allowProviders?: readonly string[];
  /**
   * The operator's budgets, in claims, for providers that are not local-free (provider-routing.ts). Without an applicable entry
   * such a provider is refused even when allow-listed. Empty: nothing that costs money or quota runs.
   */
  providerBudgets?: readonly ProviderBudgetEntry[];
  /**
   * Static descriptor of a registered provider (contacts nothing). A provider it does not describe is refused as unknown. Absent:
   * only the default local provider is known, as local-free.
   */
  describeProvider?: (id: string) => ProviderDescriptor | undefined;
  /** Called when a task's executor starts (tests/measurement). */
  onExecutorStart?: (task: TaskRow) => void;
}

export class Scheduler {
  readonly store: SchedulerStore;
  readonly config: SchedulerConfig;
  private executor: Executor;
  private workspace: Workspace;
  private log: (line: string) => void;
  private onExecutorStart?: (task: TaskRow) => void;
  private capacity?: SchedulerDeps['capacity'];
  private abort = new AbortController();
  private cancelGraceMs?: number;
  private allowProviders: readonly string[];
  private providerBudgets: readonly ProviderBudgetEntry[];
  private describeProvider: (id: string) => ProviderDescriptor | undefined;
  private stillActive: CancelRunResult[] = [];
  /** Tasks this scheduler is executing right now, with their run id once known (what a forced exit must report). */
  private live = new Map<string, { taskId: string; epoch: number; runId?: string }>();

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.executor = deps.executor;
    this.workspace = deps.workspace;
    this.config = resolveConfig(deps.config);
    this.log = deps.log ?? (() => {});
    this.onExecutorStart = deps.onExecutorStart;
    this.capacity = deps.capacity;
    this.cancelGraceMs = deps.cancelGraceMs;
    this.allowProviders = deps.allowProviders ?? [];
    this.providerBudgets = deps.providerBudgets ?? [];
    this.describeProvider = deps.describeProvider ?? ((id) => (id === DEFAULT_PROVIDER_ID ? LOCAL_DEFAULT_DESCRIPTOR : undefined));
  }

  /**
   * Decides the claimed task's provider (provider-routing.ts) and records the decision, in ONE store transaction: the budget
   * spent so far is read, the decision made and, when it spends a claim, charged, so two schedulers (threads or processes)
   * can never both take the last claim of a budget. Every decision, selected or refused, is a `provider_routing` row and the
   * task's `artifacts.routing`; it is deliberately not an event, because readers take the event trajectory as state history.
   */
  private route(task: TaskRow, actor: string): RoutingDecision {
    return this.store.transact(() => {
      const requested = providerOfSpec(task.spec);
      const taskId = task.spec.request?.contract.taskId ?? task.id;
      const decision = decideRoute({
        taskId,
        language: languageOfSpec(task.spec),
        requested,
        descriptor: this.describeProvider(requested),
        allow: this.allowProviders,
        budgets: this.providerBudgets,
        spent: this.store.chargedProviderClaims(requested, task.id),
      });
      this.store.recordRouting(task.id, actor, decision);
      this.store.setArtifacts(task.id, { routing: decision });
      return decision;
    });
  }

  /**
   * Begins shutdown: nothing new is claimed from this moment, and every in-flight task is aborted, failed through its fence,
   * and has its run cancelled and the cancellation confirmed (or reported in `RunSummary.stillActive`). `run()` resolves
   * only after all of that has finished. Idempotent.
   */
  stop(): void {
    this.abort.abort(new Error('scheduler stopped'));
  }

  get stopping(): boolean {
    return this.abort.signal.aborted;
  }

  /** Tasks in flight and their Mastra run ids: what is (possibly) still executing if this process exits now. */
  inFlight(): { taskId: string; epoch: number; runId?: string }[] {
    return [...this.live.values()];
  }

  /**
   * Drains claimable work with at most maxConcurrentWorkers logical workers in flight. Terminates when nothing is
   * claimable and nothing is in flight (no busy loop: it waits on task completion or a bounded poll timer).
   *
   * Worker concurrency is NOT model concurrency. Every in-flight task runs its whole lifecycle (worktree, workflow,
   * verification, post-run checks) concurrently; the only point where they queue is the machine-wide model capacity
   * lease taken by the coding runner around each model call (src/runtime/capacity), which no scheduler setting bypasses.
   */
  async run(options: { batchId?: string; workerPrefix?: string } = {}): Promise<RunSummary> {
    const summary: RunSummary = { claimed: [], reviewPending: [], failed: [], requeued: [], peakInFlight: 0, stopReason: 'idle', stillActive: [] };
    if (options.batchId !== undefined && !this.store.getBatch(options.batchId)) throw new Error(`unknown batch ${options.batchId}: nothing to run`);
    const prefix = options.workerPrefix ?? `worker-${process.pid}`;
    const inflight = new Map<string, Promise<void>>();
    const slots = new Set<number>(); // worker slots in use
    let dbErrors = 0;

    while (!this.abort.signal.aborted) {
      try {
        const reaped = this.store.reapExpired();
        summary.requeued.push(...reaped.requeued);
        this.store.promote('scheduler', options.batchId === undefined ? {} : { batchId: options.batchId }); // a run limited to one batch promotes only that batch (and its dependents)

        // Shutdown gate: re-checked per claim, so no task is claimed once stop() has been called.
        while (inflight.size < this.config.maxConcurrentWorkers && !this.abort.signal.aborted) {
          const free = Array.from({ length: this.config.maxConcurrentWorkers }, (_, i) => i + 1).find((n) => !slots.has(n)) ?? 1;
          const claim = this.store.claim({
            workerId: `${prefix}-w${free}`,
            languages: this.config.workerLanguages,
            leaseMs: this.config.workerLeaseTimeoutMs,
            maxActive: this.config.maxConcurrentWorkers,
            batchId: options.batchId,
            maxTasksPerBatch: this.config.maxTasksPerBatch,
          });
          if (!claim) break;
          summary.claimed.push(claim.task.id);
          this.log(`claimed ${claim.task.id} (epoch ${claim.fence.epoch}, ${claim.fence.owner})`);
          slots.add(free);
          // Keyed by claim (task + epoch), not task: a task whose lease expired is requeued and may be re-claimed by THIS run
          // while the superseded execution is still winding down; its completion must not remove the new execution's entry.
          const key = `${claim.task.id}@${claim.fence.epoch}`;
          const p = this.execute(claim.task, claim.fence).finally(() => {
            inflight.delete(key);
            slots.delete(free);
          });
          inflight.set(key, p);
          summary.peakInFlight = Math.max(summary.peakInFlight, inflight.size);
        }
        dbErrors = 0;
      } catch (err) {
        // A busy database (another process holding the write lock past busy_timeout) delays scheduling; it must not
        // abort the run and abandon the tasks in flight. Anything else, or a lock that never clears, still surfaces.
        if (!isTransientDbError(err) || ++dbErrors > MAX_CONSECUTIVE_DB_ERRORS) {
          await Promise.allSettled(inflight.values());
          throw err;
        }
        this.log(`scheduling pass deferred: ${(err as Error).message} (${dbErrors}/${MAX_CONSECUTIVE_DB_ERRORS})`);
        await new Promise((r) => setTimeout(r, this.config.pollMs)); // not unref'd: with nothing in flight, this wait is all that keeps the run alive
        continue;
      }

      if (inflight.size === 0) break;
      await Promise.race([...inflight.values(), new Promise((r) => setTimeout(r, this.config.pollMs).unref?.())]);
    }
    if (this.abort.signal.aborted) {
      summary.stopReason = 'aborted';
      await Promise.allSettled(inflight.values());
    }
    summary.stillActive = this.stillActive;

    for (const id of new Set(summary.claimed)) {
      const t = this.store.requireTask(id);
      if (t.state === 'REVIEW_PENDING') summary.reviewPending.push(id);
      else if (['ESCALATED', 'RUNTIME_FAILURE', 'BLOCKED', 'CANCELLED'].includes(t.state)) summary.failed.push({ id, state: t.state, category: t.failureCategory });
    }
    return summary;
  }

  /** One claimed task, start to finish. Never throws: every outcome is persisted through fenced transitions. */
  private async execute(claimed: TaskRow, fence: Fence): Promise<void> {
    const { store } = this;
    const ctl = new AbortController();
    const onGlobalAbort = () => ctl.abort(new Error('scheduler stopped'));
    this.abort.signal.addEventListener('abort', onGlobalAbort, { once: true });
    if (this.abort.signal.aborted) onGlobalAbort(); // a listener added after the event would never hear it
    const liveKey = `${claimed.id}@${fence.epoch}`;
    this.live.set(liveKey, { taskId: claimed.id, epoch: fence.epoch });
    let timedOut = false;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      let renewed: boolean;
      try {
        renewed = store.heartbeat(claimed.id, fence, this.config.workerLeaseTimeoutMs);
      } catch (err) {
        // Runs in a timer: a throw here would be an uncaught exception that kills the scheduler process. A transiently
        // locked database just skips this renewal; the next one retries before the lease (3 intervals) can expire, and
        // if it does expire anyway the fence discards this worker's writes.
        this.log(`${claimed.id}: heartbeat failed (${(err as Error).message}); will retry`);
        return;
      }
      if (!renewed) {
        leaseLost = true;
        ctl.abort(new Error('lease lost'));
      }
    }, Math.max(50, Math.floor(this.config.workerLeaseTimeoutMs / 3)));
    // Two budgets (see execution-clock.ts): active execution (taskTimeoutMs), which does not run while the task is queued
    // for a model permit, and the queueing itself (maxCapacityWaitMs). Without a capacity probe: the single legacy deadline.
    let capacityWaitExpired = false;
    let unrecordedRunId: string | undefined; // a run that started after this task lost its fence: no row points at it, so only we can stop it
    const tag = claimed.spec.request?.contract.taskId ?? claimed.id; // what the runner tags its queue entry with
    const clock = this.capacity ? new ExecutionClock(Date.now(), this.config.taskTimeoutMs, this.config.maxCapacityWaitMs) : undefined;
    const timeout = clock
      ? setInterval(() => {
          let waiting = false;
          try {
            waiting = this.capacity!.isWaiting(tag);
          } catch {
            /* an unreadable capacity database must not stop the clock: count the interval as active (the stricter reading) */
          }
          const verdict = clock.tick(Date.now(), waiting);
          if (verdict === 'wait_budget_exhausted') {
            capacityWaitExpired = true;
            ctl.abort(new Error('capacity wait budget exhausted'));
          } else if (verdict === 'active_timeout') {
            timedOut = true;
            ctl.abort(new Error('task timeout'));
          }
        }, Math.max(5, Math.min(1_000, Math.floor(Math.min(this.config.pollMs, this.config.taskTimeoutMs / 4)))))
      : setTimeout(() => {
          timedOut = true;
          ctl.abort(new Error('task timeout'));
        }, this.config.taskTimeoutMs);
    const started = store.now();

    const fail = (to: 'RUNTIME_FAILURE' | 'ESCALATED' | 'BLOCKED', category: FailureCategory | string, reason: string): undefined => {
      try {
        store.transition(claimed.id, to, {
          actor: fence.owner,
          reason,
          expectFrom: ['CLAIMED', 'CODING', 'VERIFYING'],
          fence,
          patch: { failureCategory: category, codingMs: store.now() - started },
        });
      } catch (err) {
        // A fenced-out (StoreError) or unwritable (busy database) outcome is dropped: the lease then expires and the task
        // is requeued, where the recorded run id lets the next claim adopt any result instead of redoing the work.
        this.log(`discarded ${category} for ${claimed.id}: ${(err as Error).message}`);
      }
      return undefined;
    };

    try {
      const batch = store.getBatch(claimed.batchId);
      if (!batch) return fail('RUNTIME_FAILURE', 'executor_error', `batch ${claimed.batchId} missing`);

      // Provider routing: decided, recorded and (for a paid provider) charged before a worktree is prepared or any executor is
      // called. A refusal never falls back to another provider. (The workflow re-checks authorization and capability on its
      // own side: the executor may be a server this process does not control.)
      let routing: RoutingDecision;
      try {
        routing = this.route(claimed, fence.owner);
      } catch (err) {
        return fail('RUNTIME_FAILURE', 'executor_error', `provider routing could not be recorded: ${(err as Error).message}`);
      }
      if (routing.outcome === 'refused') return fail('RUNTIME_FAILURE', ROUTING_FAILURE[routing.code as keyof typeof ROUTING_FAILURE], routing.reason);
      if (routing.provider !== DEFAULT_PROVIDER_ID) this.log(`${claimed.id}: runs on provider "${routing.provider}" (${routing.reason})`);

      // A previous claim may have started (and even finished) a Mastra run before it was lost. Re-attach to its
      // worktree WITHOUT resetting it and try to adopt that run's outcome; only if there is nothing to adopt is the
      // worktree reset and the task run fresh.
      const hasPriorRun = Boolean(claimed.runId && this.executor.reconcile);
      let ws: { path: string; branch: string; baseCommit: string };
      const prepareWorkspace = async (preserve: boolean) => {
        try {
          return await this.workspace.prepare(claimed, batch, { preserve });
        } catch (err) {
          if (err instanceof WorkspaceError && err.code === 'source_tree_dirty') return fail('BLOCKED', 'source_tree_dirty', err.message);
          return fail('RUNTIME_FAILURE', 'executor_error', `workspace preparation failed: ${(err as Error).message}`);
        }
      };
      const prepared = await prepareWorkspace(hasPriorRun);
      if (!prepared) return;
      ws = prepared;
      let task = store.patchTask(claimed.id, { worktreePath: ws.path, branch: ws.branch, baseCommit: ws.baseCommit, artifacts: { linkPaths: batch.linkPaths } }, fence.owner, fence);

      let outcome: ExecutorOutcome | undefined;
      if (hasPriorRun) {
        outcome = await this.executor.reconcile!({ task, runId: task.runId!, signal: ctl.signal, log: this.log }).catch(() => undefined);
        if (outcome) this.log(`adopted outcome of previous run ${task.runId} for ${task.id}`);
        else {
          const reset = await prepareWorkspace(false);
          if (!reset) return;
          task = store.requireTask(task.id);
        }
      }

      // A timeout, cancellation or lost lease that fired while the worktree was being prepared must stop the task HERE: an
      // executor handed an already-aborted signal would never see an 'abort' event and would wait forever.
      ctl.signal.throwIfAborted();
      if (!outcome) {
        store.transition(task.id, 'CODING', { actor: fence.owner, reason: 'executor started', expectFrom: 'CLAIMED', fence });
        this.onExecutorStart?.(task);
        const running = store.requireTask(task.id);
        outcome = await this.executor.run({
          task: running,
          repository: ws.path,
          signal: ctl.signal,
          log: this.log,
          onRunStart: ({ runId }) => {
            if (!store.recordRun(task.id, fence, runId)) {
              unrecordedRunId = runId;
              throw new Error(`refusing to start workflow run ${runId}: task ${task.id} lost its execution fence`);
            }
            const entry = this.live.get(liveKey);
            if (entry) entry.runId = runId;
          },
        });
        // A result that arrives after the budget ran out is stale: the fence already belongs to the timeout decision, and an
        // outcome that races it in the same tick must not be recorded as if the task had finished in time.
        if (timedOut || capacityWaitExpired) throw ctl.signal.reason ?? new Error('task timeout');
      } else {
        store.transition(task.id, 'CODING', { actor: fence.owner, reason: 'adopting previous run outcome', expectFrom: 'CLAIMED', fence });
      }
      await this.complete(task.id, fence, outcome, started, clock?.waitedMs);
    } catch (err) {
      if (leaseLost || (err instanceof StoreError && err.code === 'stale_owner')) {
        this.log(`${claimed.id}: ownership lost; result discarded (task state belongs to its new owner)`);
        // Lost because the operator cancelled the task: nobody will adopt the run, so it must be stopped here. (A lease that
        // merely expired leaves the run to the next claim, which re-attaches to it.)
        if (store.getTask(claimed.id)?.state === 'CANCELLED') await this.cancelAbandonedRun(claimed.id, 'task cancelled by operator');
      } else if (capacityWaitExpired) {
        fail('RUNTIME_FAILURE', 'capacity_wait_timeout', `queued for a model permit for ${clock?.waitedMs ?? '?'}ms, past maxCapacityWaitMs of ${this.config.maxCapacityWaitMs}ms; retry when the model is less contended`);
        await this.cancelAbandonedRun(claimed.id, 'capacity wait budget exhausted');
      } else if (timedOut) {
        fail('RUNTIME_FAILURE', 'task_timeout', `task exceeded taskTimeout of ${this.config.taskTimeoutMs}ms${clock ? ` of active execution (${clock.waitedMs}ms queued for a model permit not counted)` : ''}`);
        await this.cancelAbandonedRun(claimed.id, 'task timeout');
      } else if (this.abort.signal.aborted) {
        fail('RUNTIME_FAILURE', 'executor_error', 'scheduler stopped while the task was running');
        await this.cancelAbandonedRun(claimed.id, 'scheduler stopped');
      } else {
        fail('RUNTIME_FAILURE', 'executor_error', `executor failed: ${(err as Error).message}`);
      }
      if (unrecordedRunId) await this.cancelAbandonedRun(claimed.id, 'run started after the task lost its lease', unrecordedRunId);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      this.abort.signal.removeEventListener('abort', onGlobalAbort);
      this.live.delete(liveKey);
    }
  }

  /** Stops the run a task was executing or re-attached to and confirms it (see cancel.ts). Never throws; an unconfirmed stop is surfaced in the run summary. */
  private async cancelAbandonedRun(taskId: string, reason: string, runId?: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) return;
    try {
      const result = await cancelTaskRun({ store: this.store, executor: this.executor, capacity: this.capacity, task, runId, actor: 'scheduler', reason, graceMs: this.cancelGraceMs, log: this.log });
      if (result.outcome !== 'stopped' && result.outcome !== 'no_run') this.stillActive.push(result);
    } catch (err) {
      this.log(`${taskId}: could not cancel run ${task.runId ?? '(none)'}: ${(err as Error).message}`);
    }
  }

  /** Persists an executor outcome. Idempotent: a stale or duplicate completion is rejected by the fence / state check. */
  async complete(taskId: string, fence: Fence, outcome: ExecutorOutcome, startedAt: number, capacityWaitMs?: number): Promise<void> {
    const { store } = this;
    const current = store.requireTask(taskId);
    const patchBase = {
      ...(outcome.runId ? { runId: outcome.runId } : {}),
      attempts: current.attempts + outcome.codingAttempts,
      runtimeRetries: current.runtimeRetries + outcome.runtimeRetries,
      codingMs: store.now() - startedAt,
    };
    const modelCalls = mergeModelCalls(current.artifacts.modelCalls, outcome.runId ?? current.runId, fence.owner, outcome.modelCalls);
    const artifacts = { ...(outcome.artifactDir ? { artifactDir: outcome.artifactDir } : {}), ...(outcome.studioUrl ? { studioUrl: outcome.studioUrl } : {}), ...(capacityWaitMs !== undefined ? { capacityWaitMs } : {}), ...(modelCalls.length ? { modelCalls } : {}) };

    if (outcome.status === 'PASS') {
      store.transition(taskId, 'VERIFYING', { actor: fence.owner, reason: 'runtime PASS; running post-run change checks', expectFrom: 'CODING', fence, patch: { ...patchBase, artifacts } });
      const verifyStart = store.now();
      const task = store.requireTask(taskId);
      let inspection;
      let head: string;
      try {
        inspection = await this.workspace.inspect(task);
        const blocking = inspection.findings.filter((f) => f.severity === 'block');
        if (blocking.length > 0) {
          store.transition(taskId, 'ESCALATED', {
            actor: fence.owner,
            reason: `post-run change review blocked: ${blocking.map((f) => f.code).join(', ')}`,
            expectFrom: 'VERIFYING',
            fence,
            patch: { failureCategory: 'review_gate_blocked' satisfies FailureCategory, verifyMs: store.now() - verifyStart, result: { findings: inspection.findings, reasons: outcome.reasons, capacity: inspection.capacity, changedLines: inspection.changedLines } },
          });
          return;
        }
        head = await this.workspace.commit(task);
      } catch (err) {
        if (err instanceof StoreError) throw err;
        store.transition(taskId, 'RUNTIME_FAILURE', { actor: fence.owner, reason: `post-run verification failed: ${(err as Error).message}`, expectFrom: 'VERIFYING', fence, patch: { failureCategory: 'executor_error', verifyMs: store.now() - verifyStart } });
        return;
      }
      store.transition(taskId, 'REVIEW_PENDING', {
        actor: fence.owner,
        reason: 'verified; awaiting Engineering Lead review',
        expectFrom: 'VERIFYING',
        fence,
        patch: { headCommit: head, verifyMs: store.now() - verifyStart, result: { findings: inspection.findings, verifier: outcome.verifier ?? null, diffBytes: inspection.diff.length, capacity: inspection.capacity, changedLines: inspection.changedLines } },
        review: {
          taskId,
          title: task.title,
          objective: task.spec.request?.contract.objective,
          acceptanceCriteria: task.spec.request?.contract.acceptanceCriteria ?? [],
          constraints: task.spec.request?.contract.constraints ?? [],
          allowedFiles: task.spec.request?.contract.allowedFiles ?? [],
          branch: task.branch,
          baseCommit: task.baseCommit,
          headCommit: head,
          diff: inspection.diff,
          findings: inspection.findings,
          capacity: inspection.capacity,
          changedLines: inspection.changedLines,
          verifier: outcome.verifier ?? null,
          runId: outcome.runId ?? task.runId,
          codingAttempts: outcome.codingAttempts,
          feedbackAddressed: task.feedback,
        },
      });
      return;
    }

    if (outcome.status === 'RUNTIME_FAILURE') {
      store.transition(taskId, 'RUNTIME_FAILURE', { actor: fence.owner, reason: outcome.reasons.join('; ') || 'model runtime failure', expectFrom: 'CODING', fence, patch: { ...patchBase, failureCategory: (outcome.reasons.some((r) => r.includes('capacity_wait_timeout')) ? 'capacity_wait_timeout' : outcome.reasons.some((r) => r.startsWith('provider_not_authorized')) ? 'provider_not_authorized' : outcome.reasons.some((r) => r.startsWith('provider_unavailable') || r.startsWith('unknown_provider')) ? 'provider_unavailable' : 'runtime_unavailable') satisfies FailureCategory, artifacts } });
      return;
    }
    const category: FailureCategory = outcome.status === 'KEPT_BY_CLAUDE' ? 'not_eligible' : outcome.failureCategory === 'D_forbidden_mutation' || outcome.reasons.includes('forbidden_mutation') ? 'forbidden_mutation' : 'coding_attempts_exhausted';
    store.transition(taskId, 'ESCALATED', { actor: fence.owner, reason: outcome.reasons.join('; ') || outcome.status, expectFrom: 'CODING', fence, patch: { ...patchBase, failureCategory: category, artifacts, result: { reasons: outcome.reasons, runnerCategory: outcome.failureCategory ?? null } } });
  }

  /**
   * Restart recovery. Returns tasks whose lease has expired to READY (they are re-claimed by `run`, which first tries
   * to adopt any Mastra run they had already started) and, with `stealLeases`, treats every live lease as dead: use it
   * only when the operator knows the previous scheduler process is gone.
   */
  recover(options: { stealLeases?: boolean } = {}): { requeued: string[]; exhausted: string[] } {
    if (options.stealLeases) {
      const out = { requeued: [] as string[], exhausted: [] as string[] };
      for (const t of this.store.listTasks({ states: ['CLAIMED', 'CODING', 'VERIFYING'] })) {
        // A paid provider's task is never requeued on the operator's behalf; the operator retries it explicitly.
        const to = t.claims >= t.spec.maxClaims || providerOfSpec(t.spec) !== DEFAULT_PROVIDER_ID ? 'RUNTIME_FAILURE' : 'READY';
        this.store.transition(t.id, to, {
          actor: 'recovery',
          reason: 'lease stolen by operator (previous scheduler process is gone)',
          expectFrom: t.state,
          fence: { owner: t.leaseOwner ?? '', epoch: t.claimEpoch },
          patch: to === 'RUNTIME_FAILURE' ? { failureCategory: 'lease_expired' } : undefined,
          releaseLease: true,
        });
        (to === 'READY' ? out.requeued : out.exhausted).push(t.id);
      }
      return out;
    }
    return this.store.reapExpired('recovery');
  }
}

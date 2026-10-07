import { StoreError, type Fence, type SchedulerStore, type TaskRow } from './store.ts';
import { resolveConfig, type FailureCategory, type SchedulerConfig } from './types.ts';
import { WorkspaceError, type Workspace } from '../worktree/worktree.ts';

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
   * Stops a run the scheduler has given up on (task timeout), best effort. Aborting `signal` only stops waiting; without
   * this the run would keep executing (and holding the model) unsupervised, and a run orphaned by a server restart would
   * stay "running" forever, so every later claim would re-attach to it and time out again.
   */
  cancel?(input: { task: TaskRow; runId: string; log(line: string): void }): Promise<void>;
}

/** A store error that is a transient database condition (lock contention), not a lifecycle decision. */
function isTransientDbError(err: unknown): boolean {
  return !(err instanceof StoreError) && /database is locked|SQLITE_BUSY|database table is locked/i.test((err as Error)?.message ?? '');
}

/** Consecutive transient database failures the scheduling loop tolerates before giving up. */
const MAX_CONSECUTIVE_DB_ERRORS = 20;

/** Counting semaphore bounding concurrent local-model work (maxConcurrentOllamaRequests). */
export class Semaphore {
  private available: number;
  private waiters: (() => void)[] = [];
  constructor(permits: number) {
    this.available = permits;
  }
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('aborted');
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('aborted'));
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }
  get inUse(): number {
    return this.waiters.length;
  }
}

export interface RunSummary {
  claimed: string[];
  reviewPending: string[];
  failed: { id: string; state: string; category?: string | null }[];
  requeued: string[];
  stopReason: 'idle' | 'aborted';
}

export interface SchedulerDeps {
  store: SchedulerStore;
  executor: Executor;
  workspace: Workspace;
  config?: Partial<SchedulerConfig>;
  log?: (line: string) => void;
  /** Peak concurrency probe for tests/measurement. */
  onExecutorStart?: (task: TaskRow) => void;
}

export class Scheduler {
  readonly store: SchedulerStore;
  readonly config: SchedulerConfig;
  private executor: Executor;
  private workspace: Workspace;
  private log: (line: string) => void;
  private ollama: Semaphore;
  private onExecutorStart?: (task: TaskRow) => void;
  private abort = new AbortController();

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.executor = deps.executor;
    this.workspace = deps.workspace;
    this.config = resolveConfig(deps.config);
    this.log = deps.log ?? (() => {});
    this.ollama = new Semaphore(this.config.maxConcurrentOllamaRequests);
    this.onExecutorStart = deps.onExecutorStart;
  }

  stop(): void {
    this.abort.abort();
  }

  /**
   * Drains claimable work with at most maxConcurrentWorkers in flight. Terminates when nothing is claimable and
   * nothing is in flight (no busy loop: it waits on task completion or a bounded poll timer).
   */
  async run(options: { batchId?: string; workerPrefix?: string } = {}): Promise<RunSummary> {
    const summary: RunSummary = { claimed: [], reviewPending: [], failed: [], requeued: [], stopReason: 'idle' };
    const prefix = options.workerPrefix ?? `worker-${process.pid}`;
    const inflight = new Map<string, Promise<void>>();
    const slots = new Set<number>(); // worker slots in use
    let dbErrors = 0;

    while (!this.abort.signal.aborted) {
      try {
        const reaped = this.store.reapExpired();
        summary.requeued.push(...reaped.requeued);
        this.store.promote();

        while (inflight.size < this.config.maxConcurrentWorkers) {
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
          const p = this.execute(claim.task, claim.fence).finally(() => {
            inflight.delete(claim.task.id);
            slots.delete(free);
          });
          inflight.set(claim.task.id, p);
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

    for (const id of summary.claimed) {
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
    const timeout = setTimeout(() => {
      timedOut = true;
      ctl.abort(new Error('task timeout'));
    }, this.config.taskTimeoutMs);
    const started = store.now();
    let ollamaHeld = false;

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

      if (!outcome) {
        await this.ollama.acquire(ctl.signal);
        ollamaHeld = true;
        store.transition(task.id, 'CODING', { actor: fence.owner, reason: 'executor started', expectFrom: 'CLAIMED', fence });
        this.onExecutorStart?.(task);
        const running = store.requireTask(task.id);
        outcome = await this.executor.run({
          task: running,
          repository: ws.path,
          signal: ctl.signal,
          log: this.log,
          onRunStart: ({ runId }) => {
            store.recordRun(task.id, fence, runId);
          },
        });
        this.ollama.release();
        ollamaHeld = false;
      } else {
        store.transition(task.id, 'CODING', { actor: fence.owner, reason: 'adopting previous run outcome', expectFrom: 'CLAIMED', fence });
      }
      await this.complete(task.id, fence, outcome, started);
    } catch (err) {
      if (leaseLost || (err instanceof StoreError && err.code === 'stale_owner')) {
        this.log(`${claimed.id}: ownership lost; result discarded (task state belongs to its new owner)`);
      } else if (timedOut) {
        fail('RUNTIME_FAILURE', 'task_timeout', `task exceeded taskTimeout of ${this.config.taskTimeoutMs}ms`);
        await this.cancelAbandonedRun(claimed.id);
      } else if (this.abort.signal.aborted) {
        fail('RUNTIME_FAILURE', 'executor_error', 'scheduler stopped while the task was running');
      } else {
        fail('RUNTIME_FAILURE', 'executor_error', `executor failed: ${(err as Error).message}`);
      }
    } finally {
      if (ollamaHeld) this.ollama.release();
      clearInterval(heartbeat);
      clearTimeout(timeout);
      this.abort.signal.removeEventListener('abort', onGlobalAbort);
    }
  }

  /** Best-effort cancel of the run a timed-out task was executing or re-attached to (see Executor.cancel). */
  private async cancelAbandonedRun(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task?.runId || !this.executor.cancel) return;
    try {
      await this.executor.cancel({ task, runId: task.runId, log: this.log });
      this.log(`${taskId}: cancelled abandoned run ${task.runId}`);
    } catch (err) {
      this.log(`${taskId}: could not cancel run ${task.runId}: ${(err as Error).message}`);
    }
  }

  /** Persists an executor outcome. Idempotent: a stale or duplicate completion is rejected by the fence / state check. */
  async complete(taskId: string, fence: Fence, outcome: ExecutorOutcome, startedAt: number): Promise<void> {
    const { store } = this;
    const current = store.requireTask(taskId);
    const patchBase = {
      ...(outcome.runId ? { runId: outcome.runId } : {}),
      attempts: current.attempts + outcome.codingAttempts,
      runtimeRetries: current.runtimeRetries + outcome.runtimeRetries,
      codingMs: store.now() - startedAt,
    };
    const artifacts = { ...(outcome.artifactDir ? { artifactDir: outcome.artifactDir } : {}), ...(outcome.studioUrl ? { studioUrl: outcome.studioUrl } : {}) };

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
            patch: { failureCategory: 'review_gate_blocked' satisfies FailureCategory, verifyMs: store.now() - verifyStart, result: { findings: inspection.findings, reasons: outcome.reasons } },
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
        patch: { headCommit: head, verifyMs: store.now() - verifyStart, result: { findings: inspection.findings, verifier: outcome.verifier ?? null, diffBytes: inspection.diff.length } },
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
          verifier: outcome.verifier ?? null,
          runId: outcome.runId ?? task.runId,
          codingAttempts: outcome.codingAttempts,
          feedbackAddressed: task.feedback,
        },
      });
      return;
    }

    if (outcome.status === 'RUNTIME_FAILURE') {
      store.transition(taskId, 'RUNTIME_FAILURE', { actor: fence.owner, reason: outcome.reasons.join('; ') || 'model runtime failure', expectFrom: 'CODING', fence, patch: { ...patchBase, failureCategory: 'runtime_unavailable' satisfies FailureCategory, artifacts } });
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
        const to = t.claims >= t.spec.maxClaims ? 'RUNTIME_FAILURE' : 'READY';
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

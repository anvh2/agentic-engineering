import { randomUUID } from 'node:crypto';
import { suggestForDeadTasks, suggestForRejectedObjective, type SuggestOutcome } from '../collaboration/suggestions.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { integrateBatch, type CommandRunner } from '../../runtime/integration/integrate.ts';
import { DEFAULT_PROVIDER_ID } from '../../runtime/execution/worker-provider.ts';
import type { CancelRunResult } from '../../runtime/scheduler/cancel.ts';
import type { Executor, RunSummary } from '../../runtime/scheduler/scheduler.ts';
import type { SchedulerStore, TaskRow } from '../../runtime/scheduler/store.ts';
import { TRANSITIONS, providerOfSpec, type SchedulerConfig } from '../../runtime/scheduler/types.ts';
import type { WorktreeManager } from '../../runtime/worktree/worktree.ts';
import { cancelTask } from '../cancel.ts';
import { pendingReviews, reviewDecision } from '../review.ts';
import { requiredTasks, runAcceptance, type AcceptanceRecord } from './oracle.ts';
import { FINAL_PHASES, LifecycleError, type LifecyclePhase, type LifecycleRow, type LifecycleStore } from './store.ts';
import type { ApprovalVerifier } from '../../runtime/execution/design-approval.ts';
import type { EngineeringKnowledgeCatalog } from '../../runtime/knowledge/engineering-knowledge.ts';
import { verifyReview, type ReviewVerdict } from './verified-review.ts';

/**
 * The objective lifecycle driver. It does not orchestrate work itself: it repeats one round until the objective stops,
 * and every step of a round is an existing mechanism.
 *
 *   round:  Scheduler.run (claims READY tasks, runs the worker, verifies, stops at REVIEW_PENDING)
 *        -> verified review of every REVIEW_PENDING task          (APPROVED | correction task | ESCALATED, via lead/review.ts)
 *        -> integrateBatch of every APPROVED task, deps first     (DONE only after integration verification)
 *   until every required task is DONE -> ACCEPTING -> the pinned oracle decides ACCEPTED | NOT_ACCEPTED.
 *
 * Integration is part of each round, not a final step, because the DAG contract makes a dependent READY only once its
 * dependencies are DONE (integrated), so its worktree contains their work.
 *
 * Stops (never retried by the driver): ESCALATED (a task is a dead end, the evidence is untrustworthy, nothing can progress),
 * AWAITING_OPERATOR (a bounded action needs the operator's authorization), CANCELLED. Each is recorded with its cause and
 * resumed only by an explicit, audited operator action.
 */

export const REVIEWER = 'lifecycle-verified-reviewer';
const INTEGRATOR = 'lifecycle-integrator';
const DRIVER = 'lifecycle-driver';

/** Test seams: awaited at the points where a concurrent cancellation must be survivable. Never set in production. */
export interface LifecycleHooks {
  beforeDecision?(verdict: ReviewVerdict): void | Promise<void>;
  beforeIntegration?(): void | Promise<void>;
  beforeAcceptanceCommit?(record: AcceptanceRecord): void | Promise<void>;
}

export interface LifecycleDeps {
  store: SchedulerStore;
  worktrees: WorktreeManager;
  lifecycle: LifecycleStore;
  scheduler: { run(options: { batchId?: string }): Promise<RunSummary>; stop?(): void };
  /** Cancels workflow runs (production: the Mastra executor). Without it a cancel is recorded but runs are reported unconfirmed. */
  executor?: Pick<Executor, 'cancel'>;
  capacity?: Parameters<typeof cancelTask>[1]['capacity'];
  /** Runs one argv in a directory for verification, integration and acceptance. Production: the sandbox runner. */
  run: CommandRunner;
  config: Pick<SchedulerConfig, 'maxReviewCorrections'>;
  acknowledgeWarnings?: readonly string[];
  /** Re-verifies attached design approvals during review (default: deny all, so such tasks escalate). */
  approvals?: ApprovalVerifier;
  /** Trusted runtime catalog used to re-resolve any curated knowledge a task pinned (default: none, so such a task cannot be approved). */
  knowledgeCatalog?: EngineeringKnowledgeCatalog;
  /** Safety bound on rounds (default 25): a lifecycle that cannot finish in this many rounds stops ESCALATED. */
  maxRounds?: number;
  /** Where the final verdict file is written (default: none). */
  evidenceDir?: string;
  log?: (line: string) => void;
  hooks?: LifecycleHooks;
}

export type LifecycleVerdictName = 'ACCEPTED' | 'NOT_ACCEPTED' | 'ESCALATED' | 'AWAITING_OPERATOR' | 'CANCELLED' | 'IN_PROGRESS';

export interface LifecycleOutcome {
  objectiveId: string;
  batchId: string;
  phase: LifecyclePhase;
  verdict: LifecycleVerdictName;
  reason: string | null;
  rounds: number;
  acceptance: AcceptanceRecord | null;
  /** Everything that stopped progress, one line each (empty for ACCEPTED). */
  stops: string[];
}

const rootTaskId = (id: string): string => id.replace(/-fix\d+$/, '');

const DEAD_END_STATES = new Set(['ESCALATED', 'CANCELLED', 'BLOCKED', 'REVIEW_REJECTED', 'RUNTIME_FAILURE']);

function summarize(lc: LifecycleRow, rounds: number, acceptance: AcceptanceRecord | null = null, stops: string[] = []): LifecycleOutcome {
  const result = lc.result as { reason?: string; acceptance?: AcceptanceRecord; stops?: string[] } | null;
  const verdict: LifecycleVerdictName = lc.phase === 'PINNED' || lc.phase === 'EXECUTING' || lc.phase === 'ACCEPTING' ? 'IN_PROGRESS' : lc.phase;
  return {
    objectiveId: lc.objectiveId,
    batchId: lc.batchId,
    phase: lc.phase,
    verdict,
    reason: result?.reason ?? null,
    rounds,
    acceptance: acceptance ?? result?.acceptance ?? null,
    stops: stops.length > 0 ? stops : (result?.stops ?? []),
  };
}

/** How long a driver's claim on an objective lasts without renewal; a live driver renews it every minute. */
const DRIVER_LOCK_TTL_MS = 5 * 60_000;

/**
 * Runs the lifecycle of one objective until it reaches a final phase or a stop. Safe to call again after a crash or a stop:
 * every step re-reads durable state. One driver per objective: a second caller is refused while the first is alive.
 */
export async function runObjectiveLifecycle(deps: LifecycleDeps, objectiveId: string, options: { actor?: string } = {}): Promise<LifecycleOutcome> {
  const lc = deps.lifecycle.require(objectiveId);
  // Unique per call, not per process: the lock is re-entrant for the same owner, so a pid-only owner let a second driver in the SAME process
  // (a double invocation, a retry that raced its predecessor) acquire the lock and run the same objective concurrently.
  const owner = `${options.actor ?? DRIVER}:${process.pid}:${randomUUID()}`;
  const lockName = `lifecycle:${objectiveId}`;
  if (!deps.store.acquireLock(lockName, owner, DRIVER_LOCK_TTL_MS)) {
    return { ...summarize(lc, 0), reason: 'driver_locked', stops: [`another driver holds the lifecycle lock for ${objectiveId}; only one runs an objective at a time`] };
  }
  const beat = setInterval(() => {
    try {
      deps.store.acquireLock(lockName, owner, DRIVER_LOCK_TTL_MS);
    } catch {
      /* a busy database skips one renewal; the next one (well inside the TTL) retries */
    }
  }, 60_000);
  beat.unref();
  try {
    return await driveObjective(deps, objectiveId, options);
  } finally {
    clearInterval(beat);
    deps.store.releaseLock(lockName, owner);
  }
}

async function driveObjective(deps: LifecycleDeps, objectiveId: string, options: { actor?: string }): Promise<LifecycleOutcome> {
  const { store, lifecycle, worktrees } = deps;
  const actor = options.actor ?? DRIVER;
  const log = deps.log ?? (() => {});
  const maxRounds = deps.maxRounds ?? 25;
  let lc = lifecycle.require(objectiveId);
  const batchId = lc.batchId;
  let rounds = 0;

  // A stop waits for a human: the driver neither retries it nor leaves it.
  if (FINAL_PHASES.includes(lc.phase) || lc.phase === 'ESCALATED' || lc.phase === 'AWAITING_OPERATOR') return summarize(lc, 0);

  const phaseNow = (): LifecycleRow => lifecycle.require(objectiveId);

  /** Moves out of EXECUTING/ACCEPTING with a recorded cause. If someone else already changed the phase (a cancel), that wins. */
  const stop = (to: 'ESCALATED' | 'AWAITING_OPERATOR', from: 'EXECUTING' | 'ACCEPTING', reason: string, stops: string[]): LifecycleOutcome => {
    try {
      lc = lifecycle.transition(objectiveId, to, { actor, expectFrom: from, reason, detail: { stops }, result: { reason, stops } });
      log(`objective ${objectiveId}: ${to} (${reason})`);
    } catch (err) {
      if (!(err instanceof LifecycleError && err.code === 'phase_mismatch')) throw err;
      lc = phaseNow();
    }
    return summarize(lc, rounds, null, stops);
  };

  /**
   * A technical escalation may deserve a meeting: record a suggestion (lead/collaboration/suggestions.ts). It is advisory and
   * best-effort: it opens nothing, and a failure to record it is audited but never changes the lifecycle's outcome.
   */
  const suggest = (what: string, fn: () => SuggestOutcome): void => {
    try {
      const out = fn();
      if (out.created.length > 0) {
        lifecycle.audit(objectiveId, DRIVER, 'meeting_suggested', `${what}: ${out.created.map((s) => `${s.id} (${s.meetingType})`).join(', ')}; pending an explicit decision by the Lead or an operator`, { suggestions: out.created.map((s) => s.id), skipped: out.skipped });
        log(`objective ${objectiveId}: meeting suggested ${out.created.map((s) => s.id).join(', ')} (accept: lead meeting open <session> --suggestion <id>)`);
      }
    } catch (err) {
      lifecycle.audit(objectiveId, DRIVER, 'meeting_suggestion_failed', `${what}: ${(err as Error).message}`);
    }
  };

  if (lc.phase === 'PINNED') lc = lifecycle.transition(objectiveId, 'EXECUTING', { actor, expectFrom: 'PINNED', reason: 'oracle pinned; execution starts' });

  const signature = (): string => {
    const tasks = store.listTasks({ batchId }).map((t) => `${t.id}:${t.state}:${t.claimEpoch}:${t.corrections}`);
    const events = (store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    return `${tasks.join('|')}#${events}`;
  };

  while (lc.phase === 'EXECUTING') {
    if (rounds >= maxRounds) return stop('ESCALATED', 'EXECUTING', 'max_rounds', [`the objective did not finish within ${maxRounds} rounds`]);
    rounds += 1;
    const before = signature();

    // 1. execution
    const summary = await deps.scheduler.run({ batchId });
    if (phaseNow().phase !== 'EXECUTING') return summarize(phaseNow(), rounds);
    lifecycle.audit(objectiveId, DRIVER, 'execution', `round ${rounds}: claimed ${summary.claimed.join(', ') || '-'}; review pending ${summary.reviewPending.join(', ') || '-'}; failed ${summary.failed.map((f) => `${f.id}(${f.state})`).join(', ') || '-'}`, { round: rounds, claimed: summary.claimed, failed: summary.failed });

    // 2. verified review
    const awaiting = await reviewRound(deps, objectiveId, batchId);
    if (phaseNow().phase !== 'EXECUTING') return summarize(phaseNow(), rounds);

    // 3. integration
    try {
      await integrationRound(deps, objectiveId, batchId);
    } catch (err) {
      if (phaseNow().phase !== 'EXECUTING') return summarize(phaseNow(), rounds); // cancelled underneath the integrator
      throw err;
    }
    if (phaseNow().phase !== 'EXECUTING') return summarize(phaseNow(), rounds);

    // 4. where are we?
    const required = requiredTasks(store, batchId);
    const dead = required.filter((t) => DEAD_END_STATES.has(t.state));
    if (dead.length > 0) {
      const root = dead.filter((t) => t.failureCategory !== 'dependency_failed');
      const stops = (root.length > 0 ? root : dead).map((t) => `${t.id} is ${t.state}${t.failureCategory ? ` [${t.failureCategory}]` : ''}: ${t.stateReason ?? 'no reason recorded'}`);
      const partial = required.filter((t) => t.state === 'DONE').map((t) => t.id);
      stops.push(`partial integration: ${partial.length > 0 ? `${partial.join(', ')} are integrated on lead-integration/${batchId}` : 'nothing was integrated'}; main is untouched`);
      const outcome = stop('ESCALATED', 'EXECUTING', 'task_dead_end', stops);
      if (outcome.phase === 'ESCALATED') suggest('task_dead_end', () => suggestForDeadTasks(store, { objectiveId, batchId, tasks: root, actor: DRIVER }));
      return outcome;
    }
    // a required task that reached DONE but whose implementation was reverted since is not part of the integrated result:
    // the objective cannot be accepted on its strength, and nothing in the lifecycle re-does it by itself
    const reverted = required.filter((t) => t.state === 'DONE' && store.isReverted(t.id));
    if (reverted.length > 0) return stop('ESCALATED', 'EXECUTING', 'task_reverted', reverted.map((t) => `${t.id} is DONE but its implementation was reverted: ${store.integrationFacts(t.id).at(-1)?.reason ?? 'no reason recorded'}. Reinstate it (lead integration reinstate) or re-plan; the objective is not accepted meanwhile`));
    if (awaiting.length > 0) return stop('AWAITING_OPERATOR', 'EXECUTING', 'repair_needs_operator_authorization', awaiting);
    if (required.every((t) => t.state === 'DONE')) {
      try {
        lc = lifecycle.transition(objectiveId, 'ACCEPTING', { actor, expectFrom: 'EXECUTING', reason: `all ${required.length} required task(s) are DONE and integrated`, detail: { tasks: required.map((t) => t.id) } });
      } catch (err) {
        if (err instanceof LifecycleError && err.code === 'phase_mismatch') return summarize(phaseNow(), rounds);
        throw err;
      }
      break;
    }
    if (signature() === before) {
      const waiting = required.filter((t) => t.state !== 'DONE').map((t) => `${t.id} is ${t.state}${t.state === 'BACKLOG' ? ` (${store.dependencyStatus(t).waitingOn.map((w) => `${w.id} ${w.state}`).join(', ') || 'waiting'})` : ''}`);
      return stop('ESCALATED', 'EXECUTING', 'stalled', [`a full round changed nothing and ${waiting.length} required task(s) are not DONE: ${waiting.join('; ')}`]);
    }
  }

  if (lc.phase !== 'ACCEPTING') return summarize(lc, rounds);

  // 5. independent acceptance
  let record: AcceptanceRecord;
  try {
    record = await runAcceptance({ store, lifecycle, worktrees, run: deps.run }, objectiveId);
  } catch (err) {
    return stop('ESCALATED', 'ACCEPTING', 'acceptance_error', [`the acceptance run failed to start: ${(err as Error).message}`]);
  }
  await deps.hooks?.beforeAcceptanceCommit?.(record);
  const result = { reason: record.reason, detail: record.detail, acceptance: record, provenance: provenance(store, batchId), repairs: repairs(store, batchId), stops: record.verdict === 'ACCEPTED' ? [] : [record.detail] };
  try {
    lc = lifecycle.transition(objectiveId, record.verdict, { actor: 'lifecycle-acceptance', expectFrom: 'ACCEPTING', reason: `${record.reason}: ${record.detail}`, detail: { evidenceHash: record.evidenceHash }, result });
  } catch (err) {
    if (!(err instanceof LifecycleError && err.code === 'phase_mismatch')) throw err;
    // The lifecycle was cancelled (or stopped) while the oracle ran: the run is evidence, never a verdict.
    lifecycle.audit(objectiveId, 'lifecycle-acceptance', 'acceptance_discarded', `the objective left ACCEPTING while the oracle ran (now ${phaseNow().phase}); the ${record.verdict} result is kept as evidence only`, { evidenceHash: record.evidenceHash, wouldHaveBeen: record.verdict });
    return summarize(phaseNow(), rounds, record);
  }
  log(`objective ${objectiveId}: ${record.verdict} (${record.reason})`);
  if (record.verdict === 'NOT_ACCEPTED') suggest('not_accepted', () => suggestForRejectedObjective(store, { objectiveId, batchId, detail: record.detail, evidenceHash: record.evidenceHash, actor: 'lifecycle-acceptance' }));
  if (deps.evidenceDir) {
    await mkdir(deps.evidenceDir, { recursive: true });
    await writeFile(join(deps.evidenceDir, `lifecycle-verdict-${objectiveId}.json`), `${JSON.stringify({ objectiveId, verdict: record.verdict, ...result, events: lifecycle.events(objectiveId) }, null, 2)}\n`);
  }
  return summarize(lc, rounds, record);
}

/** Which review verdicts were recorded for a task: the hash and verdict of each, newest last. */
function reviewTrail(task: TaskRow): { verdict: string; verdictHash: string; reviewId: number }[] {
  return ((task.artifacts.verifiedReviews as ReviewVerdict[] | undefined) ?? []).map((v) => ({ verdict: v.verdict, verdictHash: v.verdictHash, reviewId: v.reviewId }));
}

function provenance(store: SchedulerStore, batchId: string) {
  return requiredTasks(store, batchId).map((t) => ({
    taskId: t.id,
    correctionOf: t.correctionOf,
    runIds: t.runIds,
    claimEpoch: t.claimEpoch,
    workerHead: t.headCommit,
    integratedCommit: (t.artifacts.integration as { integratedCommit?: string } | undefined)?.integratedCommit ?? null,
    reviews: reviewTrail(t),
  }));
}

function repairs(store: SchedulerStore, batchId: string) {
  return store.listTasks({ batchId }).filter((t) => t.correctionOf !== null).map((t) => ({ correction: t.id, of: t.correctionOf, state: t.state, feedback: t.spec.request?.contract.objective.split('\n').slice(-1)[0] ?? null }));
}

/** Verifies every pending review of the batch and applies the verdict through the existing review decision. Returns the repairs waiting for the operator. */
async function reviewRound(deps: LifecycleDeps, objectiveId: string, batchId: string): Promise<string[]> {
  const { store, lifecycle } = deps;
  const log = deps.log ?? (() => {});
  const awaiting: string[] = [];
  for (const { task } of pendingReviews(store).filter(({ task: t }) => t.batchId === batchId)) {
    if (lifecycle.require(objectiveId).phase !== 'EXECUTING') break;
    let verdict: ReviewVerdict;
    try {
      verdict = await verifyReview({ store, worktrees: deps.worktrees, run: deps.run, acknowledgeWarnings: deps.acknowledgeWarnings, approvals: deps.approvals, knowledgeCatalog: deps.knowledgeCatalog }, task.id);
    } catch (err) {
      lifecycle.audit(objectiveId, REVIEWER, 'review_error', `${task.id}: the review could not be performed: ${(err as Error).message}`);
      continue; // changed under us (cancelled, decided elsewhere); the next round sees its new state
    }
    // The full evidence is written BEFORE any decision, so a decision can always be traced to what it was based on.
    store.transact(() => {
      const prior = (store.requireTask(task.id).artifacts.verifiedReviews as unknown[] | undefined) ?? [];
      store.setArtifacts(task.id, { verifiedReviews: [...prior, verdict] });
      store.audit(task.id, REVIEWER, `verified review #${verdict.reviewId}: ${verdict.verdict}${verdict.reasons.length ? ` (${verdict.reasons.join(', ')})` : ''}`, { verdictHash: verdict.verdictHash, reviewId: verdict.reviewId });
      lifecycle.audit(objectiveId, REVIEWER, 'review', `${task.id}: ${verdict.verdict}${verdict.reasons.length ? ` (${verdict.reasons.join(', ')})` : ''}`, { taskId: task.id, verdict: verdict.verdict, verdictHash: verdict.verdictHash, reasons: verdict.reasons });
    });
    await deps.hooks?.beforeDecision?.(verdict);

    // Decide in ONE transaction that also re-reads the lifecycle phase and the task: a cancel that lands anywhere before this
    // point (it writes the phase first) makes the decision impossible, and so does any change to the reviewed result.
    const applied = store.transact((): 'applied' | 'discarded' | 'awaiting_operator' => {
      if (lifecycle.require(objectiveId).phase !== 'EXECUTING') return 'discarded';
      const fresh = store.requireTask(task.id);
      if (fresh.state !== 'REVIEW_PENDING' || fresh.headCommit !== task.headCommit || fresh.claimEpoch !== task.claimEpoch) return 'discarded';
      const config = deps.config;
      if (verdict.verdict === 'APPROVE') {
        reviewDecision(store, config, { taskId: task.id, decision: 'APPROVED', reviewer: REVIEWER, feedback: `verified review ${verdict.verdictHash.slice(0, 12)}: ${verdict.checks.filter((c) => c.ok && c.class !== 'info').length} evidence check(s) passed, independent verifier passed` });
        return 'applied';
      }
      if (verdict.verdict === 'ESCALATE') {
        reviewDecision(store, config, { taskId: task.id, decision: 'ESCALATED_TO_HUMAN', reviewer: REVIEWER, feedback: `verified review ${verdict.verdictHash.slice(0, 12)} cannot approve: ${verdict.reasons.join(', ')}. ${verdict.checks.filter((c) => !c.ok && c.class === 'evidence').map((c) => `${c.name}: ${c.detail}`).join(' | ').slice(0, 1200)}` });
        return 'applied';
      }
      // REPAIR_REQUIRED: a correction task, within the task's existing correction budget. A paid provider never gets one on its own.
      const paid = providerOfSpec(fresh.spec) !== DEFAULT_PROVIDER_ID;
      const budgetLeft = fresh.corrections < config.maxReviewCorrections;
      if (paid && budgetLeft && !lifecycle.consumeAuthorization(objectiveId, 'repair', rootTaskId(fresh.id), REVIEWER)) return 'awaiting_operator';
      reviewDecision(store, config, { taskId: task.id, decision: 'REJECTED_WITH_FEEDBACK', reviewer: REVIEWER, feedback: verdict.feedback ?? verdict.reasons.join(', ') });
      lifecycle.audit(objectiveId, REVIEWER, 'repair', budgetLeft ? `${task.id}: correction ${fresh.corrections + 1}/${config.maxReviewCorrections} created` : `${task.id}: correction budget (${config.maxReviewCorrections}) exhausted; escalated instead of repaired`, { taskId: task.id, verdictHash: verdict.verdictHash, paid });
      return 'applied';
    });
    if (applied === 'awaiting_operator') {
      const line = `${task.id} needs a repair on paid provider "${providerOfSpec(task.spec)}": authorize it with: lead lifecycle authorize ${objectiveId} ${rootTaskId(task.id)} --reason "..."`;
      lifecycle.audit(objectiveId, REVIEWER, 'repair_awaiting_operator', line, { taskId: task.id, verdictHash: verdict.verdictHash });
      awaiting.push(line);
    } else if (applied === 'discarded') {
      lifecycle.audit(objectiveId, REVIEWER, 'review_discarded', `${task.id}: the objective or the task changed before the ${verdict.verdict} verdict could be applied; nothing was decided`, { taskId: task.id, verdictHash: verdict.verdictHash });
      log(`${task.id}: ${verdict.verdict} verdict discarded (state changed)`);
    }
  }
  return awaiting;
}

async function integrationRound(deps: LifecycleDeps, objectiveId: string, batchId: string): Promise<void> {
  const { store, lifecycle, worktrees } = deps;
  if (store.listTasks({ batchId, states: ['APPROVED', 'INTEGRATING'] }).length === 0) return;
  await deps.hooks?.beforeIntegration?.();
  if (lifecycle.require(objectiveId).phase !== 'EXECUTING') return;
  const { reports, locked } = await integrateBatch(store, worktrees, { batchId, run: deps.run, actor: INTEGRATOR, log: deps.log });
  if (locked) lifecycle.audit(objectiveId, INTEGRATOR, 'integration', 'another integrator holds the repository lock; nothing was integrated this round');
  for (const r of reports) {
    lifecycle.audit(objectiveId, INTEGRATOR, 'integration', `${r.taskId}: ${r.outcome}${r.category ? ` [${r.category}]` : ''}${r.detail ? ` ${r.detail.slice(0, 300)}` : ''}${r.integratedCommit ? ` -> ${r.integratedCommit.slice(0, 10)}` : ''}`, {
      taskId: r.taskId,
      outcome: r.outcome,
      category: r.category ?? null,
      integratedCommit: r.integratedCommit ?? null,
      commands: (r.commands ?? []).map((c) => ({ command: c.command, exitCode: c.exitCode })),
      conflictFiles: r.conflict?.files ?? null,
    });
  }
}

/** An explicit operator resume from AWAITING_OPERATOR or ESCALATED. The reason is mandatory and part of the audit trail. */
export function resumeObjective(lifecycle: LifecycleStore, objectiveId: string, input: { actor: string; reason: string }): LifecycleRow {
  if (!input.reason.trim()) throw new LifecycleError('invalid', 'a resume needs a reason (it is part of the audit trail)');
  return lifecycle.transition(objectiveId, 'EXECUTING', { actor: input.actor, expectFrom: ['AWAITING_OPERATOR', 'ESCALATED'], reason: `resumed by operator: ${input.reason}` });
}

export interface CancelObjectiveResult {
  lifecycle: LifecycleRow;
  alreadyFinal: boolean;
  tasks: { taskId: string; outcome: 'cancelled' | 'already_final' | 'not_cancellable'; run?: CancelRunResult['outcome']; detail?: string }[];
  /** True only when every cancelled task's run is confirmed stopped (or never existed). */
  clean: boolean;
}

/**
 * Cancels an objective in the only safe order: the lifecycle phase first (the fence every later step re-reads, so a result,
 * a review verdict or an oracle run that completes afterwards can no longer become a decision), then the scheduler is told to
 * stop, then every task is cancelled through the existing `cancelTask` (state first, then the run, confirmed).
 */
export async function cancelObjective(deps: Pick<LifecycleDeps, 'store' | 'lifecycle' | 'scheduler' | 'executor' | 'capacity' | 'log'>, objectiveId: string, input: { actor: string; reason: string }): Promise<CancelObjectiveResult> {
  const { store, lifecycle } = deps;
  if (!input.reason.trim()) throw new LifecycleError('invalid', 'a cancellation needs a reason (it is part of the audit trail)');
  const before = lifecycle.require(objectiveId);
  const alreadyFinal = FINAL_PHASES.includes(before.phase) && before.phase !== 'CANCELLED';
  if (alreadyFinal) return { lifecycle: before, alreadyFinal, tasks: [], clean: true };
  if (before.phase !== 'CANCELLED') lifecycle.transition(objectiveId, 'CANCELLED', { actor: input.actor, reason: input.reason, result: { reason: 'cancelled', detail: input.reason, stops: [] } });
  deps.scheduler.stop?.();
  const tasks: CancelObjectiveResult['tasks'] = [];
  for (const task of store.listTasks({ batchId: before.batchId })) {
    if (task.state === 'DONE' || task.state === 'CANCELLED') {
      tasks.push({ taskId: task.id, outcome: 'already_final' });
      continue;
    }
    if (!TRANSITIONS[task.state].includes('CANCELLED')) {
      tasks.push({ taskId: task.id, outcome: 'not_cancellable', detail: `${task.state} cannot be cancelled; it settles on its own (an integration in flight ends DONE or ESCALATED)` });
      continue;
    }
    const r = await cancelTask(store, { taskId: task.id, actor: input.actor, reason: `objective ${objectiveId} cancelled: ${input.reason}`, executor: deps.executor ?? {}, capacity: deps.capacity, log: deps.log });
    tasks.push({ taskId: task.id, outcome: 'cancelled', run: r.run.outcome, detail: r.run.detail });
  }
  const clean = tasks.every((t) => t.outcome !== 'cancelled' || t.run === 'stopped' || t.run === 'no_run');
  lifecycle.audit(objectiveId, input.actor, 'cancel', `cancelled: ${tasks.filter((t) => t.outcome === 'cancelled').length} task(s) cancelled, ${tasks.filter((t) => t.outcome === 'not_cancellable').length} not cancellable; runs ${clean ? 'confirmed stopped' : 'NOT all confirmed stopped'}`, { tasks });
  return { lifecycle: lifecycle.require(objectiveId), alreadyFinal: false, tasks, clean };
}


/**
 * The invocation path from a runtime-verified task to read-only specialist reviews.
 *
 * Before this module the specialist workflow could be registered and unit-tested but nothing in the lifecycle called it. This is the
 * caller: given a task the scheduler has moved to REVIEW_PENDING (the runtime verifier already produced PASS), it selects the
 * specialists that fit the task through the existing capability gate, runs the existing specialist-review workflow for each one
 * (bounded count, one at a time, read-only), contains every failure as a recorded status, and optionally consolidates the
 * runtime-signed findings.
 *
 * What it can never do: approve, pass, merge or change the task state. The summary has no verdict field; `advisory` is the literal
 * `true`. The decision stays with the Engineering Lead and the runtime verifier.
 */
import { agentsForTask } from '../../runtime/knowledge/packs/agents.ts';
import type { PackRegistry } from '../../runtime/knowledge/packs/loader.ts';
import type { TaskLanguage, TaskType } from '../../runtime/knowledge/packs/schema.ts';
import { consolidateReviewFindings, type ConsolidatedFinding, type FindingPayload, type RejectedStatement } from '../../runtime/knowledge/engineering-review-consensus.ts';
import type { SignedStatement, TrustedKeyring } from '../../runtime/knowledge/trust.ts';
import type { createSpecialistReviewWorkflow } from './workflows/specialist-review-workflow.ts';

export const MAX_SPECIALISTS_PER_REVIEW = 3;

/** The slice of a scheduler task this module needs. A structural type, so the runtime's row type is not imported. */
export interface VerifiedTaskLike {
  id: string;
  state: string;
  worktreePath: string | null;
  spec: { request?: { contract: { objective: string; allowedFiles: readonly string[] } } };
}

export interface SpecialistReviewRequest {
  taskId: string;
  /** Absolute path of the verified task's worktree. Must lie inside the workflow's allowed roots. */
  repository: string;
  language: TaskLanguage;
  objective: string;
  focusPaths: readonly string[];
  reviewId?: string;
  taskType?: TaskType;
}

export type RunRecord = Readonly<{
  specialistId: string;
  status: string;
  workflowRunId: string | null;
  inferenceCalls: number;
  findingCount: number;
  reasons: readonly string[];
}>;

export interface SpecialistReviewSummary {
  /** Always true: nothing here is a decision. There is deliberately no `verdict`, `approved` or `passed` field. */
  readonly advisory: true;
  readonly reviewId: string;
  readonly taskId: string;
  readonly selected: readonly string[];
  readonly skippedForCap: readonly string[];
  readonly runs: readonly RunRecord[];
  readonly findingStatements: readonly SignedStatement<FindingPayload>[];
  readonly consolidated?: { findings: readonly ConsolidatedFinding[]; rejected: readonly RejectedStatement[] };
}

/** Only a task the runtime has verified and parked for review is reviewed; the worktree must exist. Otherwise: an explicit refusal. */
export function reviewRequestFromTask(task: VerifiedTaskLike, options: { language: TaskLanguage; reviewId?: string }): SpecialistReviewRequest {
  if (task.state !== 'REVIEW_PENDING') throw new Error(`specialist review needs a runtime-verified task in REVIEW_PENDING; ${task.id} is ${task.state}`);
  if (!task.worktreePath) throw new Error(`task ${task.id} has no worktree to review`);
  const contract = task.spec.request?.contract;
  if (!contract) throw new Error(`task ${task.id} has no delegation contract`);
  return { taskId: task.id, repository: task.worktreePath, language: options.language, objective: contract.objective, focusPaths: contract.allowedFiles, ...(options.reviewId ? { reviewId: options.reviewId } : {}) };
}

export interface SpecialistReviewRunDeps {
  workflow: ReturnType<typeof createSpecialistReviewWorkflow>;
  registry: PackRegistry;
  /** Cancels the remaining specialists; the one that is running is cancelled through the workflow's own abort handling. */
  signal?: AbortSignal;
  maxSpecialists?: number;
  /**
   * Specialists the lead wants first, in order. Only ids that fit the task are honoured (the capability gate still decides), and the
   * cap still applies. Without it the order is the gate's own (language fit, then alphabetical), which is NOT a priority order.
   */
  prefer?: readonly string[];
  /** With a keyring, runtime-signed findings are consolidated; without one the statements are returned unconsolidated. */
  keyring?: TrustedKeyring;
  now?: () => number;
}

export async function runSpecialistReviews(deps: SpecialistReviewRunDeps, request: SpecialistReviewRequest): Promise<SpecialistReviewSummary> {
  const reviewId = request.reviewId ?? `review-${request.taskId}`;
  const cap = Math.min(Math.max(1, Math.trunc(deps.maxSpecialists ?? MAX_SPECIALISTS_PER_REVIEW)), MAX_SPECIALISTS_PER_REVIEW);
  const fit = agentsForTask(deps.registry.agents, { language: request.language, taskType: request.taskType ?? 'review' });
  const preferred = (deps.prefer ?? []).filter((id, i, all) => fit.includes(id) && all.indexOf(id) === i);
  const ordered = [...preferred, ...fit.filter((id) => !preferred.includes(id))];
  const selected = ordered.slice(0, cap);
  const runs: RunRecord[] = [];
  const statements: SignedStatement<FindingPayload>[] = [];

  for (const specialistId of selected) {
    if (deps.signal?.aborted) { runs.push({ specialistId, status: 'CANCELED', workflowRunId: null, inferenceCalls: 0, findingCount: 0, reasons: ['canceled before this specialist started'] }); continue; }
    try {
      const run = await deps.workflow.createRun();
      const result = await run.start({ inputData: { specialistId, repository: request.repository, taskId: request.taskId, language: request.language, taskType: request.taskType ?? 'review', objective: request.objective, focusPaths: [...request.focusPaths], reviewId } as never });
      if (result.status !== 'success' || !result.result) {
        runs.push({ specialistId, status: 'WORKFLOW_ERROR', workflowRunId: run.runId ?? null, inferenceCalls: 0, findingCount: 0, reasons: [`workflow ended with status ${result.status}`] });
        continue;
      }
      const r = result.result as { status: string; workflowRunId: string; inferenceCalls: number; reasons: string[]; report: { findings: unknown[] } | null; findingStatements: unknown[] };
      statements.push(...(r.findingStatements as SignedStatement<FindingPayload>[]));
      runs.push({ specialistId, status: r.status, workflowRunId: r.workflowRunId, inferenceCalls: r.inferenceCalls, findingCount: r.report?.findings.length ?? 0, reasons: r.reasons });
    } catch (err) {
      // One specialist failing must not stop the others or the lead; it is recorded and the next one runs.
      runs.push({ specialistId, status: 'WORKFLOW_ERROR', workflowRunId: null, inferenceCalls: 0, findingCount: 0, reasons: [String((err as Error)?.message ?? err).slice(0, 300)] });
    }
  }

  const consolidated = deps.keyring && statements.length
    ? consolidateReviewFindings(statements, { keyring: deps.keyring, reviewId, now: (deps.now ?? Date.now)() })
    : undefined;
  return Object.freeze({ advisory: true as const, reviewId, taskId: request.taskId, selected, skippedForCap: ordered.slice(cap), runs: Object.freeze(runs), findingStatements: Object.freeze(statements), ...(consolidated ? { consolidated } : {}) });
}

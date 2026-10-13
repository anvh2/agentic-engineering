import { join } from 'node:path';
import { toBatchPlan, batchTaskId } from './export.ts';
import { ARTIFACTS, objectiveDir, readJsonIfPresent, writeJson } from './plan-objective.ts';
import { headCommit, requireGitRoot } from './readonly-repo.ts';
import { engineeringObjectiveSchema, engineeringPlanSchema, researchContextSchema } from './types.ts';
import { validatePlan } from './validate.ts';

/**
 * SUBMIT: the one explicit step between PLAN and EXECUTE. It queues a validated plan as a scheduler batch and executes
 * nothing (running is `lead run`). It is also the single place a plan meets the present: the plan was researched against
 * `baseCommit`, so a repository that has moved on since is refused (STALE_PLAN) rather than executed. The base is never
 * rewritten and the plan is never rebased: the Lead researches and plans again.
 */

export class StalePlanError extends Error {
  readonly code = 'STALE_PLAN';
  readonly planCommit: string;
  readonly headCommit: string;
  constructor(objectiveId: string, planCommit: string, head: string) {
    super(`STALE_PLAN: objective "${objectiveId}" was planned on ${planCommit.slice(0, 10)} but the repository is now at ${head.slice(0, 10)}; research and plan again (lead objective <file>)`);
    this.name = 'StalePlanError';
    this.planCommit = planCommit;
    this.headCommit = head;
  }
}

export class PlanNotSubmittableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanNotSubmittableError';
  }
}

/** The part of SchedulerStore that submitting needs. A structural type keeps planning free of any scheduler import. */
export interface BatchSink {
  createBatch(plan: ReturnType<typeof toBatchPlan>): unknown;
  promote(actor?: string, scope?: { batchId?: string }): { ready: string[]; blocked: string[] };
}

export interface SubmitOutcome {
  batchId: string;
  dir: string;
  ready: string[];
  blocked: string[];
  tasks: { planId: string; taskId: string; owner: string }[];
}

export async function submitObjective(workdir: string, objectiveId: string, sink: BatchSink, options: { now?: () => Date } = {}): Promise<SubmitOutcome> {
  const dir = objectiveDir(workdir, objectiveId);
  const [rawObjective, rawPlan, rawResearch] = await Promise.all([ARTIFACTS.objective, ARTIFACTS.plan, ARTIFACTS.research].map((f) => readJsonIfPresent(join(dir, f))));
  if (rawObjective === undefined) throw new PlanNotSubmittableError(`no objective "${objectiveId}" under ${dir}`);
  if (rawPlan === undefined) throw new PlanNotSubmittableError(`objective "${objectiveId}" has no valid plan (${join(dir, ARTIFACTS.plan)} is missing): plan it first`);
  const objective = engineeringObjectiveSchema.parse(rawObjective);
  const research = rawResearch === undefined ? undefined : researchContextSchema.parse(rawResearch);
  const stored = engineeringPlanSchema.parse(rawPlan);

  // 1. freshness, before anything is validated or persisted
  const repoRoot = await requireGitRoot(stored.repository);
  const head = await headCommit(repoRoot);
  if (head !== stored.baseCommit) throw new StalePlanError(objectiveId, stored.baseCommit, head);

  // 2. plan.json is a file a human may have edited: re-validate it instead of trusting its embedded verdict
  const { plan, validation } = await validatePlan(rawPlan, { repoRoot, research });
  if (!validation.ok) throw new PlanNotSubmittableError(`plan is no longer valid: ${validation.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`);
  if (!validation.executable) throw new PlanNotSubmittableError(`plan needs a human decision first: ${validation.pendingDecisions.map((d) => `${d.taskId}: ${d.question}`).join('; ')}`);

  // 3. queue it (createBatch re-checks ids, dependencies and cycles; a second submit is a duplicate-batch error)
  const batch = toBatchPlan(objective, plan!, validation);
  sink.createBatch(batch);
  const promoted = sink.promote('objective-submit', { batchId: batch.batchId });
  const outcome: SubmitOutcome = {
    batchId: batch.batchId,
    dir,
    ready: promoted.ready,
    blocked: promoted.blocked,
    tasks: plan!.tasks.map((t) => ({ planId: t.id, taskId: batchTaskId(objective.id, t.id), owner: t.executionOwner })),
  };
  await writeJson(join(dir, ARTIFACTS.submitted), { ...outcome, submittedAt: (options.now?.() ?? new Date()).toISOString(), baseCommit: stored.baseCommit, headAtSubmit: head });
  return outcome;
}

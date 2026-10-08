import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toBatchPlan } from './export.ts';
import { LeadResponseError } from './lead-prompt.ts';
import { assertUnchanged, requireGitRoot } from './readonly-repo.ts';
import { engineeringObjectiveSchema, researchContextSchema, type EngineeringLead, type EngineeringObjective, type EngineeringPlan, type ResearchContext } from './types.ts';
import { validatePlan, type PlanIssue, type PlanValidation } from './validate.ts';

/**
 * PLAN, never EXECUTE. This is the whole of M7.5's orchestration:
 *
 *   objective -> lead.research -> research.json -> lead.plan -> validate -> plan.json (+ batch.json)
 *
 * It imports no scheduler store, worktree manager, executor or worker, and every call into the Lead runs inside a
 * repository fingerprint guard. Its only writes are artifacts under `<workdir>/objectives/<id>/`; batch.json is a file a
 * human (or M8) later hands to the existing `lead plan`.
 */

export class ObjectiveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectiveConflictError';
  }
}

export const objectiveDir = (workdir: string, objectiveId: string): string => join(workdir, 'objectives', objectiveId);

export const ARTIFACTS = {
  objective: 'objective.json',
  research: 'research.json',
  draft: 'draft.json',
  plan: 'plan.json',
  batch: 'batch.json',
  rejected: 'plan.rejected.json',
  submitted: 'submitted.json',
} as const;

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

export async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

const sameContent = (a: unknown, b: unknown): boolean => createHash('sha256').update(JSON.stringify(a)).digest('hex') === createHash('sha256').update(JSON.stringify(b)).digest('hex');

export type PlanOutcome =
  | { status: 'researched'; dir: string; research: ResearchContext; reason: string }
  | { status: 'rejected'; dir: string; research: ResearchContext; plan?: EngineeringPlan; validation: PlanValidation; revisions: number }
  | { status: 'planned'; dir: string; research: ResearchContext; plan: EngineeringPlan; validation: PlanValidation; batchPath?: string; revisions: number };

export interface PlanObjectiveOptions {
  workdir: string;
  now?: () => Date;
  /** How many times to ask a Lead that can `revise` to repair a rejected draft. Default 0: one attempt, no loop. */
  maxRevisions?: number;
}

/**
 * Runs research (always) and planning (when the Lead can produce a draft). `onMissingDraft` lets a hand-off Lead say
 * "not yet" without that being an error: the outcome is `researched` and the research artifact is already on disk.
 */
export async function planObjective(
  objectiveInput: unknown,
  lead: EngineeringLead,
  options: PlanObjectiveOptions,
  isMissingDraft: (err: unknown) => boolean = () => false,
): Promise<PlanOutcome> {
  const objective: EngineeringObjective = engineeringObjectiveSchema.parse(objectiveInput);
  const repoRoot = await requireGitRoot(objective.repository);
  const dir = objectiveDir(options.workdir, objective.id);

  // The objective is the identity of its directory: a different objective under the same id is a mistake, not an edit.
  const existing = await readJsonIfPresent(join(dir, ARTIFACTS.objective));
  if (existing !== undefined && !sameContent(existing, objective)) {
    throw new ObjectiveConflictError(`objective "${objective.id}" already exists with different content (${join(dir, ARTIFACTS.objective)}); use a new id`);
  }
  const resolved = { ...objective, repository: repoRoot };

  const research = researchContextSchema.parse(await assertUnchanged(repoRoot, 'research', () => lead.research(resolved)));
  await writeJson(join(dir, ARTIFACTS.objective), objective);
  await writeJson(join(dir, ARTIFACTS.research), research);

  let draft: unknown;
  try {
    draft = await assertUnchanged(repoRoot, 'planning', () => lead.plan(resolved, research));
  } catch (err) {
    if (isMissingDraft(err)) return { status: 'researched', dir, research, reason: (err as Error).message };
    throw err;
  }

  const stamp = (d: unknown) => ({
    ...(d && typeof d === 'object' ? d : {}),
    schema: 'agentic.plan/1',
    objectiveId: objective.id,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    producedBy: lead.name,
    baseCommit: research.commit,
    repository: repoRoot,
  });
  let candidate = stamp(draft);
  let result = await validatePlan(candidate, { repoRoot, research });
  // The Lead proposes, the validator disposes: a rejected draft may be sent back with the validator's complaints, a bounded
  // number of times, and every attempt must pass the same gate. Nothing the Lead says skips validation.
  const history: { draft: unknown; errors: PlanIssue[] }[] = [];
  while (!result.validation.ok && lead.revise && history.length < (options.maxRevisions ?? 0)) {
    history.push({ draft: candidate, errors: result.validation.errors });
    let revised: unknown;
    try {
      revised = await assertUnchanged(repoRoot, 'revision', () => lead.revise!(resolved, research, draft, result.validation.errors));
    } catch (err) {
      if (err instanceof LeadResponseError) break; // an unreadable reply ends the loop; the last verdict stands
      throw err;
    }
    draft = revised;
    candidate = stamp(draft);
    result = await validatePlan(candidate, { repoRoot, research });
  }
  const { plan, validation } = result;
  const revisions = history.length;

  // a stale verdict from an earlier run must never sit beside a newer one
  await rm(join(dir, ARTIFACTS.batch), { force: true });
  if (!validation.ok) {
    await rm(join(dir, ARTIFACTS.plan), { force: true });
    await writeJson(join(dir, ARTIFACTS.rejected), { draft: candidate, validation, revisions, history });
    return { status: 'rejected', dir, research, plan, validation, revisions };
  }
  await rm(join(dir, ARTIFACTS.rejected), { force: true });
  await writeJson(join(dir, ARTIFACTS.plan), { ...plan, validation, revisions });
  let batchPath: string | undefined;
  if (validation.executable) {
    batchPath = join(dir, ARTIFACTS.batch);
    await writeJson(batchPath, toBatchPlan(objective, plan!, validation));
  }
  return { status: 'planned', dir, research, plan: plan!, validation, batchPath, revisions };
}

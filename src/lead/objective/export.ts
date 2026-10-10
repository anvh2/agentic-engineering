import { basename } from 'node:path';
import { batchPlanSchema, taskSpecSchema, type BatchPlan, type TaskSpecInput } from '../../runtime/scheduler/types.ts';
import { describeCapacity, resolveCapacity } from '../../runtime/execution/delegation-capacity.ts';
import type { PlanValidation } from './validate.ts';
import type { EngineeringObjective, EngineeringPlan, PlannedTask } from './types.ts';

/**
 * EngineeringPlan -> the scheduler's EXISTING contract (BatchPlan). Nothing new crosses the M7 boundary: the output is
 * exactly what `lead plan <file>` / SchedulerStore.createBatch already accept, and it is produced as DATA. This module
 * never imports the scheduler store, a worktree manager or an executor; submitting is a separate, explicit act.
 */

export class PlanNotExecutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanNotExecutableError';
  }
}

/**
 * Scheduler task ids are unique across ALL batches (SchedulerStore.insertTask) while a plan's task ids are only unique
 * within the plan ("t1" is a natural choice for every plan). The batch id is the objective id, so namespacing with it
 * is collision-free and reversible; plan.json keeps the Lead's short ids.
 */
export const batchTaskId = (objectiveId: string, planTaskId: string): string => `${objectiveId}.${planTaskId}`;

/** What a Claude-kept task carries into the backlog: TaskSpec has no acceptance/verification fields for tasks without a worker contract. */
function briefFor(task: PlannedTask): string {
  const lines = [task.assessment.rationale, '', task.description];
  if (task.acceptanceCriteria.length > 0) lines.push('', 'Acceptance criteria:', ...task.acceptanceCriteria.map((c) => `- ${c}`));
  if (task.constraints.length > 0) lines.push('', 'Constraints:', ...task.constraints.map((c) => `- ${c}`));
  if (task.verificationCommands.length > 0) lines.push('', 'Verify with:', ...task.verificationCommands.map((c) => `- ${c.join(' ')}`));
  return lines.join('\n');
}

function specFor(objectiveId: string, task: PlannedTask): TaskSpecInput {
  const id = batchTaskId(objectiveId, task.id);
  const base = {
    id,
    title: task.title,
    dependsOn: task.dependsOn.map((d) => batchTaskId(objectiveId, d)),
    kind: 'implementation' as const,
    risk: task.assessment.risk,
    complexity: task.assessment.complexity,
    ...(task.priority === undefined ? {} : { priority: task.priority }),
  };
  if (task.executionOwner === 'LOCAL_WORKER') {
    return {
      ...base,
      executor: 'worker',
      request: {
        contract: {
          taskId: id,
          objective: task.description,
          allowedFiles: task.allowedFiles,
          contextFiles: task.contextFiles,
          acceptanceCriteria: task.acceptanceCriteria,
          verificationCommands: task.verificationCommands,
          constraints: task.constraints,
          hiddenFiles: task.hiddenFiles,
        },
        assessment: task.assessment,
      },
      ...(task.capacity ? { capacity: task.capacity } : {}),
    };
  }
  // Lead-kept work carries no worker contract: its verification commands are not injected into the integrator's checks
  // (they would run after every later integration), and the full brief travels in keptReason instead.
  return { ...base, executor: 'claude', keptReason: briefFor(task), ownedFiles: task.allowedFiles };
}

/** Throws PlanNotExecutableError unless the validation says the plan may become a batch. */
export function toBatchPlan(objective: Pick<EngineeringObjective, 'id' | 'title'>, plan: EngineeringPlan, validation: PlanValidation): BatchPlan {
  if (!validation.ok) throw new PlanNotExecutableError(`plan is invalid: ${validation.errors.map((e) => e.message).join('; ')}`);
  if (!validation.executable) {
    throw new PlanNotExecutableError(`plan needs a human decision before it can execute: ${validation.pendingDecisions.map((d) => `${d.taskId}: ${d.question}`).join('; ')}`);
  }
  const batch = batchPlanSchema.parse({
    batchId: objective.id,
    project: basename(plan.repository),
    repository: plan.repository,
    description: `${objective.title}\n\n${plan.summary}\n\n(objective ${objective.id}, planned on commit ${plan.baseCommit.slice(0, 10)} by ${plan.producedBy})`,
    baseRef: plan.baseCommit === 'unborn' ? undefined : plan.baseCommit,
    integrationCommands: plan.integrationCommands,
    linkPaths: plan.linkPaths,
    tasks: plan.tasks.map((t) => taskSpecSchema.parse(specFor(objective.id, t))),
  });
  return batch;
}

const OWNER_LABEL = { LOCAL_WORKER: 'local worker', CLAUDE_LEAD: 'Claude lead', HUMAN_DECISION: 'HUMAN DECISION' } as const;

/** A human-readable view of a plan and its validation, for inspection before anything executes. */
export function renderPlan(objective: Pick<EngineeringObjective, 'id' | 'title'>, plan: EngineeringPlan, validation: PlanValidation): string {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const out = [`Objective ${objective.id}: ${objective.title}`, `Plan by ${plan.producedBy} on ${plan.baseCommit.slice(0, 10)}: ${plan.summary}`, `Readiness: ${validation.readiness}`];
  if (plan.findings.length > 0) out.push('', 'Findings:', ...plan.findings.map((f) => `  - ${f}`));
  if (plan.risks.length > 0) out.push('', 'Risks:', ...plan.risks.map((r) => `  - ${r}`));
  out.push('', 'Tasks (each level can run in parallel):');
  (validation.levels.length > 0 ? validation.levels : [plan.tasks.map((t) => t.id)]).forEach((level, i) => {
    out.push(`  level ${i}:`);
    for (const id of level) {
      const t = byId.get(id)!;
      out.push(`    ${t.id}  [${OWNER_LABEL[t.executionOwner]}]  ${t.title}${t.dependsOn.length ? `  <- ${t.dependsOn.join(', ')}` : ''}`);
      if (t.allowedFiles.length > 0) out.push(`        files: ${t.allowedFiles.join(', ')}`);
      if (t.executionOwner === 'LOCAL_WORKER') out.push(`        capacity: ${describeCapacity(resolveCapacity(t.capacity))}`);
      if (t.executionOwner !== 'LOCAL_WORKER') out.push(`        why: ${t.assessment.rationale}`);
      if (t.decision) out.push(`        decide: ${t.decision.question}${t.decision.options.length ? ` (${t.decision.options.join(' | ')})` : ''}`);
    }
  });
  for (const e of validation.errors) out.push(`ERROR ${e.code}${e.taskId ? ` [${e.taskId}]` : ''}: ${e.message}`);
  for (const w of validation.warnings) out.push(`warning ${w.code}${w.taskId ? ` [${w.taskId}]` : ''}: ${w.message}`);
  return out.join('\n');
}

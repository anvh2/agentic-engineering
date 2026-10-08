import { z } from 'zod';
import { codingTaskSchema } from '../../runtime/execution/coding-task-runner.ts';
import { leadAssessmentSchema } from '../../runtime/execution/delegation.ts';
import type { PlanIssue } from './validate.ts';

/**
 * M7.5 Engineering Lead planning contracts.
 *
 *   EngineeringObjective  (what the Chief Architect asks for)
 *     -> ResearchContext  (read-only evidence about the target repository)
 *     -> EngineeringPlan  (a validated task DAG; PLAN, never EXECUTE)
 *     -> BatchPlan        (the existing scheduler contract, see export.ts)
 *
 * Nothing here knows about Claude, a scheduler or a worker process. Field shapes that already exist in the runtime
 * (the coding contract's paths/commands, the Lead's assessment) are reused rather than redefined.
 */

/** A directory-safe identifier: also the scheduler batch id, so it must satisfy the scheduler's batch/task id rule. */
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be [A-Za-z0-9._-] and start with a letter or digit');
const repoPath = codingTaskSchema.shape.allowedFiles.element;
const argv = z.array(z.string().min(1)).min(1);

export const engineeringObjectiveSchema = z.object({
  id: identifier,
  title: z.string().min(1),
  /** The feature request in the human's own words. */
  description: z.string().min(1),
  /** Path of the target git repository (relative paths resolve against the objective file). */
  repository: z.string().min(1),
  constraints: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
});
export type EngineeringObjective = z.output<typeof engineeringObjectiveSchema>;

// ---- research ------------------------------------------------------------------------------------------------------

export const RISK_KINDS = ['security_sensitive', 'destructive_change', 'no_test_coverage', 'dirty_files', 'worker_unsupported_language', 'large_file', 'scan_truncated'] as const;

export const researchContextSchema = z.object({
  schema: z.literal('agentic.research/1'),
  objectiveId: identifier,
  generatedAt: z.string(),
  /** Absolute path of the repository that was read. */
  repository: z.string(),
  /** The commit the research describes; the plan is cut from exactly this commit. */
  commit: z.string(),
  branch: z.string().nullable(),
  /** Uncommitted paths at research time (capped). A worker task over one of these is BLOCKED at claim time. */
  dirtyFiles: z.array(z.string()),
  /** File count by language, largest first. */
  languages: z.record(z.string(), z.number().int()),
  /** Architecture boundaries: the directories that own the code, with file counts. */
  modules: z.array(z.object({ path: z.string(), files: z.number().int() })),
  manifests: z.array(z.string()),
  dependencies: z.array(z.string()),
  conventions: z.array(z.string()),
  /** Candidate verification commands read from manifests. Informational: the plan's own commands are policy-checked. */
  testCommands: z.array(argv),
  /** Paths worth symlinking into worktrees (e.g. node_modules) so verification can run. */
  linkCandidates: z.array(z.string()),
  /** Ranked by relevance to the objective; existing implementation and its tests. */
  relevantFiles: z.array(z.object({ path: z.string(), kind: z.enum(['source', 'test', 'config', 'doc']), score: z.number(), reasons: z.array(z.string()) })),
  risks: z.array(z.object({ kind: z.enum(RISK_KINDS), detail: z.string(), paths: z.array(z.string()).default([]) })),
  scan: z.object({ filesListed: z.number().int(), filesRead: z.number().int(), truncated: z.boolean() }),
});
export type ResearchContext = z.output<typeof researchContextSchema>;

// ---- plan ----------------------------------------------------------------------------------------------------------

export const EXECUTION_OWNERS = ['LOCAL_WORKER', 'CLAUDE_LEAD', 'HUMAN_DECISION'] as const;
export const executionOwnerSchema = z.enum(EXECUTION_OWNERS);
export type ExecutionOwner = z.output<typeof executionOwnerSchema>;

export const plannedTaskSchema = z.object({
  /** Becomes the scheduler task id. */
  id: z.string().regex(/^[A-Za-z0-9._-]+$/, 'task id must be [A-Za-z0-9._-]'),
  title: z.string().min(1),
  description: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  executionOwner: executionOwnerSchema,
  /** Files this task may change: the worker's mutation scope, or the Lead's ownership set. */
  allowedFiles: z.array(repoPath).default([]),
  contextFiles: z.array(repoPath).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  /** argv arrays; for a worker task the runtime runs them in the sandbox. */
  verificationCommands: z.array(argv).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  /** Runtime-owned oracle files (path -> content), never shown to the worker. */
  hiddenFiles: z.record(repoPath, z.string()).default({}),
  /** Complexity/risk/ambiguity plus the reason for the chosen owner. The same shape the delegation gate consumes. */
  assessment: leadAssessmentSchema,
  /** Required for HUMAN_DECISION tasks: what must be decided. */
  decision: z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).default([]) }).optional(),
  priority: z.number().int().min(0).max(100).optional(),
});
export type PlannedTask = z.output<typeof plannedTaskSchema>;

/** What an EngineeringLead authors. Untrusted until validated. */
export const planDraftSchema = z.object({
  summary: z.string().min(1),
  /** The Lead's reading of the research: what exists, what must change, the architectural constraints. */
  findings: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  /** Run after each task integrates (the batch's integrationCommands). */
  integrationCommands: z.array(argv).default([]),
  linkPaths: z.array(z.string()).default([]),
  tasks: z.array(plannedTaskSchema).min(1),
});
export type PlanDraft = z.output<typeof planDraftSchema>;

export const engineeringPlanSchema = planDraftSchema.extend({
  schema: z.literal('agentic.plan/1'),
  objectiveId: identifier,
  createdAt: z.string(),
  producedBy: z.string(),
  /** Commit of the research the plan is based on; also the scheduler batch's baseRef. */
  baseCommit: z.string(),
  /** Absolute repository path. */
  repository: z.string(),
});
export type EngineeringPlan = z.output<typeof engineeringPlanSchema>;

// ---- the Lead boundary ---------------------------------------------------------------------------------------------

/**
 * The one seam between planning and whoever does the thinking (Claude, a human, a script). Both methods are READ-ONLY
 * with respect to the target repository: the orchestrator fingerprints the repository around them and rejects the
 * result if anything changed. Neither starts workers or touches the scheduler.
 */
export interface EngineeringLead {
  readonly name: string;
  research(objective: EngineeringObjective): Promise<ResearchContext>;
  /** The returned draft is untrusted (it may be model output); the orchestrator parses and validates it. */
  plan(objective: EngineeringObjective, research: ResearchContext): Promise<unknown>;
  /**
   * Optional: produce a corrected draft after the deterministic validator rejected the previous one. A Lead that omits it
   * gets exactly one attempt. The orchestrator bounds how many revisions it will ask for.
   */
  revise?(objective: EngineeringObjective, research: ResearchContext, previous: unknown, issues: PlanIssue[]): Promise<unknown>;
}

import { DEFAULT_CONFIG } from '../../runtime/scheduler/types.ts';
import { integrationCommandReasons, unsafeCommandReasons, workerIneligibility } from './ownership.ts';
import { engineeringPlanSchema, type EngineeringPlan, type PlannedTask, type ResearchContext } from './types.ts';

/**
 * The gate between a Lead's draft and the scheduler. A plan that does not pass here is never written as plan.json and
 * never converted to a batch, so an invalid DAG cannot reach scheduler persistence. All problems are collected, not just
 * the first, so the Lead can repair a draft in one pass.
 */

export interface PlanIssue {
  code: string;
  taskId?: string;
  message: string;
}

export interface PlanValidation {
  /** The plan is a well-formed, policy-compliant DAG. */
  ok: boolean;
  /** ok AND no HUMAN_DECISION task remains: the only state that may become a scheduler batch. */
  executable: boolean;
  readiness: 'executable' | 'needs_human_decision' | 'invalid';
  errors: PlanIssue[];
  warnings: PlanIssue[];
  pendingDecisions: { taskId: string; question: string; options: string[] }[];
  roots: string[];
  /** A dependency-respecting order (ties broken by id). Empty when the graph is cyclic. */
  order: string[];
  /** Tasks grouped by DAG depth: everything in one group can run in parallel. */
  levels: string[][];
}

export interface ValidateContext {
  repoRoot: string;
  research?: Pick<ResearchContext, 'dirtyFiles'>;
}

/** The first dependency cycle found, as an id path ending where it started; undefined when the graph is acyclic. */
export function findCycle(tasks: Pick<PlannedTask, 'id' | 'dependsOn'>[]): string[] | undefined {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  let found: string[] | undefined;
  const visit = (id: string, path: string[]): void => {
    if (found || state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      found = [...path.slice(path.indexOf(id)), id];
      return;
    }
    state.set(id, 'visiting');
    for (const dep of deps.get(id) ?? []) if (deps.has(dep)) visit(dep, [...path, id]);
    state.set(id, 'done');
  };
  for (const id of [...deps.keys()].sort()) visit(id, []);
  return found;
}

/** Transitive dependencies of every task. Only valid on an acyclic graph with known dependencies. */
function ancestorsOf(tasks: PlannedTask[]): Map<string, Set<string>> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    memo.set(id, out);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      out.add(dep);
      for (const a of visit(dep)) out.add(a);
    }
    return out;
  };
  for (const t of tasks) visit(t.id);
  return memo;
}

function levelsOf(tasks: PlannedTask[]): string[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const of = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const d = Math.max(-1, ...(byId.get(id)?.dependsOn ?? []).map(of)) + 1;
    depth.set(id, d);
    return d;
  };
  const levels: string[][] = [];
  for (const t of tasks) (levels[of(t.id)] ??= []).push(t.id);
  return levels.map((l) => l.sort());
}

const EMPTY: Omit<PlanValidation, 'errors' | 'warnings' | 'ok' | 'executable' | 'readiness'> = { pendingDecisions: [], roots: [], order: [], levels: [] };

export async function validatePlan(input: unknown, ctx: ValidateContext): Promise<{ plan?: EngineeringPlan; validation: PlanValidation }> {
  const parsed = engineeringPlanSchema.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => ({ code: 'schema', message: `${i.path.join('.') || '(plan)'}: ${i.message}` }));
    return { validation: { ...EMPTY, ok: false, executable: false, readiness: 'invalid', errors, warnings: [] } };
  }
  const plan = parsed.data;
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  const error = (code: string, message: string, taskId?: string) => errors.push({ code, message, ...(taskId ? { taskId } : {}) });
  const warn = (code: string, message: string, taskId?: string) => warnings.push({ code, message, ...(taskId ? { taskId } : {}) });

  // --- graph structure
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) error('duplicate_id', `task id "${t.id}" is used more than once`, t.id);
    ids.add(t.id);
  }
  for (const t of plan.tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) error('self_dependency', `task "${t.id}" depends on itself`, t.id);
      else if (!ids.has(dep)) error('unknown_dependency', `task "${t.id}" depends on "${dep}", which is not in the plan`, t.id);
    }
  }
  const cycle = findCycle(plan.tasks.filter((t) => !t.dependsOn.includes(t.id)));
  if (cycle) error('dependency_cycle', `dependency cycle: ${cycle.join(' -> ')}`);
  const roots = plan.tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id).sort();
  if (roots.length === 0) error('no_root', 'the plan has no root task: at least one task must have no dependencies');

  const graphOk = !errors.some((e) => ['duplicate_id', 'self_dependency', 'unknown_dependency', 'dependency_cycle'].includes(e.code));
  const ancestors = graphOk ? ancestorsOf(plan.tasks) : new Map<string, Set<string>>();
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const filesOfAncestors = (id: string): Set<string> => {
    const files = new Set<string>();
    for (const a of ancestors.get(id) ?? []) for (const f of byId.get(a)?.allowedFiles ?? []) files.add(f);
    return files;
  };

  // --- per task
  for (const t of plan.tasks) {
    if (t.executionOwner === 'HUMAN_DECISION') {
      if (!t.decision) error('decision_missing', `HUMAN_DECISION task "${t.id}" must state the decision (question and options)`, t.id);
    } else if (t.acceptanceCriteria.length === 0) {
      error('no_acceptance_criteria', `task "${t.id}" has no acceptance criteria`, t.id);
    }
    for (const command of t.verificationCommands) for (const reason of unsafeCommandReasons(command)) error('unsafe_verification', `task "${t.id}": ${reason}`, t.id);
    if (t.executionOwner === 'CLAUDE_LEAD' && t.verificationCommands.length === 0) warn('no_verification', `Lead-owned task "${t.id}" has no verification command; its acceptance is judged by review only`, t.id);
    if (t.executionOwner === 'LOCAL_WORKER') {
      for (const r of await workerIneligibility(t, { repoRoot: ctx.repoRoot, ancestorFiles: filesOfAncestors(t.id) })) {
        error(r.kind === 'verification' ? 'unsafe_verification' : r.kind === 'scope' ? 'worker_scope_unbounded' : 'worker_not_eligible', `task "${t.id}" cannot be LOCAL_WORKER: ${r.message}`, t.id);
      }
    }
    const dirty = new Set(ctx.research?.dirtyFiles ?? []);
    const touched = t.allowedFiles.filter((f) => dirty.has(f));
    if (touched.length > 0 && t.executionOwner !== 'HUMAN_DECISION') {
      warn('allowed_file_dirty', `task "${t.id}" owns uncommitted file(s) ${touched.join(', ')}: ${t.executionOwner === 'LOCAL_WORKER' ? 'the scheduler blocks a worker task over them unless the batch snapshots them' : 'commit or snapshot them before the batch starts'}`, t.id);
    }
  }

  // --- plan level
  for (const command of plan.integrationCommands) {
    for (const reason of await integrationCommandReasons(command, ctx.repoRoot, new Set(plan.tasks.flatMap((t) => t.allowedFiles)))) error('unsafe_integration_command', reason);
  }
  // integrationCommands run after EACH task integrates, not once at the end: a whole-repository test run also executes the
  // visible tests of sibling packages whose tasks are not integrated yet, so it fails on correct work (M7 real smoke:
  // integration_verification_failed on `go test ./...`). Per-task verification already covers each package.
  if (plan.tasks.filter((t) => t.executionOwner === 'LOCAL_WORKER').length >= 2) {
    for (const command of plan.integrationCommands) {
      if (command[0] === 'go' && command[1] === 'test' && command.some((a) => a === './...' || a.endsWith('/...'))) {
        warn('integration_command_spans_unfinished_work', `integration command "${command.join(' ')}" runs after every task integrates and will also run the tests of packages whose tasks are not integrated yet, failing correct work; verify each package in its own task and keep batch commands to checks that hold at every intermediate state (e.g. "go vet ./...")`);
      }
    }
  }
  for (const link of plan.linkPaths) {
    if (link.startsWith('/') || link.split('/').includes('..') || link === '') error('bad_link_path', `linkPaths entry "${link}" must be repository-relative without ".."`);
  }
  if (graphOk) {
    // two tasks neither of which precedes the other must not claim the same file: the scheduler would serialise them silently
    const list = plan.tasks.filter((t) => t.executionOwner !== 'HUMAN_DECISION');
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (ancestors.get(a.id)?.has(b.id) || ancestors.get(b.id)?.has(a.id)) continue;
        const shared = a.allowedFiles.filter((f) => b.allowedFiles.includes(f));
        if (shared.length > 0) warn('parallel_file_overlap', `independent tasks "${a.id}" and "${b.id}" both own ${shared.join(', ')}: they cannot actually run in parallel; add a dependency`);
      }
    }
  }
  // maxTasksPerBatch bounds tasks that get CLAIMED by a worker (review corrections included); Lead-kept tasks are never claimed
  const claimed = plan.tasks.filter((t) => t.executionOwner === 'LOCAL_WORKER').length;
  if (claimed > DEFAULT_CONFIG.maxTasksPerBatch) warn('batch_too_large', `${claimed} worker tasks exceed the scheduler's default maxTasksPerBatch of ${DEFAULT_CONFIG.maxTasksPerBatch} (review corrections count too); raise it (scheduler.config.json or --max-tasks) before running`);

  // --- shape of the result
  const pendingDecisions = plan.tasks.filter((t) => t.executionOwner === 'HUMAN_DECISION' && t.decision).map((t) => ({ taskId: t.id, question: t.decision!.question, options: t.decision!.options }));
  const ok = errors.length === 0;
  const hasHuman = plan.tasks.some((t) => t.executionOwner === 'HUMAN_DECISION');
  const executable = ok && !hasHuman;
  let order: string[] = [];
  let levels: string[][] = [];
  if (graphOk) {
    levels = levelsOf(plan.tasks);
    order = levels.flat();
  }
  return { plan, validation: { ok, executable, readiness: !ok ? 'invalid' : hasHuman ? 'needs_human_decision' : 'executable', errors, warnings, pendingDecisions, roots, order, levels } };
}

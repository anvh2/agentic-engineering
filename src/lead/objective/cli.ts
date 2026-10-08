import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { renderPlan } from './export.ts';
import { ClaudeEngineeringLead, claudeCliTransport } from './claude-lead.ts';
import { DraftFileLead, DraftMissingError } from './lead.ts';
import { ARTIFACTS, objectiveDir, planObjective, readJsonIfPresent } from './plan-objective.ts';
import { PlanNotSubmittableError, StalePlanError, submitObjective, type BatchSink } from './submit.ts';
import { engineeringObjectiveSchema, engineeringPlanSchema, researchContextSchema, type EngineeringLead, type ResearchContext } from './types.ts';
import type { PlanValidation } from './validate.ts';
import { ZodError } from 'zod';

/**
 * `lead objective` : the Engineering Lead planning command. It plans; it never executes.
 *
 *   lead objective <objective.json> [--draft <draft.json>]    research (read-only), then validate the Lead's draft
 *   lead objective <objective.json> --lead claude --max-budget-usd X [--model M] [--max-revisions N]
 *        the Lead is Claude: a BILLED `claude -p` call (tools disabled), capped at X USD per call; 1 call, plus N paid revisions only if asked
 *   lead objective --show <objective-id>                      print a stored plan for review
 *   lead objective --submit <objective-id>                    queue the plan as a scheduler batch (still executes nothing)
 *
 * Exit codes: 0 ok · 1 plan rejected · 2 usage/input error · 3 research written, waiting for the Lead's draft ·
 *             4 STALE_PLAN (the repository moved since the plan was researched) or a plan that cannot be submitted.
 * Running the queued batch is a further explicit step: `lead run --batch <id>`.
 */

const MAX_BUDGET_USD = 5;
const MAX_BILLED_REVISIONS = 2;

export const USAGE = `usage:
  lead objective <objective.json> [--draft <draft.json>] [--lead draft|claude --max-budget-usd X [--model M]] [--max-revisions N]
  lead objective --show <objective-id>
  lead objective --submit <objective-id>`;

export interface ObjectiveIo {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Resolves relative objective/draft paths. */
  cwd: string;
  /** Runtime state root (`.workdir`). */
  workdir: string;
  /** Where --submit queues the batch (the scheduler store). Absent in planning-only use. */
  sink?: BatchSink;
  /** Test seam: the Lead to use. Defaults to the draft-file Lead, or Claude with `--lead claude`. */
  leadFor?: (draftPath: string, kind: 'draft' | 'claude') => EngineeringLead;
  now?: () => Date;
}

const SKELETON = `{
  "summary": "one paragraph: the approach",
  "findings": ["what exists", "what must change", "architecture constraints"],
  "risks": [],
  "integrationCommands": [],
  "linkPaths": [],
  "tasks": [{
    "id": "t1", "title": "...", "description": "...", "dependsOn": [],
    "executionOwner": "LOCAL_WORKER | CLAUDE_LEAD | HUMAN_DECISION",
    "allowedFiles": ["src/x.js"], "contextFiles": [], "acceptanceCriteria": ["..."],
    "verificationCommands": [["npx", "--no-install", "jest", "src/x.test.js"]],
    "constraints": ["Tests are immutable"],
    "assessment": { "complexity": "small", "risk": "low", "ambiguity": "none", "rationale": "why this owner" }
  }]
}`;

function renderResearch(r: ResearchContext): string {
  const out = [`Research @ ${r.commit.slice(0, 10)}${r.branch ? ` (${r.branch})` : ''}: ${r.scan.filesListed} files, ${Object.entries(r.languages).slice(0, 4).map(([l, n]) => `${l} ${n}`).join(', ') || 'no source languages'}`];
  if (r.conventions.length > 0) out.push('Conventions:', ...r.conventions.map((c) => `  - ${c}`));
  out.push(`Relevant files (${r.relevantFiles.length}):`, ...r.relevantFiles.slice(0, 12).map((f) => `  ${f.kind.padEnd(6)} ${f.path}  (${f.reasons.join('; ')})`));
  if (r.risks.length > 0) out.push('Risks:', ...r.risks.map((k) => `  - ${k.kind}: ${k.detail}${k.paths.length ? ` [${k.paths.slice(0, 4).join(', ')}]` : ''}`));
  return out.join('\n');
}

function summarize(v: PlanValidation): string {
  return `${v.errors.length} error(s), ${v.warnings.length} warning(s), ${v.levels.length} level(s), ${v.roots.length} root(s)`;
}

async function show(id: string, io: ObjectiveIo): Promise<number> {
  const dir = objectiveDir(io.workdir, id);
  const objective = await readJsonIfPresent(join(dir, ARTIFACTS.objective));
  if (objective === undefined) {
    io.err(`lead: no objective "${id}" under ${dir}`);
    return 2;
  }
  const research = await readJsonIfPresent(join(dir, ARTIFACTS.research));
  const plan = await readJsonIfPresent(join(dir, ARTIFACTS.plan));
  const rejected = await readJsonIfPresent(join(dir, ARTIFACTS.rejected));
  const parsedObjective = engineeringObjectiveSchema.parse(objective);
  if (research !== undefined) io.out(renderResearch(researchContextSchema.parse(research)));
  if (plan !== undefined) {
    const validation = (plan as { validation: PlanValidation }).validation;
    io.out(renderPlan(parsedObjective, engineeringPlanSchema.parse(plan), validation));
    return 0;
  }
  if (rejected !== undefined) {
    const { validation } = rejected as { validation: PlanValidation };
    for (const e of validation.errors) io.out(`ERROR ${e.code}${e.taskId ? ` [${e.taskId}]` : ''}: ${e.message}`);
    return 1;
  }
  io.out(`objective ${id}: no plan yet (write ${join(dir, ARTIFACTS.draft)} and re-run)`);
  return 3;
}

export async function runObjectiveCommand(argv: string[], io: ObjectiveIo): Promise<number> {
  try {
    const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
    if (argv.includes('--submit')) {
      const id = flag('--submit');
      if (!id) throw new UsageError('--submit needs an objective id');
      if (!io.sink) throw new UsageError('--submit needs the scheduler store');
      try {
        const r = await submitObjective(io.workdir, id, io.sink, { now: io.now });
        io.out(`Submitted ${r.batchId}: ${r.tasks.length} task(s); READY: ${r.ready.join(', ') || '-'}; waiting: ${r.tasks.map((t) => t.taskId).filter((t) => !r.ready.includes(t)).join(', ') || '-'}`);
        for (const t of r.tasks.filter((t) => t.owner === 'CLAUDE_LEAD')) io.out(`  ${t.taskId} is kept by the Lead: it is never claimed by a worker (lead claude start ${t.taskId})`);
        io.out(`Nothing has been executed. To run: npm run lead:run -- --batch ${r.batchId}`);
        return 0;
      } catch (err) {
        if (err instanceof StalePlanError || err instanceof PlanNotSubmittableError) {
          io.err(`lead: ${err.message}`);
          return 4;
        }
        throw err;
      }
    }
    if (argv.includes('--show')) {
      const id = flag('--show');
      if (!id) throw new UsageError('--show needs an objective id');
      return await show(id, io);
    }
    const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'));
    if (positional.length !== 1) throw new UsageError('expected exactly one objective file');
    const file = resolve(io.cwd, positional[0]);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new UsageError(`cannot read objective ${file}: ${(err as Error).message}`);
    }
    // a relative repository path is relative to the objective file, so the same file works from any directory
    const objective = engineeringObjectiveSchema.parse(raw);
    objective.repository = isAbsolute(objective.repository) ? objective.repository : resolve(dirname(file), objective.repository);

    const draftPath = flag('--draft') ? resolve(io.cwd, flag('--draft')!) : join(objectiveDir(io.workdir, objective.id), ARTIFACTS.draft);
    const kind = flag('--lead') ?? 'draft';
    if (kind !== 'draft' && kind !== 'claude') throw new UsageError('--lead must be "draft" or "claude"');
    const revisionsFlag = flag('--max-revisions');
    if (revisionsFlag !== undefined && !/^\d+$/.test(revisionsFlag)) throw new UsageError('--max-revisions must be a non-negative integer');
    // Every Claude call spends money, so the ceiling is fixed BEFORE the first one: a per-call cap is mandatory (enforced by the
    // claude CLI itself), revisions (paid retries) are off unless asked for, and the worst-case total is printed up front.
    const budgetFlag = flag('--max-budget-usd');
    let extraArgs: string[] = [];
    const maxRevisions = revisionsFlag === undefined ? 0 : Number(revisionsFlag);
    if (kind === 'claude') {
      if (budgetFlag === undefined) throw new UsageError('--lead claude is a billed call: pass --max-budget-usd <amount> (the per-call cap)');
      const budget = Number(budgetFlag);
      if (!(budget > 0 && budget <= MAX_BUDGET_USD)) throw new UsageError(`--max-budget-usd must be a number in (0, ${MAX_BUDGET_USD}]`);
      if (maxRevisions > MAX_BILLED_REVISIONS) throw new UsageError(`--max-revisions is capped at ${MAX_BILLED_REVISIONS} for a billed Lead`);
      extraArgs = ['--max-budget-usd', String(budget), ...(flag('--model') ? ['--model', flag('--model')!] : [])];
      io.out(`BILLED: at most ${1 + maxRevisions} Claude call(s), each capped at $${budget} by the claude CLI (worst case $${(budget * (1 + maxRevisions)).toFixed(2)}). No automatic retry beyond that.`);
    } else if (budgetFlag !== undefined) throw new UsageError('--max-budget-usd only applies to --lead claude');
    const lead = io.leadFor?.(draftPath, kind) ?? (kind === 'claude' ? new ClaudeEngineeringLead(claudeCliTransport({ extraArgs })) : new DraftFileLead(draftPath));
    const outcome = await planObjective(objective, lead, { workdir: io.workdir, now: io.now, maxRevisions }, (e) => e instanceof DraftMissingError);

    io.out(renderResearch(outcome.research));
    if (outcome.status === 'researched') {
      io.out(`\nResearch written to ${join(outcome.dir, ARTIFACTS.research)}. Nothing was executed.`);
      io.out(`The Engineering Lead now writes a plan draft to ${draftPath} (shape below), then re-run this command.\n${SKELETON}`);
      return 3;
    }
    io.out('');
    if (outcome.status === 'rejected') {
      for (const e of outcome.validation.errors) io.out(`ERROR ${e.code}${e.taskId ? ` [${e.taskId}]` : ''}: ${e.message}`);
      for (const w of outcome.validation.warnings) io.out(`warning ${w.code}${w.taskId ? ` [${w.taskId}]` : ''}: ${w.message}`);
      io.err(`lead: plan rejected${outcome.revisions ? ` after ${outcome.revisions} revision(s)` : ''} (${summarize(outcome.validation)}); nothing was written for the scheduler. Evidence: ${join(outcome.dir, ARTIFACTS.rejected)}`);
      return 1;
    }
    io.out(renderPlan(objective, outcome.plan, outcome.validation));
    io.out(`\nPlan ${outcome.validation.readiness} (${summarize(outcome.validation)}${outcome.revisions ? `, after ${outcome.revisions} revision(s)` : ''}). Nothing was executed.`);
    io.out(`Artifacts: ${outcome.dir}`);
    if (outcome.batchPath) io.out(`To queue it (explicit step, refuses a stale plan): npm run lead -- objective --submit ${objective.id}`);
    else io.out('Resolve the pending human decision(s), then have the Lead revise the draft and re-run; no batch was produced.');
    return 0;
  } catch (err) {
    if (err instanceof UsageError || err instanceof ZodError) {
      io.err(`lead: ${err instanceof ZodError ? `invalid input: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` : err.message}`);
      io.err(USAGE);
    } else io.err(`lead: ${(err as Error).message}`);
    return 2;
  }
}

class UsageError extends Error {}

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CommandRunner } from '../../runtime/integration/integrate.ts';
import type { Executor } from '../../runtime/scheduler/scheduler.ts';
import type { SchedulerStore } from '../../runtime/scheduler/store.ts';
import type { SchedulerConfig } from '../../runtime/scheduler/types.ts';
import type { WorktreeManager } from '../../runtime/worktree/worktree.ts';
import { cancelObjective, resumeObjective, runObjectiveLifecycle, type LifecycleDeps, type LifecycleOutcome } from './driver.ts';
import { sandboxRunner } from './exec.ts';
import { pinOracle, type OracleSpecInput } from './oracle.ts';
import { LifecycleError, LifecycleStore } from './store.ts';

/**
 * `lead lifecycle`: drive one objective from a submitted batch to an audited verdict.
 *
 *   lead lifecycle pin <objective-id> --oracle <oracle.json>      pin the independent oracle (BEFORE any worker runs)
 *   lead lifecycle run <objective-id> [--allow-provider p:task]   execute -> verified review -> integrate -> accept
 *   lead lifecycle status <objective-id>                          phase, oracle version, tasks, authorizations, audit trail
 *   lead lifecycle authorize <objective-id> <task> --reason "..." [--uses N]   permit a bounded repair on a paid provider
 *   lead lifecycle resume <objective-id> --reason "..."           leave AWAITING_OPERATOR / ESCALATED after the operator acted
 *   lead lifecycle cancel <objective-id> --reason "..."           cancel the objective, its tasks and their runs
 *
 * oracle.json: { "dir": "/abs/path/outside/repo", "files": ["acceptance_test.go"], "commands": [["go","test","./..."]],
 *                "negativeControl": {"mode":"required"} | {"mode":"not_applicable","reason":"..."} }
 *
 * Exit codes: 0 ACCEPTED · 1 NOT_ACCEPTED · 2 usage/input · 3 ESCALATED · 4 AWAITING_OPERATOR · 5 CANCELLED · 6 still in progress.
 * `run` calls the real worker executor; paid providers still need the operator's allow-list (`--allow-provider`, AGENTIC_ALLOW_PROVIDERS).
 */

export const LIFECYCLE_USAGE = `usage:
  lead lifecycle pin <objective-id> --oracle <oracle.json>
  lead lifecycle run <objective-id>
  lead lifecycle status <objective-id>
  lead lifecycle authorize <objective-id> <task> --reason "..." [--uses N]
  lead lifecycle resume <objective-id> --reason "..."
  lead lifecycle cancel <objective-id> --reason "..."`;

export const EXIT = { ACCEPTED: 0, NOT_ACCEPTED: 1, USAGE: 2, ESCALATED: 3, AWAITING_OPERATOR: 4, CANCELLED: 5, IN_PROGRESS: 6 } as const;

export interface LifecycleRuntime {
  scheduler: LifecycleDeps['scheduler'];
  executor?: Pick<Executor, 'cancel'>;
  capacity?: LifecycleDeps['capacity'];
}

export interface LifecycleCliContext {
  store: SchedulerStore;
  worktrees: WorktreeManager;
  workdir: string;
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  config: Pick<SchedulerConfig, 'maxReviewCorrections'>;
  /** Builds the scheduler and executor for `run` / `cancel` (the production caller wires the Mastra executor). */
  makeRuntime?: () => LifecycleRuntime;
  /** Command runner for verification, integration and acceptance (default: the OS sandbox). */
  run?: CommandRunner;
  actor?: string;
}

const flag = (args: string[], name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

export async function runLifecycleCommand(args: string[], ctx: LifecycleCliContext): Promise<number> {
  const [sub, ...rest] = args;
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));
  const [objectiveId, taskId] = positional;
  const lifecycle = new LifecycleStore(ctx.store);
  const actor = ctx.actor ?? 'human';
  const usage = (msg?: string) => (ctx.err(msg ? `${msg}\n${LIFECYCLE_USAGE}` : LIFECYCLE_USAGE), EXIT.USAGE);
  if (!sub || !objectiveId) return usage();

  try {
    switch (sub) {
      case 'pin': {
        const file = flag(rest, '--oracle');
        if (!file) return usage('pin needs --oracle <oracle.json>');
        const spec = JSON.parse(await readFile(resolve(ctx.cwd, file), 'utf8')) as OracleSpecInput;
        const lc = await pinOracle(
          { store: ctx.store, lifecycle, worktrees: ctx.worktrees, forbiddenRoots: [process.env.AGENTIC_ARTIFACT_ROOT ?? join(ctx.workdir, 'lead-delegations')] },
          { objectiveId, batchId: objectiveId, spec, actor },
        );
        ctx.out(`objective ${objectiveId}: oracle ${lc.oracle.specHash.slice(0, 12)} pinned (${Object.keys(lc.oracle.files).length} file(s)); base ${lc.baseCommit.slice(0, 10)}; phase ${lc.phase}`);
        for (const [f, h] of Object.entries(lc.oracle.files)) ctx.out(`  ${f}  sha256 ${h}`);
        return 0;
      }
      case 'run': {
        if (!ctx.makeRuntime) return usage('run is not available in this context');
        const runtime = ctx.makeRuntime();
        const deps: LifecycleDeps = { store: ctx.store, worktrees: ctx.worktrees, lifecycle, scheduler: runtime.scheduler, executor: runtime.executor, capacity: runtime.capacity, run: ctx.run ?? sandboxRunner(600_000), config: ctx.config, evidenceDir: join(ctx.workdir, 'objectives', objectiveId), log: (l) => ctx.out(`  ${l}`) };
        const outcome = await runObjectiveLifecycle(deps, objectiveId, { actor });
        ctx.out(renderOutcome(outcome));
        return exitFor(outcome);
      }
      case 'status': {
        const lc = lifecycle.require(objectiveId);
        ctx.out(`objective ${objectiveId}: ${lc.phase}${lc.result && (lc.result as { reason?: string }).reason ? ` (${(lc.result as { reason?: string }).reason})` : ''}`);
        ctx.out(`oracle ${lc.oracle.specHash.slice(0, 12)}  base ${lc.baseCommit.slice(0, 10)}  negative control: ${lc.oracle.negativeControl.mode}`);
        for (const t of ctx.store.listTasks({ batchId: lc.batchId })) ctx.out(`  ${t.state.padEnd(15)} ${t.id}${t.correctionOf ? ` (correction of ${t.correctionOf})` : ''}${t.stateReason && !['READY', 'BACKLOG', 'DONE'].includes(t.state) ? `  ${t.stateReason.slice(0, 120)}` : ''}`);
        for (const a of lc.authorizations) ctx.out(`  authorization: ${a.kind} ${a.taskId} ${a.remaining} use(s) left (${a.actor}: ${a.reason})`);
        for (const e of lifecycle.events(objectiveId).slice(-15)) ctx.out(`  #${e.seq} ${e.kind.padEnd(22)} ${e.fromPhase}->${e.toPhase} ${e.actor}: ${e.reason ?? ''}`);
        return 0;
      }
      case 'authorize': {
        if (!taskId) return usage('authorize needs a task id');
        const uses = flag(rest, '--uses');
        const lc = lifecycle.authorize(objectiveId, { kind: 'repair', taskId, uses: uses === undefined ? undefined : Number(uses), actor, reason: flag(rest, '--reason') ?? '' });
        ctx.out(`objective ${objectiveId}: repair of ${taskId} authorized by ${actor} (${lc.authorizations.filter((a) => a.taskId === taskId).map((a) => a.remaining).join(', ')} use(s) left). Resume with: lead lifecycle resume ${objectiveId} --reason "..."`);
        return 0;
      }
      case 'resume': {
        const lc = resumeObjective(lifecycle, objectiveId, { actor, reason: flag(rest, '--reason') ?? '' });
        ctx.out(`objective ${objectiveId}: ${lc.phase}. Continue with: lead lifecycle run ${objectiveId}`);
        return 0;
      }
      case 'cancel': {
        const runtime = ctx.makeRuntime?.();
        const r = await cancelObjective({ store: ctx.store, lifecycle, scheduler: runtime?.scheduler ?? { run: async () => { throw new Error('not running'); } }, executor: runtime?.executor, capacity: runtime?.capacity, log: (l) => ctx.out(`  ${l}`) }, objectiveId, { actor, reason: flag(rest, '--reason') ?? '' });
        ctx.out(r.alreadyFinal ? `objective ${objectiveId} is already ${r.lifecycle.phase}; nothing to cancel` : `objective ${objectiveId}: CANCELLED; ${r.tasks.filter((t) => t.outcome === 'cancelled').length} task(s) cancelled${r.clean ? '' : '; some runs are NOT confirmed stopped (check the Mastra server, then repeat this command)'}`);
        return r.clean ? EXIT.CANCELLED : 1;
      }
      default:
        return usage(`unknown subcommand "${sub}"`);
    }
  } catch (err) {
    if (err instanceof LifecycleError || err instanceof SyntaxError) return usage(`lifecycle: ${err.message}`);
    throw err;
  }
}

export function exitFor(outcome: LifecycleOutcome): number {
  return EXIT[outcome.verdict];
}

export function renderOutcome(o: LifecycleOutcome): string {
  const lines = [`objective ${o.objectiveId}: ${o.verdict}${o.reason ? ` (${o.reason})` : ''} after ${o.rounds} round(s)`];
  for (const s of o.stops) lines.push(`  - ${s}`);
  if (o.acceptance) {
    const a = o.acceptance;
    lines.push(`  oracle ${a.oracle.specHash.slice(0, 12)} unchanged=${a.oracle.unchanged} pinnedBeforeFirstClaim=${a.oracle.pinnedBeforeFirstClaim}; integration tip ${a.integration.tip.slice(0, 10)}`);
    if (a.candidate) lines.push(`  candidate ${a.candidate.commit.slice(0, 10)}: ${a.candidate.passed ? 'PASS' : 'FAIL'} ${a.candidate.commands.map((c) => `${c.command.join(' ')} -> ${c.exitCode} (${c.durationMs}ms)`).join('; ')}`);
    if (a.negativeControl && 'commit' in a.negativeControl) lines.push(`  negative control ${a.negativeControl.commit.slice(0, 10)}: ${a.negativeControl.passed ? 'PASSED (bad)' : 'failed as it must'}`);
    lines.push(`  evidence ${a.evidenceHash}`);
  }
  return lines.join('\n');
}

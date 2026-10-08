// M5 persistent engineering scheduler. Claude (Engineering Lead) plans and reviews; local Qwen workers implement through
// the Mastra `coding-task-workflow` (visible in Studio); the runtime verifies; nothing pushes, commits to a user branch,
// or calls a paid API. State lives in SQLite (.workdir/scheduler/scheduler.db).
//
//   npm run lead:plan -- <plan.json>                       create a batch (tasks start in BACKLOG, then READY when unblocked)
//   npm run lead:tasks -- [--batch B] [--state S] [--markdown]
//   npm run lead:run -- [--batch B] [--workers N] [--server URL]   needs `npm run dev` running
//        logical workers: --workers, else AGENTIC_WORKER_CONCURRENCY (default 1, max 3). Model concurrency is separate:
//        the machine-wide capacity database (AGENTIC_MODEL_CONCURRENCY, default 1); more workers never mean more model calls.
//   npm run lead:status -- [--batch B]                     states, pending reviews, issues, metrics
//   npm run lead:review -- list | pack [--out F] | decide <task> approve|reject|escalate [--feedback "..."]
//   npm run lead -- integrate <batch>                merge APPROVED tasks into lead-integration/<batch>, verify
//   npm run lead:resume -- [--steal] [--run]               recover expired leases / interrupted integrations
//   npm run lead:cancel -- <task> [--reason "..."]
//   npm run lead -- retry <task>                     requeue a RUNTIME_FAILURE (bounded)
//   npm run lead -- recover <task> --reason "..." [--grant N | --escalate]   audited recovery of a RUNTIME_FAILURE whose claim budget is spent
//   npm run lead -- claude take|start|done <task> ...   Claude-direct work, tracked with reasons
//   npm run lead -- metrics [--batch B] | reconcile [--batch B]
//   npm run lead -- objective <objective.json> [--draft F] | --show <id> | --submit <id>   M7.5: plan, then explicit submit; never executes
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { findProjectRoot } from '../src/core/paths.ts';
import { completeClaudeTask, integrateBatch } from '../src/runtime/integration/integrate.ts';
import { createMastraExecutor } from '../src/integrations/mastra/executor.ts';
import { computeMetrics, reconcileState, renderBacklog } from '../src/runtime/scheduler/report.ts';
import { pendingReviews, renderReviewPack, reviewDecision, startClaudeTask, takeOverEscalated, writeReviewPack } from '../src/lead/review.ts';
import { Scheduler } from '../src/runtime/scheduler/scheduler.ts';
import { SchedulerStore } from '../src/runtime/scheduler/store.ts';
import { sharedModelCapacity } from '../src/runtime/capacity/model-capacity.ts';
import { configFromEnv, resolveConfig, type SchedulerConfig } from '../src/runtime/scheduler/types.ts';
import { WorktreeManager } from '../src/runtime/worktree/worktree.ts';
import { runObjectiveCommand } from '../src/lead/objective/cli.ts';
import { recoverRuntimeFailure } from '../src/lead/recovery.ts';

const args = process.argv.slice(2);
const [command, ...rest] = args;
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const has = (name: string) => args.includes(name);
const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));

const root = findProjectRoot() ?? process.cwd();
const workdir = process.env.AGENTIC_SCHED_ROOT ?? join(root, '.workdir');
// Planning (`objective` without --submit) must not create or open the scheduler database: it gets a throwaway in-memory store.
const store = new SchedulerStore(command === 'objective' && !has('--submit') ? ':memory:' : (process.env.AGENTIC_SCHED_DB ?? join(workdir, 'scheduler', 'scheduler.db')));
const worktrees = new WorktreeManager(join(workdir, 'worktrees'));

async function loadConfig(): Promise<SchedulerConfig> {
  const file = join(workdir, 'scheduler.config.json');
  const fromFile = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
  const num = (name: string) => (flag(name) ? Number(flag(name)) : undefined);
  if (has('--ollama')) throw new Error('--ollama was removed: model concurrency is machine-wide (AGENTIC_MODEL_CONCURRENCY, stored in the capacity database), not a scheduler setting');
  if ('maxConcurrentOllamaRequests' in fromFile) console.warn('lead: ignoring maxConcurrentOllamaRequests in scheduler.config.json (removed; model concurrency is AGENTIC_MODEL_CONCURRENCY)');
  // precedence: --workers flag > AGENTIC_WORKER_CONCURRENCY > scheduler.config.json > default
  return resolveConfig({
    ...fromFile,
    maxConcurrentWorkers: num('--workers') ?? configFromEnv().maxConcurrentWorkers ?? fromFile.maxConcurrentWorkers,
    maxTasksPerBatch: num('--max-tasks') ?? fromFile.maxTasksPerBatch,
    taskTimeoutMs: num('--task-timeout-ms') ?? fromFile.taskTimeoutMs,
    workerLeaseTimeoutMs: num('--lease-ms') ?? fromFile.workerLeaseTimeoutMs,
    maxReviewCorrections: num('--max-corrections') ?? fromFile.maxReviewCorrections,
    maxCapacityWaitMs: configFromEnv().maxCapacityWaitMs ?? fromFile.maxCapacityWaitMs,
  });
}

function table(batchId?: string, state?: string): void {
  for (const t of store.listTasks({ batchId })) {
    if (state && t.state !== state) continue;
    const lease = t.leaseOwner ? ` lease=${t.leaseOwner}@${t.claimEpoch}` : '';
    const waiting = t.state === 'BACKLOG' ? store.dependencyStatus(t).waitingOn : [];
    console.log(`${t.state.padEnd(15)} p${String(t.priority).padStart(2)} ${t.id}${t.spec.dependsOn.length ? `  <- ${t.spec.dependsOn.join(',')}` : ''}  [${t.executor}${t.language ? `/${t.language}` : ''}] attempts=${t.attempts} claims=${t.claims}${lease}${t.runId ? `  run=${t.runId}` : ''}`);
    if (waiting.length > 0) console.log(`${' '.repeat(16)}waiting on ${waiting.map((w) => `${w.id} (${w.state})`).join(', ')}`);
    if (t.stateReason && !['READY', 'BACKLOG'].includes(t.state)) console.log(`${' '.repeat(16)}${t.failureCategory ? `[${t.failureCategory}] ` : ''}${t.stateReason}`);
  }
}

async function main(): Promise<void> {
  switch (command) {
    case 'objective':
      process.exitCode = await runObjectiveCommand(rest, { out: (t) => console.log(t), err: (t) => console.error(t), cwd: process.cwd(), workdir, sink: store });
      break;
    case 'plan': {
      const plan = store.createBatch(JSON.parse(await readFile(resolve(positional[0]), 'utf8')));
      const p = store.promote('plan');
      console.log(`batch ${plan.batchId}: ${plan.tasks.length} task(s); READY: ${p.ready.join(', ') || '-'}; BLOCKED: ${p.blocked.join(', ') || '-'}`);
      table(plan.batchId);
      break;
    }
    case 'tasks': {
      if (has('--markdown')) {
        const out = flag('--out') ?? join(workdir, 'scheduler', `backlog${flag('--batch') ? `-${flag('--batch')}` : ''}.md`);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, renderBacklog(store, flag('--batch')));
        console.log(`wrote ${out}`);
      } else table(flag('--batch'), flag('--state'));
      break;
    }
    case 'run': {
      const config = await loadConfig();
      const executor = createMastraExecutor({ server: flag('--server'), taskTimeoutMs: config.taskTimeoutMs + config.maxCapacityWaitMs /* poll backstop = the hard bound: active budget + queueing budget */ });
      const scheduler = new Scheduler({ store, executor, workspace: worktrees, config, capacity: sharedModelCapacity(), log: (l) => console.log(`  ${l}`) });
      process.on('SIGINT', () => scheduler.stop());
      const capacity = sharedModelCapacity();
      console.log(`config: ${JSON.stringify(config)}`);
      console.log(`logical workers: ${config.maxConcurrentWorkers}; active-execution timeout ${Math.round(config.taskTimeoutMs / 1000)}s (paused while queued) + queue budget ${Math.round(config.maxCapacityWaitMs / 1000)}s; model permits (machine-wide): ${capacity.permits}${process.env.AGENTIC_MODEL_CONCURRENCY && Number(process.env.AGENTIC_MODEL_CONCURRENCY) !== capacity.permits ? ` (AGENTIC_MODEL_CONCURRENCY=${process.env.AGENTIC_MODEL_CONCURRENCY} is ignored: the capacity database already holds ${capacity.permits})` : ''}`);
      const summary = await scheduler.run({ batchId: flag('--batch') });
      console.log(JSON.stringify(summary, null, 2));
      table(flag('--batch'));
      break;
    }
    case 'status': {
      const batchId = flag('--batch');
      table(batchId);
      console.log(`\npending reviews: ${pendingReviews(store).map((r) => r.task.id).join(', ') || 'none'}`);
      const issues = await reconcileState(store, worktrees, batchId);
      for (const i of issues) console.log(`ISSUE ${i.kind} ${i.taskId ?? ''}: ${i.detail}`);
      console.log(JSON.stringify(computeMetrics(store, batchId), null, 2));
      break;
    }
    case 'review': {
      const config = await loadConfig();
      const [sub, taskId, decision] = positional;
      if (sub === 'list') {
        for (const { review, task } of pendingReviews(store)) console.log(`#${review.id} ${task.id}  round ${review.round}  ${task.title}`);
      } else if (sub === 'pack') {
        const out = flag('--out') ?? join(workdir, 'scheduler', 'reviews', `pack-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
        const r = await writeReviewPack(store, out);
        console.log(`wrote ${r.tasks} review(s) to ${r.path}`);
      } else if (sub === 'show') {
        console.log(renderReviewPack(store, [taskId]));
      } else if (sub === 'decide') {
        const map = { approve: 'APPROVED', reject: 'REJECTED_WITH_FEEDBACK', escalate: 'ESCALATED_TO_HUMAN' } as const;
        if (!(decision in map)) throw new Error('decision must be approve | reject | escalate');
        const r = reviewDecision(store, config, { taskId, decision: map[decision as keyof typeof map], feedback: flag('--feedback') });
        console.log(`${taskId} -> ${r.task.state}${r.correctionId ? `; correction task ${r.correctionId} created` : ''}`);
      } else throw new Error('usage: review list | pack | show <task> | decide <task> approve|reject|escalate [--feedback ..]');
      break;
    }
    case 'integrate': {
      const { reports, locked } = await integrateBatch(store, worktrees, { batchId: positional[0], log: (l) => console.log(`  ${l}`) });
      if (locked) console.log('another integrator holds the repository lock; try again shortly');
      for (const r of reports) console.log(`${r.outcome.padEnd(9)} ${r.taskId}${r.category ? ` [${r.category}]` : ''}${r.detail ? ` ${r.detail}` : ''}${r.integratedCommit ? ` -> ${r.integratedCommit.slice(0, 10)}` : ''}`);
      for (const r of reports) if (r.conflict) console.log(`  conflict evidence for ${r.taskId}: files ${r.conflict.files.join(', ') || '-'}; already integrated: ${r.conflict.conflictingTasks.map((c) => c.taskId).join(', ') || '-'} (full evidence: task artifacts.integration.conflict)`);
      process.exitCode = reports.some((r) => r.outcome === 'ESCALATED' || r.outcome === 'SKIPPED') ? 1 : 0;
      break;
    }
    case 'resume': {
      const config = await loadConfig();
      const scheduler = new Scheduler({ store, executor: createMastraExecutor({ server: flag('--server'), taskTimeoutMs: config.taskTimeoutMs + config.maxCapacityWaitMs /* poll backstop = the hard bound: active budget + queueing budget */ }), workspace: worktrees, config, capacity: sharedModelCapacity(), log: (l) => console.log(`  ${l}`) });
      const r = scheduler.recover({ stealLeases: has('--steal') });
      console.log(`requeued: ${r.requeued.join(', ') || '-'}; claim budget exhausted: ${r.exhausted.join(', ') || '-'}`);
      if (has('--run')) console.log(JSON.stringify(await scheduler.run({ batchId: flag('--batch') }), null, 2));
      table(flag('--batch'));
      break;
    }
    case 'cancel': {
      const t = store.transition(positional[0], 'CANCELLED', { actor: 'human', reason: flag('--reason') ?? 'cancelled by user', patch: { failureCategory: 'cancelled' } });
      store.promote('cancel');
      console.log(`${t.id} -> ${t.state} (a running worker notices on its next lease heartbeat and discards its result; its worktree is preserved)`);
      break;
    }
    case 'retry': {
      const t = store.requireTask(positional[0]);
      if (t.state !== 'RUNTIME_FAILURE') throw new Error(`${t.id} is ${t.state}; only RUNTIME_FAILURE tasks are retried (ESCALATED needs a decision)`);
      if (t.claims >= t.spec.maxClaims) throw new Error(`${t.id} used its claim budget (${t.claims}/${t.spec.maxClaims}); use: lead recover ${t.id} --reason "..." [--grant N | --escalate]`);
      console.log(`${t.id} -> ${store.transition(t.id, 'READY', { actor: 'human', reason: 'runtime failure retried', patch: { runtimeRequeues: t.runtimeRequeues + 1, failureCategory: null } }).state}`);
      break;
    }
    case 'recover': {
      const reason = flag('--reason');
      if (!reason) throw new Error('usage: recover <task> --reason "..." [--grant N | --escalate]');
      if (has('--escalate') && has('--grant')) throw new Error('--grant and --escalate are alternatives');
      const grant = flag('--grant');
      if (grant !== undefined && !/^\d+$/.test(grant)) throw new Error('--grant must be a positive integer');
      const r = recoverRuntimeFailure(store, positional[0], { reason, action: has('--escalate') ? { kind: 'escalate' } : { kind: 'retry', grantClaims: grant === undefined ? undefined : Number(grant) } });
      console.log(`${r.task.id} -> ${r.task.state}${r.grantedClaims ? ` (claim budget raised by ${r.grantedClaims} to ${r.task.spec.maxClaims})` : ''}; recorded in the task's event log and artifacts.recoveries`);
      break;
    }
    case 'claude': {
      const [sub, taskId] = positional;
      if (sub === 'take') console.log(takeOverEscalated(store, taskId, flag('--reason') ?? '').state);
      else if (sub === 'start') {
        startClaudeTask(store, taskId);
        const iw = await worktrees.integrationWorktree(store.getBatch(store.requireTask(taskId).batchId)!);
        console.log(`commit your change on branch ${iw.branch} in ${iw.path}, then: claude done ${taskId} --commit <sha> --note "..."`);
      } else if (sub === 'done') console.log(JSON.stringify(await completeClaudeTask(store, worktrees, { taskId, commit: flag('--commit') ?? '', note: flag('--note') ?? '' }), null, 2));
      else throw new Error('usage: claude take|start|done <task>');
      break;
    }
    case 'metrics':
      console.log(JSON.stringify(computeMetrics(store, flag('--batch')), null, 2));
      break;
    case 'reconcile':
      console.log(JSON.stringify(await reconcileState(store, worktrees, flag('--batch')), null, 2));
      break;
    default:
      console.error('usage: lead <objective|plan|tasks|run|status|review|integrate|resume|cancel|retry|claude|metrics|reconcile> ...');
      process.exit(2);
  }
}

main()
  .catch((err) => {
    console.error(`lead: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => store.close());

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateJsVerification } from '../execution/delegation.ts';
import { runSandboxedCommand } from '../sandbox/sandbox.ts';
import { redact } from '../execution/coding-task-trace.ts';
import type { BatchRow, SchedulerStore, TaskRow } from '../scheduler/store.ts';
import { StoreError } from '../scheduler/store.ts';
import { ownedFilesOf, type FailureCategory } from '../scheduler/types.ts';
import { taskBranch, type WorktreeManager } from '../worktree/worktree.ts';

/**
 * Safe integration coordinator. Only APPROVED tasks integrate, one at a time per repository (an expiring DB lock),
 * and only ever into the batch's dedicated integration BRANCH inside a dedicated integration WORKTREE:
 *
 *   recheck reviewed commit untouched -> recheck scope -> merge (--no-ff) -> commit runtime-owned oracles as permanent
 *   tests -> run integration verification (this task's oracle, earlier integrated tasks' oracles, batch commands)
 *   -> pass: DONE | any failure: roll the integration branch back to the recorded pre-merge SHA, task -> ESCALATED,
 *   task worktree and artifacts preserved.
 *
 * It never pushes, never touches the user's checkout, and never merges into main/protected branches: promoting the
 * integration branch is a human decision outside this module.
 */

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}
export type CommandRunner = (command: string[], cwd: string) => Promise<CommandResult>;

// Integration verification runs the integrated tasks' code: same OS sandbox as worker verification (fail closed).
const defaultRunner: CommandRunner = async (command, cwd) => {
  const r = await runSandboxedCommand(command[0], command.slice(1), { cwd, root: cwd, timeoutMs: 600_000 });
  return { exitCode: r.exitCode, output: `${r.stdout}${r.stderr}`, timedOut: r.timedOut };
};

export interface IntegrationReport {
  taskId: string;
  outcome: 'DONE' | 'ESCALATED' | 'SKIPPED';
  category?: FailureCategory;
  detail?: string;
  integratedCommit?: string;
  commands?: { command: string[]; exitCode: number | null; tail: string }[];
}

const IDENTITY = ['-c', 'user.name=agentic-integrator', '-c', 'user.email=integrator@localhost', '-c', 'commit.gpgsign=false'];

/** The permanent location of a runtime-owned oracle: `*.hidden.test.js` becomes `*.test.js`. */
export function permanentOraclePath(hiddenPath: string): string {
  return hiddenPath.replace(/\.hidden\.test\.([cm]?[jt]sx?)$/, '.test.$1');
}

function remap(command: string[], paths: Map<string, string>): string[] {
  return command.map((arg) => paths.get(arg) ?? arg);
}

async function validateCommand(command: string[], repoRoot: string, hidden: Record<string, string>): Promise<string[]> {
  if (command[0] === 'npx') {
    return validateJsVerification(command, { taskId: 'integration', objective: 'integration', allowedFiles: [], contextFiles: [], acceptanceCriteria: [], verificationCommands: [command], constraints: [], hiddenFiles: hidden }, repoRoot);
  }
  return ['go', 'gofmt'].includes(command[0]) ? [] : [`integration command binary "${command[0]}" is not allow-listed`];
}

export interface IntegrateOptions {
  batchId: string;
  actor?: string;
  log?: (line: string) => void;
  run?: CommandRunner;
  lockTtlMs?: number;
}

export async function integrateBatch(store: SchedulerStore, worktrees: WorktreeManager, options: IntegrateOptions): Promise<{ reports: IntegrationReport[]; locked: boolean }> {
  const batch = store.getBatch(options.batchId);
  if (!batch) throw new StoreError('not_found', `batch ${options.batchId} not found`);
  const owner = `${options.actor ?? 'integrator'}:${process.pid}`;
  const lockName = `integrate:${batch.repository}`;
  if (!store.acquireLock(lockName, owner, options.lockTtlMs ?? 20 * 60_000)) return { reports: [], locked: true };
  const log = options.log ?? (() => {});
  const run = options.run ?? defaultRunner;
  try {
    const iw = await worktrees.integrationWorktree(batch);
    const ctx = { store, worktrees, batch, iw, run, log, actor: owner };
    await recoverInterrupted(ctx);
    await assertCleanIntegrationTree(ctx);

    const reports: IntegrationReport[] = [];
    for (const candidate of store.listTasks({ batchId: batch.id, states: ['APPROVED'] })) {
      const task = store.requireTask(candidate.id);
      if (task.state !== 'APPROVED') continue; // idempotent: DONE / already integrating tasks are never redone
      reports.push(await integrateOne(ctx, task));
      store.promote('integrator');
    }
    return { reports, locked: false };
  } finally {
    store.releaseLock(lockName, owner);
  }
}

interface Ctx {
  store: SchedulerStore;
  worktrees: WorktreeManager;
  batch: BatchRow;
  iw: { path: string; branch: string };
  run: CommandRunner;
  log: (line: string) => void;
  actor: string;
}

const gitIn = (ctx: Ctx, args: string[]) => ctx.worktrees.git(ctx.iw.path, args);

async function head(ctx: Ctx): Promise<string> {
  const r = await gitIn(ctx, ['rev-parse', 'HEAD']);
  return r.stdout.trim();
}

async function assertCleanIntegrationTree(ctx: Ctx): Promise<void> {
  const links = ctx.batch.linkPaths;
  const status = (await gitIn(ctx, ['status', '--porcelain'])).stdout.split('\n').filter((l) => l && !links.some((p) => l.slice(3).replace(/\/$/, '') === p));
  if (status.length > 0) throw new Error(`integration worktree ${ctx.iw.path} is not clean (${status.join('; ')}); refusing to integrate on top of unknown changes`);
}

/**
 * A crashed integrator can leave a task INTEGRATING with the integration worktree in ANY intermediate state: a conflicted
 * merge still in progress (tip == preSha, MERGE_HEAD set), a merge commit whose verification never finished, or an
 * oracle file written but not yet committed. Holding the integration lock proves no live integrator exists, so the
 * worktree is rolled back to the recorded pre-merge SHA (only if that SHA is an ancestor of the tip, i.e. nothing
 * foreign is discarded), including untracked leftovers, and the task goes back to APPROVED.
 */
async function recoverInterrupted(ctx: Ctx): Promise<void> {
  for (const task of ctx.store.listTasks({ batchId: ctx.batch.id, states: ['INTEGRATING'] })) {
    const preSha = (task.artifacts.integration as { preSha?: string } | undefined)?.preSha;
    if (preSha) await rollback(ctx, preSha).catch((err: Error) => Promise.reject(new Error(`cannot recover ${task.id}: ${err.message}`)));
    ctx.store.transition(task.id, 'APPROVED', { actor: ctx.actor, reason: 'integration interrupted; integration branch restored, will retry', expectFrom: 'INTEGRATING' });
    ctx.log(`recovered interrupted integration of ${task.id}`);
  }
}

/** Restores the integration worktree to `preSha` exactly: no merge in progress, no commits after it, no untracked files. */
async function rollback(ctx: Ctx, preSha: string): Promise<void> {
  await gitIn(ctx, ['merge', '--abort']); // fails harmlessly when no merge is in progress
  const tip = await head(ctx);
  if (tip !== preSha) {
    // only discard commits this integration created: preSha must be an ancestor of the tip
    const ancestor = await gitIn(ctx, ['merge-base', '--is-ancestor', preSha, tip]);
    if (!ancestor.success) throw new Error(`refusing rollback: ${preSha} is not an ancestor of ${tip}`);
  }
  const reset = await gitIn(ctx, ['reset', '--hard', preSha]);
  if (!reset.success) throw new Error(`git reset --hard ${preSha} failed: ${(reset.stderr || reset.stdout).trim().slice(0, 300)}`);
  const clean = await gitIn(ctx, ['clean', '-fd', ...ctx.batch.linkPaths.flatMap((p) => ['-e', p])]);
  if (!clean.success) throw new Error(`git clean failed: ${(clean.stderr || clean.stdout).trim().slice(0, 300)}`);
}

async function integrateOne(ctx: Ctx, task: TaskRow): Promise<IntegrationReport> {
  const { store } = ctx;
  const preSha = await head(ctx);
  store.transition(task.id, 'INTEGRATING', { actor: ctx.actor, reason: 'integration started', expectFrom: 'APPROVED', patch: { artifacts: { integration: { preSha, startedAt: store.now() } } } });

  const escalate = async (category: FailureCategory, detail: string, commands?: IntegrationReport['commands'], rollbackTo?: string): Promise<IntegrationReport> => {
    if (rollbackTo) await rollback(ctx, rollbackTo);
    store.transition(task.id, 'ESCALATED', { actor: ctx.actor, reason: detail, expectFrom: 'INTEGRATING', patch: { failureCategory: category, artifacts: { integration: { preSha, failed: category, commands: commands ?? [] } } } });
    ctx.log(`integration of ${task.id} failed (${category}): ${detail}`);
    return { taskId: task.id, outcome: 'ESCALATED', category, detail, commands };
  };

  // 1. the commit that was reviewed must still be the task branch tip
  const branch = task.branch ?? taskBranch(ctx.batch.id, task.id);
  const tip = (await ctx.worktrees.git(ctx.batch.repository, ['rev-parse', '--verify', `refs/heads/${branch}`])).stdout.trim();
  if (!task.headCommit || tip !== task.headCommit) return escalate('diverged_after_review', `task branch ${branch} is at ${tip || 'missing'}, but ${task.headCommit} was the reviewed commit`);

  // 2. the reviewed change must touch only the task's files
  const base = (await gitIn(ctx, ['merge-base', 'HEAD', task.headCommit])).stdout.trim();
  const changed = (await gitIn(ctx, ['diff', '--name-only', base, task.headCommit])).stdout.split('\n').filter(Boolean);
  const owned = ownedFilesOf(task.spec);
  const extra = changed.filter((f) => !owned.includes(f));
  if (extra.length > 0) return escalate('diverged_after_review', `reviewed commit changes files outside the task scope: ${extra.join(', ')}`);

  // 3. merge; any conflict aborts and leaves the branch exactly as it was
  const merge = await gitIn(ctx, [...IDENTITY, 'merge', '--no-ff', '-m', `integrate ${task.id}: ${task.title}`, task.headCommit]);
  if (!merge.success) {
    const conflicted = (await gitIn(ctx, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    return escalate('integration_conflict', `merge conflict${conflicted.length ? ` in ${conflicted.join(', ')}` : ''}: ${(merge.stderr || merge.stdout).trim().slice(0, 300)}`, undefined, preSha);
  }

  // 4. materialize this task's runtime-owned oracles as permanent tests (Lead-authored content, committed separately)
  const contract = task.spec.request?.contract;
  const remapped = new Map<string, string>();
  for (const hidden of Object.keys(contract?.hiddenFiles ?? {})) remapped.set(hidden, permanentOraclePath(hidden));
  for (const [hidden, permanent] of remapped) {
    if (existsSync(join(ctx.iw.path, permanent))) return escalate('integration_conflict', `oracle destination ${permanent} already exists in the integration branch`, undefined, preSha);
    await mkdir(dirname(join(ctx.iw.path, permanent)), { recursive: true });
    await writeFile(join(ctx.iw.path, permanent), contract!.hiddenFiles![hidden]);
  }
  if (remapped.size > 0) {
    const add = await gitIn(ctx, ['add', '--', ...remapped.values()]);
    const commit = add.success ? await gitIn(ctx, [...IDENTITY, 'commit', '-m', `tests: oracle for ${task.id}`]) : add;
    // An uncommitted oracle would be verified, then left behind as a dirty tree that blocks every later integration.
    if (!commit.success) return escalate('integration_verification_failed', `committing the oracle failed: ${(commit.stderr || commit.stdout).trim().slice(0, 300)}`, undefined, preSha);
  }

  // 5. integration verification: this task's own checks, every earlier integrated task's checks, then the batch commands
  const commands: string[][] = [];
  const earlier = ctx.store.listTasks({ batchId: ctx.batch.id, states: ['DONE'] });
  for (const t of [...earlier, task]) {
    const c = t.spec.request?.contract;
    if (!c) continue;
    const map = new Map(Object.keys(c.hiddenFiles ?? {}).map((h) => [h, permanentOraclePath(h)] as const));
    for (const cmd of c.verificationCommands) commands.push(remap(cmd, map));
  }
  commands.push(...ctx.batch.integrationCommands);
  const seen = new Set<string>();
  const results: NonNullable<IntegrationReport['commands']> = [];
  for (const command of commands) {
    const key = command.join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    const problems = await validateCommand(command, ctx.iw.path, {});
    if (problems.length > 0) return escalate('integration_verification_failed', `integration command rejected: ${problems.join('; ')}`, results, preSha);
    const r = await ctx.run(command, ctx.iw.path);
    const tail = redact(r.output.trim().slice(-1200));
    results.push({ command, exitCode: r.exitCode, tail });
    if (r.exitCode !== 0) return escalate('integration_verification_failed', `${command.join(' ')} -> exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`, results, preSha);
  }

  const integratedCommit = await head(ctx);
  store.transition(task.id, 'DONE', { actor: ctx.actor, reason: 'integrated and verified', expectFrom: 'INTEGRATING', patch: { implementedBy: task.executor === 'claude' ? 'claude' : 'worker', artifacts: { integration: { preSha, integratedCommit, commands: results } } } });
  ctx.log(`integrated ${task.id} -> ${integratedCommit.slice(0, 10)}`);
  return { taskId: task.id, outcome: 'DONE', integratedCommit, commands: results };
}

/** Claude-direct completion: the Lead committed its change on the integration branch itself; verify, then mark DONE. */
export async function completeClaudeTask(
  store: SchedulerStore,
  worktrees: WorktreeManager,
  input: { taskId: string; commit: string; note: string; run?: CommandRunner },
): Promise<IntegrationReport> {
  const task = store.requireTask(input.taskId);
  if (task.executor !== 'claude') throw new StoreError('invalid', `task ${task.id} is not a Claude-kept task`);
  const batch = store.getBatch(task.batchId)!;
  const iw = await worktrees.integrationWorktree(batch);
  const ctx: Ctx = { store, worktrees, batch, iw, run: input.run ?? defaultRunner, log: () => {}, actor: 'claude-engineering-lead' };
  const ancestor = await gitIn(ctx, ['merge-base', '--is-ancestor', input.commit, 'HEAD']);
  if (!ancestor.success) throw new StoreError('invalid', `commit ${input.commit} is not on the integration branch ${iw.branch}`);
  const results: NonNullable<IntegrationReport['commands']> = [];
  for (const command of batch.integrationCommands) {
    const problems = await validateCommand(command, iw.path, {});
    if (problems.length > 0) throw new StoreError('invalid', problems.join('; '));
    const r = await ctx.run(command, iw.path);
    results.push({ command, exitCode: r.exitCode, tail: redact(r.output.trim().slice(-1200)) });
    if (r.exitCode !== 0) throw new StoreError('invalid', `integration verification failed: ${command.join(' ')} -> exit ${r.exitCode}`);
  }
  store.transition(task.id, 'DONE', { actor: ctx.actor, reason: input.note, expectFrom: 'CODING', patch: { implementedBy: 'claude', artifacts: { claudeDirect: { commit: input.commit, note: input.note, reason: task.spec.keptReason ?? task.artifacts.claudeReason ?? null, commands: results } } } });
  return { taskId: task.id, outcome: 'DONE', integratedCommit: input.commit, commands: results };
}

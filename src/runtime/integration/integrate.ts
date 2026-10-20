import { gofmtArgvProblem } from '../execution/gofmt-policy.ts';
import { integrationOwnership } from './ownership.ts';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateJsVerification } from '../execution/delegation.ts';
import { runSandboxedCommand } from '../sandbox/sandbox.ts';
import { redact } from '../execution/coding-task-trace.ts';
import type { BatchRow, SchedulerStore, TaskRow } from '../scheduler/store.ts';
import { StoreError } from '../scheduler/store.ts';
import { EvidenceError, readGitEvidence } from '../review/change-review.ts';
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

/** What the Engineering Lead needs to decide about a merge that could not be completed: nothing was resolved or overwritten. */
export interface ConflictEvidence {
  /** Files git reports as conflicted (empty for a conflict that is not file-level). */
  files: string[];
  /** The integration tip the merge was attempted on (the branch is restored to exactly this). */
  integrationTip: string;
  /** The task's reviewed commit, and the merge base git used. */
  taskHead: string | null;
  mergeBase: string;
  /** Per conflicted file: commits that reached the integration branch since the merge base and touched it. */
  integratedSince: { file: string; commits: string[] }[];
  /** DONE tasks of this batch already on the integration branch whose declared files include a conflicted file. */
  conflictingTasks: { taskId: string; files: string[] }[];
  /** The conflicted file contents with git's markers, truncated: both sides of every hunk. */
  markers: { file: string; excerpt: string }[];
}

export interface IntegrationReport {
  taskId: string;
  outcome: 'DONE' | 'ESCALATED' | 'SKIPPED';
  category?: FailureCategory;
  detail?: string;
  integratedCommit?: string;
  commands?: { command: string[]; exitCode: number | null; tail: string }[];
  conflict?: ConflictEvidence;
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
  if (command[0] === 'gofmt') { const problem = gofmtArgvProblem(command); return problem ? [problem] : []; }
  return command[0] === 'go' ? [] : [`integration command binary "${command[0]}" is not allow-listed`];
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
  const ownership = await integrationOwnership(store, worktrees, batch.repository, options.actor ?? 'integrator', options.lockTtlMs ?? 20 * 60_000);
  if (!ownership) return { reports: [], locked: true };
  const owner = ownership.owner;
  const log = options.log ?? (() => {});
  const run = options.run ?? defaultRunner;
  try {
    ownership.assert();
    const iw = await worktrees.integrationWorktree(batch, () => ownership.assert());
    const ctx = { store, worktrees, batch, iw, run, log, actor: owner, assertOwner: () => ownership.assert() };
    await recoverInterrupted(ctx);
    await assertCleanIntegrationTree(ctx);

    const reports: IntegrationReport[] = [];
    // Deterministic order, independent of which worker finished first or when the Lead approved: dependencies before
    // dependents, then (priority, creation, id). A dependent whose prerequisites are not all DONE is skipped, loudly.
    for (const candidate of integrationOrder(store, store.listTasks({ batchId: batch.id, states: ['APPROVED'] }))) {
      const task = store.requireTask(candidate.id);
      if (task.state !== 'APPROVED') continue; // idempotent: DONE / already integrating tasks are never redone
      const deps = store.dependencyStatus(task);
      if (deps.status !== 'ready') {
        const detail = deps.reason ?? `waiting on ${deps.waitingOn.map((w) => `${w.id} (${w.state})`).join(', ')}`;
        ctx.log(`skipped ${task.id}: ${detail}`);
        reports.push({ taskId: task.id, outcome: 'SKIPPED', detail: `dependencies not integrated: ${detail}` });
        continue;
      }
      reports.push(await integrateOne(ctx, task));
      ctx.assertOwner();
      store.promote('integrator', { batchId: batch.id });
    }
    ownership.assert();
    return { reports, locked: false };
  } finally {
    await ownership.release();
  }
}

/**
 * Stable topological order over the approved set: a task's (resolved) dependencies that are also waiting to integrate
 * come first; everything else keeps the store's deterministic (priority desc, created, id) order.
 */
export function integrationOrder(store: SchedulerStore, tasks: TaskRow[]): TaskRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: TaskRow[] = [];
  const seen = new Set<string>();
  const visit = (t: TaskRow) => {
    if (seen.has(t.id)) return;
    seen.add(t.id); // the plan is validated acyclic, and `seen` makes a cycle harmless anyway
    for (const depId of t.spec.dependsOn) {
      const dep = store.resolveDependency(depId);
      const waiting = dep && byId.get(dep.id);
      if (waiting) visit(waiting);
    }
    out.push(t);
  };
  for (const t of tasks) visit(t);
  return out;
}

interface Ctx {
  store: SchedulerStore;
  worktrees: WorktreeManager;
  batch: BatchRow;
  iw: { path: string; branch: string };
  run: CommandRunner;
  log: (line: string) => void;
  actor: string;
  assertOwner: () => void;
  expectedTip?: string;
}

const gitIn = async (ctx: Ctx, args: string[]) => {
  ctx.assertOwner();
  const result = await ctx.worktrees.git(ctx.iw.path, args);
  ctx.assertOwner();
  return result;
};

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
 * Recover only a journaled tip (or the unchanged pre-merge tip). A crash between a Git
 * commit and journaling it is deliberately blocked: ancestry is not ownership evidence.
 * The non-expiring process gate must first be reconciled after an actual process death.
 */
async function recoverInterrupted(ctx: Ctx): Promise<void> {
  for (const task of ctx.store.listTasks({ batchId: ctx.batch.id, states: ['INTEGRATING'] })) {
    const preSha = (task.artifacts.integration as { preSha?: string } | undefined)?.preSha;
    ctx.expectedTip = (task.artifacts.integration as { expectedTip?: string } | undefined)?.expectedTip ?? preSha;
    if (preSha) await rollback(ctx, preSha).catch((err: Error) => Promise.reject(new Error(`cannot recover ${task.id}: ${err.message}`)));
    ctx.assertOwner();
    ctx.store.transition(task.id, 'APPROVED', { actor: ctx.actor, reason: 'integration interrupted; integration branch restored, will retry', expectFrom: 'INTEGRATING' });
    ctx.log(`recovered interrupted integration of ${task.id}`);
  }
}

/** Restore only the recorded owned tip; preserve all unknown untracked files. */
async function rollback(ctx: Ctx, preSha: string): Promise<void> {
  const tip = await head(ctx);
  if (tip !== (ctx.expectedTip ?? preSha)) throw new Error(`refusing rollback: unexpected integration tip ${tip}; preserving external commits`);
  // reset --hard can overwrite even untracked/ignored files that obstruct checkout.
  // Refuse unknown files BEFORE resetting, not merely by omitting `git clean`.
  const untracked = await gitIn(ctx, ['ls-files', '--others', '-z']);
  if (!untracked.success || untracked.truncated) throw new Error('cannot inspect untracked rollback paths completely');
  const ownedOracles = new Map(ctx.store.listTasks({ batchId: ctx.batch.id, states: ['INTEGRATING'] })
    .flatMap((t) => Object.entries(t.spec.request?.contract.hiddenFiles ?? {}).map(([hidden, content]) => [permanentOraclePath(hidden), content] as const)));
  for (const path of untracked.stdout.split('\0').filter(Boolean)) {
    if (ctx.batch.linkPaths.some((link) => path === link || path.startsWith(`${link}/`))) continue;
    if (!ownedOracles.has(path) || await readFile(join(ctx.iw.path, path), 'utf8').catch(() => null) !== ownedOracles.get(path)) {
      throw new Error(`refusing rollback over unknown untracked path ${path}`);
    }
  }
  const merging = await gitIn(ctx, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']);
  if (merging.success) {
    const ownedMerge = ctx.store.listTasks({ batchId: ctx.batch.id, states: ['INTEGRATING'] }).some((t) => t.headCommit === merging.stdout.trim());
    if (!ownedMerge) throw new Error('refusing rollback of an unknown merge');
    const abort = await gitIn(ctx, ['merge', '--abort']);
    if (!abort.success) throw new Error('cannot abort interrupted integration merge; preserving worktree');
  } else {
    const changes = await gitIn(ctx, ['diff', 'HEAD', '--name-only', '-z']);
    if (!changes.success || changes.truncated) throw new Error('cannot inspect tracked rollback paths completely');
    for (const path of changes.stdout.split('\0').filter(Boolean)) {
      // A rejected oracle commit leaves our new file staged. Prove both index and
      // working bytes, and that HEAD never contained it, before discarding it.
      const content = ownedOracles.get(path);
      const inHead = await gitIn(ctx, ['ls-tree', 'HEAD', '--', path]);
      const staged = await gitIn(ctx, ['rev-parse', '--verify', `:${path}`]);
      const working = await gitIn(ctx, ['hash-object', '--', path]);
      if (content === undefined || !inHead.success || inHead.truncated || inHead.stdout || !staged.success || staged.truncated ||
          !working.success || working.truncated || staged.stdout.trim() !== working.stdout.trim() || await readFile(join(ctx.iw.path, path), 'utf8').catch(() => null) !== content) {
        throw new Error('refusing rollback over uncommitted tracked changes');
      }
    }
  }
  const reset = await gitIn(ctx, ['reset', '--hard', preSha]);
  if (!reset.success) throw new Error(`git reset --hard ${preSha} failed: ${(reset.stderr || reset.stdout).trim().slice(0, 300)}`);
  // Never clean unknown untracked files. Only remove our exact, uncommitted oracle bytes.
  for (const task of ctx.store.listTasks({ batchId: ctx.batch.id, states: ['INTEGRATING'] })) {
    for (const [hidden, content] of Object.entries(task.spec.request?.contract.hiddenFiles ?? {})) {
      const path = join(ctx.iw.path, permanentOraclePath(hidden));
      const tracked = await gitIn(ctx, ['ls-files', '--error-unmatch', '--', permanentOraclePath(hidden)]);
      if (!tracked.success && await readFile(path, 'utf8').catch(() => null) === content) {
        ctx.assertOwner();
        await unlink(path);
      }
    }
  }
}

async function integrateOne(ctx: Ctx, task: TaskRow): Promise<IntegrationReport> {
  const { store } = ctx;
  const preSha = await head(ctx);
  ctx.expectedTip = preSha;
  ctx.assertOwner();
  store.transition(task.id, 'INTEGRATING', { actor: ctx.actor, reason: 'integration started', expectFrom: 'APPROVED', patch: { artifacts: { integration: { preSha, startedAt: store.now() } } } });

  const escalate = async (category: FailureCategory, detail: string, commands?: IntegrationReport['commands'], rollbackTo?: string, conflict?: ConflictEvidence): Promise<IntegrationReport> => {
    if (rollbackTo) await rollback(ctx, rollbackTo);
    // what was already on the branch when this failed: the other half of "these two changes do not work together"
    const integratedBefore = store.listTasks({ batchId: ctx.batch.id, states: ['DONE'] }).map((t) => t.id);
    ctx.assertOwner();
    store.transition(task.id, 'ESCALATED', {
      actor: ctx.actor,
      reason: detail,
      expectFrom: 'INTEGRATING',
      patch: { failureCategory: category, artifacts: { integration: { preSha, failed: category, commands: commands ?? [], integratedBefore, ...(conflict ? { conflict } : {}) } } },
    });
    ctx.log(`integration of ${task.id} failed (${category}): ${detail}`);
    return { taskId: task.id, outcome: 'ESCALATED', category, detail, commands, conflict };
  };

  // 1. the commit that was reviewed must still be the task branch tip
  const branch = task.branch ?? taskBranch(ctx.batch.id, task.id);
  const tip = (await ctx.worktrees.git(ctx.batch.repository, ['rev-parse', '--verify', `refs/heads/${branch}`])).stdout.trim();
  if (!task.headCommit || tip !== task.headCommit) return escalate('diverged_after_review', `task branch ${branch} is at ${tip || 'missing'}, but ${task.headCommit} was the reviewed commit`);

  // 2. the reviewed change must touch only the task's files, judged on the complete change set (--no-renames: a rename
  // record would hide its source path). Unreadable evidence escalates; it never reads as "no files changed".
  let base: string;
  let changed: string[];
  try {
    base = (await readGitEvidence(ctx.iw.path, ['merge-base', 'HEAD', task.headCommit])).stdout.trim();
    changed = (await readGitEvidence(ctx.iw.path, ['diff', '--no-renames', '--name-only', '-z', base, task.headCommit])).stdout.split('\0').filter(Boolean);
  } catch (err) {
    if (!(err instanceof EvidenceError)) throw err;
    return escalate('diverged_after_review', `the reviewed commit's change set could not be read completely: ${err.message}`);
  }
  const owned = ownedFilesOf(task.spec);
  const extra = changed.filter((f) => !owned.includes(f));
  if (extra.length > 0) return escalate('diverged_after_review', `reviewed commit changes files outside the task scope: ${extra.join(', ')}`);

  // 3. merge; any conflict aborts and leaves the branch exactly as it was
  const merge = await gitIn(ctx, [...IDENTITY, 'merge', '--no-ff', '-m', `integrate ${task.id}: ${task.title}`, task.headCommit]);
  if (!merge.success) {
    const conflicted = (await gitIn(ctx, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    // gathered BEFORE the rollback: afterwards the markers are gone. Nothing is resolved, merged or overwritten.
    const evidence = await conflictEvidence(ctx, task, conflicted, preSha, base);
    const others = evidence.conflictingTasks.map((c) => c.taskId);
    return escalate(
      'integration_conflict',
      `merge conflict${conflicted.length ? ` in ${conflicted.join(', ')}` : ''}${others.length ? ` with already-integrated ${others.join(', ')}` : ''}: ${(merge.stderr || merge.stdout).trim().slice(0, 300)}`,
      undefined,
      preSha,
      evidence,
    );
  }

  ctx.expectedTip = await head(ctx);
  ctx.assertOwner();
  store.setArtifacts(task.id, { integration: { preSha, expectedTip: ctx.expectedTip } });

  // 4. materialize this task's runtime-owned oracles as permanent tests (Lead-authored content, committed separately)
  const contract = task.spec.request?.contract;
  const remapped = new Map<string, string>();
  for (const hidden of Object.keys(contract?.hiddenFiles ?? {})) remapped.set(hidden, permanentOraclePath(hidden));
  for (const [hidden, permanent] of remapped) {
    if (existsSync(join(ctx.iw.path, permanent))) return escalate('integration_conflict', `oracle destination ${permanent} already exists in the integration branch`, undefined, preSha);
    ctx.assertOwner();
    await mkdir(dirname(join(ctx.iw.path, permanent)), { recursive: true });
    ctx.assertOwner();
    await writeFile(join(ctx.iw.path, permanent), contract!.hiddenFiles![hidden]);
  }
  if (remapped.size > 0) {
    const add = await gitIn(ctx, ['add', '--', ...remapped.values()]);
    const commit = add.success ? await gitIn(ctx, [...IDENTITY, 'commit', '-m', `tests: oracle for ${task.id}`]) : add;
    // An uncommitted oracle would be verified, then left behind as a dirty tree that blocks every later integration.
    if (!commit.success) return escalate('integration_verification_failed', `committing the oracle failed: ${(commit.stderr || commit.stdout).trim().slice(0, 300)}`, undefined, preSha);
  }

  ctx.expectedTip = await head(ctx);
  ctx.assertOwner();
  store.setArtifacts(task.id, { integration: { preSha, expectedTip: ctx.expectedTip } });

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
    ctx.assertOwner();
    const r = await ctx.run(command, ctx.iw.path);
    ctx.assertOwner();
    const tail = redact(r.output.trim().slice(-1200));
    results.push({ command, exitCode: r.exitCode, tail });
    if (r.exitCode !== 0) return escalate('integration_verification_failed', `${command.join(' ')} -> exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`, results, preSha);
  }

  const integratedCommit = await head(ctx);
  ctx.assertOwner();
  if (integratedCommit !== ctx.expectedTip) throw new Error('integration tip changed during verification');
  store.transition(task.id, 'DONE', { actor: ctx.actor, reason: 'integrated and verified', expectFrom: 'INTEGRATING', patch: { implementedBy: task.executor === 'claude' ? 'claude' : 'worker', artifacts: { integration: { preSha, integratedCommit, commands: results } } } });
  ctx.log(`integrated ${task.id} -> ${integratedCommit.slice(0, 10)}`);
  return { taskId: task.id, outcome: 'DONE', integratedCommit, commands: results };
}

async function conflictEvidence(ctx: Ctx, task: TaskRow, files: string[], integrationTip: string, mergeBase: string): Promise<ConflictEvidence> {
  const integratedSince: ConflictEvidence['integratedSince'] = [];
  const markers: ConflictEvidence['markers'] = [];
  for (const file of files.slice(0, 10)) {
    const log = await gitIn(ctx, ['log', '--format=%h %an: %s', '-n', '10', `${mergeBase}..${integrationTip}`, '--', file]);
    integratedSince.push({ file, commits: log.stdout.split('\n').filter(Boolean) });
    const content = await readFile(join(ctx.iw.path, file), 'utf8').catch(() => '(unreadable)');
    markers.push({ file, excerpt: redact(content.slice(0, 2_000)) });
  }
  const conflictingTasks = ctx.store
    .listTasks({ batchId: ctx.batch.id, states: ['DONE'] })
    .map((t) => ({ taskId: t.id, files: ownedFilesOf(t.spec).filter((f) => files.includes(f)) }))
    .filter((c) => c.files.length > 0);
  return { files, integrationTip, taskHead: task.headCommit, mergeBase, integratedSince, conflictingTasks, markers };
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
  const ownership = await integrationOwnership(store, worktrees, batch.repository, 'claude-engineering-lead', 20 * 60_000);
  if (!ownership) throw new Error('integration locked');
  try {
    const iw = await worktrees.integrationWorktree(batch, () => ownership.assert());
    const ctx: Ctx = { store, worktrees, batch, iw, run: input.run ?? defaultRunner, log: () => {}, actor: 'claude-engineering-lead', assertOwner: () => ownership.assert() };
    const ancestor = await gitIn(ctx, ['merge-base', '--is-ancestor', input.commit, 'HEAD']);
    if (!ancestor.success) throw new StoreError('invalid', `commit ${input.commit} is not on the integration branch ${iw.branch}`);
    const results: NonNullable<IntegrationReport['commands']> = [];
    for (const command of batch.integrationCommands) {
      const problems = await validateCommand(command, iw.path, {});
      if (problems.length > 0) throw new StoreError('invalid', problems.join('; '));
      ctx.assertOwner();
      const r = await ctx.run(command, iw.path);
      ctx.assertOwner();
      results.push({ command, exitCode: r.exitCode, tail: redact(r.output.trim().slice(-1200)) });
      if (r.exitCode !== 0) throw new StoreError('invalid', `integration verification failed: ${command.join(' ')} -> exit ${r.exitCode}`);
    }
    ctx.assertOwner();
    store.transition(task.id, 'DONE', { actor: ctx.actor, reason: input.note, expectFrom: 'CODING', patch: { implementedBy: 'claude', artifacts: { claudeDirect: { commit: input.commit, note: input.note, reason: task.spec.keptReason ?? task.artifacts.claudeReason ?? null, commands: results } } } });
    return { taskId: task.id, outcome: 'DONE', integratedCommit: input.commit, commands: results };
  } finally { await ownership.release(); }
}

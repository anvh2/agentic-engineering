import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runControlledCommand } from '../../workers/tools/execution-tools.ts';
import { EvidenceError, gitStatusEntries, incompleteInspection, inspectChange, type ChangeInspection } from '../review/change-review.ts';
import { resolveCapacity } from '../execution/delegation-capacity.ts';
import { ownedFilesOf } from '../scheduler/types.ts';
import type { BatchRow, TaskRow } from '../scheduler/store.ts';
import { assertTargetIdentity, assertWorktreeOwnedBy, ensureWorktreesExcluded, resolveTargetRepository, type TargetRepository } from '../project/target-repository.ts';

/**
 * Isolated Git worktrees for coding tasks. Layout (all under a root, never inside the user's working tree):
 *
 *   <root>/<batch>/<task>/        task worktree on branch  lead-task/<batch>/<task>
 *   <root>/<batch>/_integration/  integration worktree on branch  lead-integration/<batch>
 *
 * Two layouts. `new WorktreeManager(dir)` puts every repository's worktrees under one fixed directory (tests, isolated
 * previews). `WorktreeManager.targetOwned()` is the production layout: the root is the TARGET repository's own
 * `<canonical root>/.worktrees`, taken from the identity recorded on the batch, so a target's worktrees always belong to
 * its git common dir and never land in the framework checkout. In that layout every use re-checks the identity first.
 *
 * Worktrees are cut from COMMITS (the integration branch tip), so the user's working tree, index and uncommitted
 * changes are never touched. Because of that, a task whose files have uncommitted edits in the source repo is refused
 * (`source_tree_dirty`): the worker would silently work from stale content. Nothing here pushes, and nothing deletes
 * a worktree without first proving it is one this manager created.
 */

export class WorkspaceError extends Error {
  code: 'source_tree_dirty' | 'git_failed' | 'unsafe_path' | 'not_a_task_worktree';
  constructor(code: WorkspaceError['code'], message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export interface Workspace {
  /** `preserve`: re-attach to an existing task worktree WITHOUT resetting it (to adopt a finished earlier run). */
  prepare(task: TaskRow, batch: BatchRow, options?: { preserve?: boolean }): Promise<{ path: string; branch: string; baseCommit: string }>;
  /**
   * Checked immediately before a worker is handed the worktree: the batch's target is still the recorded repository and the
   * worktree belongs to it. Throws TargetRepositoryError (fail closed). Optional for test doubles.
   */
  verifyOwnership?(task: TaskRow, batch: BatchRow): void;
  inspect(task: TaskRow): Promise<ChangeInspection>;
  /** Commits the task's allowed-file changes on its own task branch (never the user's branch). Returns the commit. */
  commit(task: TaskRow): Promise<string>;
}

export function baseRefName(batchId: string): string {
  return `refs/lead/base/${batchId}`;
}

const IDENTITY = ['-c', 'user.name=agentic-engineering', '-c', 'user.email=agentic@localhost', '-c', 'commit.gpgsign=false'];

export function taskBranch(batchId: string, taskId: string): string {
  return `lead-task/${batchId}/${taskId}`;
}
export function integrationBranch(batchId: string): string {
  return `lead-integration/${batchId}`;
}

export class WorktreeManager implements Workspace {
  /** The fixed root (fixed layout). In the target-owned layout it is unused for placement; see rootFor(). */
  readonly root: string;
  readonly layout: 'fixed' | 'target-owned';
  /** Production layout: each target's worktrees live in its own `<canonical root>/.worktrees`. */
  static targetOwned(): WorktreeManager {
    return new WorktreeManager('', 'target-owned');
  }
  /** Git takes repository-wide lock files for ref/worktree writes, so mutating ops on one repo are serialized here. */
  private repoQueues = new Map<string, Promise<unknown>>();

  /** Runs fn after every earlier call for the same repository has settled. */
  async withRepoLock<T>(repository: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.repoQueues.get(repository) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.repoQueues.set(repository, next);
    try {
      return await next;
    } finally {
      if (this.repoQueues.get(repository) === next) this.repoQueues.delete(repository);
    }
  }

  constructor(root: string, layout: 'fixed' | 'target-owned' = 'fixed') {
    if (layout === 'fixed' && !root) throw new Error('WorktreeManager: a fixed layout needs a root directory');
    this.layout = layout;
    this.root = layout === 'fixed' ? resolve(root) : '';
  }

  /**
   * The batch's target identity: the recorded one (re-checked against the repository on disk), or for a batch created before
   * targets were recorded, resolved now. Null only in the fixed layout without a recorded target (nothing to check).
   */
  targetOf(batch: Pick<BatchRow, 'repository' | 'target'>): TargetRepository | null {
    if (batch.target) {
      assertTargetIdentity(batch.target, batch.repository);
      return batch.target;
    }
    return this.layout === 'target-owned' ? resolveTargetRepository(batch.repository) : null;
  }

  /** Where this batch's worktrees live. */
  rootFor(batch: Pick<BatchRow, 'repository' | 'target'>): string {
    if (this.layout === 'fixed') return this.root;
    return this.targetOf(batch)!.worktreeRoot;
  }

  taskPath(batchId: string, taskId: string, batch?: Pick<BatchRow, 'repository' | 'target'>): string {
    return join(batch ? this.rootFor(batch) : this.root, batchId, taskId);
  }
  integrationPath(batchId: string, batch?: Pick<BatchRow, 'repository' | 'target'>): string {
    return join(batch ? this.rootFor(batch) : this.root, batchId, '_integration');
  }

  /** See Workspace.verifyOwnership. */
  verifyOwnership(task: TaskRow, batch: BatchRow): void {
    const target = this.targetOf(batch);
    if (target && task.worktreePath) assertWorktreeOwnedBy(target, task.worktreePath);
  }

  async git(cwd: string, args: string[], timeoutMs = 60_000) {
    return runControlledCommand('git', args, { cwd, timeoutMs });
  }

  private async mustGit(cwd: string, args: string[], assertOwner: () => void = () => {}): Promise<string> {
    assertOwner();
    const r = await this.git(cwd, args);
    if (!r.success) throw new WorkspaceError('git_failed', `git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    return r.stdout.trim();
  }

  /** Runs git with extra environment (the stock runner has none); used only for the temporary-index snapshot. */
  private gitEnv(cwd: string, args: string[], env: Record<string, string>, assertOwner: () => void = () => {}): Promise<string> {
    assertOwner();
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
        err ? reject(new WorkspaceError('git_failed', `git ${args.join(' ')} failed: ${(stderr || err.message).trim().slice(0, 400)}`)) : resolve(stdout.trim()),
      );
    });
  }

  /**
   * HEAD + exactly `paths` (modified or untracked), as a commit object built in a TEMPORARY index. The user's index,
   * branches and working tree are untouched; the commit is unreferenced until the integration branch points at it.
   */
  private async snapshotCommit(repository: string, baseCommit: string, paths: string[], assertOwner: () => void = () => {}): Promise<string> {
    for (const p of paths) if (isAbsolute(p) || p.split('/').includes('..')) throw new WorkspaceError('unsafe_path', `snapshot path ${p} must be repo-relative without ..`);
    const dir = await mkdtemp(join(tmpdir(), 'lead-snapshot-'));
    try {
      const env = { GIT_INDEX_FILE: join(dir, 'index') };
      await this.gitEnv(repository, ['read-tree', baseCommit], env, assertOwner);
      const present = paths.filter((p) => existsSync(join(repository, p)));
      if (present.length > 0) await this.gitEnv(repository, ['add', '--', ...present], env, assertOwner);
      const tree = await this.gitEnv(repository, ['write-tree'], env, assertOwner);
      return await this.gitEnv(repository, [...IDENTITY, 'commit-tree', tree, '-p', baseCommit, '-m', `snapshot of ${paths.length} uncommitted file(s) for batch base`], env, assertOwner);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Creates (once) the batch's integration branch and pins its base at refs/lead/base/<batch>, without touching the
   * user's checkout. With `snapshotPaths` the base is HEAD + those uncommitted files, so workers see the code the
   * batch builds on.
   */
  async ensureIntegrationBranch(batch: BatchRow, assertOwner: () => void = () => {}): Promise<{ branch: string; baseCommit: string }> {
    const branch = integrationBranch(batch.id);
    const existing = await this.git(batch.repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (existing.success) {
      const base = await this.git(batch.repository, ['rev-parse', '--verify', '--quiet', baseRefName(batch.id)]);
      return { branch, baseCommit: base.success ? base.stdout.trim() : existing.stdout.trim() };
    }
    let baseCommit = await this.mustGit(batch.repository, ['rev-parse', '--verify', `${batch.baseRef ?? 'HEAD'}^{commit}`]);
    if (batch.snapshotPaths.length > 0) baseCommit = await this.snapshotCommit(batch.repository, baseCommit, batch.snapshotPaths, assertOwner);
    await this.mustGit(batch.repository, ['update-ref', baseRefName(batch.id), baseCommit], assertOwner);
    await this.mustGit(batch.repository, ['branch', branch, baseCommit], assertOwner);
    return { branch, baseCommit };
  }

  /**
   * Files the worktree would show STALE content for: the working-tree copy differs from the batch base the worktree
   * is cut from (the user edited it after the base was fixed, or it is uncommitted and not in snapshotPaths).
   * A file absent from both the working tree and the base is fine (a task of this batch creates it).
   */
  async staleSourceFiles(batch: BatchRow, files: string[]): Promise<string[]> {
    const { baseCommit } = await this.ensureIntegrationBranch(batch);
    const stale: string[] = [];
    for (const f of files) {
      const baseBlob = await this.git(batch.repository, ['rev-parse', '--verify', '--quiet', `${baseCommit}:${f}`]);
      const base = baseBlob.success ? baseBlob.stdout.trim() : null;
      const wt = existsSync(join(batch.repository, f)) ? (await this.git(batch.repository, ['hash-object', '--', f])).stdout.trim() : null;
      if (wt !== base) stale.push(f);
    }
    return stale;
  }

  async integrationTip(batch: BatchRow): Promise<string> {
    return this.mustGit(batch.repository, ['rev-parse', '--verify', `refs/heads/${integrationBranch(batch.id)}`]);
  }

  /** The directory must be an existing git worktree of `repository` located under its worktree root. */
  private async assertManaged(path: string, repository: string, root: string): Promise<void> {
    const rel = relative(root, resolve(path));
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '') throw new WorkspaceError('unsafe_path', `${path} is outside the worktree root ${root}`);
    const real = await realpath(path).catch(() => undefined);
    const list = await this.mustGit(repository, ['worktree', 'list', '--porcelain']);
    const registered = list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
    if (!real || !registered.some((w) => w === real || w === path)) throw new WorkspaceError('not_a_task_worktree', `${path} is not a registered worktree of ${repository}`);
  }

  prepare(task: TaskRow, batch: BatchRow, options: { preserve?: boolean } = {}): Promise<{ path: string; branch: string; baseCommit: string }> {
    return this.withRepoLock(batch.repository, () => this.prepareLocked(task, batch, options));
  }

  private async prepareLocked(task: TaskRow, batch: BatchRow, options: { preserve?: boolean }): Promise<{ path: string; branch: string; baseCommit: string }> {
    const { repository } = batch;
    // Identity first: a target that moved, was replaced or is not the recorded repository gets no worktree at all.
    const target = this.targetOf(batch);
    const root = this.rootFor(batch);
    if (target && this.layout === 'target-owned') ensureWorktreesExcluded(target);
    const spec = task.spec.request?.contract;
    const touched = [...new Set([...(spec?.allowedFiles ?? task.spec.ownedFiles), ...(spec?.contextFiles ?? [])])];

    // The worktree is cut from the batch base commit: a source file edited since then (or uncommitted and not in the
    // batch's snapshotPaths) would be invisible to the worker, which would then work on stale content.
    const stale = await this.staleSourceFiles(batch, touched);
    if (stale.length > 0) {
      throw new WorkspaceError('source_tree_dirty', `the source repository has changes to files this task uses that the batch base does not contain (${stale.join(', ')}); commit or stash them, or list them in the plan's snapshotPaths`);
    }

    const { branch: intBranch } = await this.ensureIntegrationBranch(batch);
    const path = join(root, batch.id, task.id);
    const branch = taskBranch(batch.id, task.id);

    if (existsSync(path)) {
      // Re-claim after a crash / lease expiry: reuse the worktree, but only after proving it is ours, then reset it.
      await this.assertManaged(path, repository, root);
      const head = await this.mustGit(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (head !== branch) throw new WorkspaceError('not_a_task_worktree', `${path} is on branch ${head}, expected ${branch}`);
      const baseCommit = task.baseCommit ?? (await this.mustGit(path, ['rev-parse', 'HEAD']));
      if (!options.preserve) {
        await this.mustGit(path, ['reset', '--hard', baseCommit]);
        await this.mustGit(path, ['clean', '-fd']);
      }
      await this.linkPaths(repository, path, batch.linkPaths);
      if (target) assertWorktreeOwnedBy(target, path);
      return { path, branch, baseCommit };
    }

    const baseCommit = await this.mustGit(repository, ['rev-parse', '--verify', `refs/heads/${intBranch}`]);
    await mkdir(dirname(path), { recursive: true });
    const leftover = await this.git(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    // A leftover branch without a worktree (worktree dir was removed) is re-pointed at the base; the old tip stays in the reflog.
    await this.mustGit(repository, leftover.success ? ['worktree', 'add', '-B', branch, path, baseCommit] : ['worktree', 'add', '-b', branch, path, baseCommit]);
    await this.linkPaths(repository, path, batch.linkPaths);
    if (target) assertWorktreeOwnedBy(target, path);
    return { path, branch, baseCommit };
  }

  /** Symlinks ignored/untracked dependency dirs (node_modules...) from the source repo. Only into a fresh, managed worktree. */
  private async linkPaths(repository: string, worktree: string, paths: string[]): Promise<void> {
    for (const p of paths) {
      if (isAbsolute(p) || p.split('/').includes('..')) throw new WorkspaceError('unsafe_path', `linkPath ${p} must be repo-relative without ..`);
      const source = join(repository, p);
      const dest = join(worktree, p);
      if (!existsSync(source) || (await lstat(dest).catch(() => undefined))) continue;
      await mkdir(dirname(dest), { recursive: true });
      await symlink(source, dest);
    }
  }

  /** The batch's integration worktree (created on first use). All merges and integration tests happen here, never in the user's checkout. */
  integrationWorktree(batch: BatchRow, assertOwner: () => void = () => {}): Promise<{ path: string; branch: string }> {
    return this.withRepoLock(batch.repository, async () => {
      assertOwner();
      const target = this.targetOf(batch); // integration is refused on a target that is not the recorded repository
      const root = this.rootFor(batch);
      if (target && this.layout === 'target-owned') ensureWorktreesExcluded(target);
      const { branch } = await this.ensureIntegrationBranch(batch, assertOwner);
      const path = join(root, batch.id, '_integration');
      if (existsSync(path)) {
        await this.assertManaged(path, batch.repository, root);
        const head = await this.mustGit(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (head !== branch) throw new WorkspaceError('not_a_task_worktree', `${path} is on ${head}, expected ${branch}`);
      } else {
        await mkdir(dirname(path), { recursive: true });
        await this.mustGit(batch.repository, ['worktree', 'add', path, branch], assertOwner);
      }
      await this.linkPaths(batch.repository, path, batch.linkPaths);
      if (target) assertWorktreeOwnedBy(target, path);
      return { path, branch };
    });
  }

  async inspect(task: TaskRow): Promise<ChangeInspection> {
    const path = this.requirePath(task);
    const capacity = resolveCapacity(task.spec.capacity);
    let statusBefore: string[];
    try {
      statusBefore = await this.baselineStatus(task);
    } catch (err) {
      // Unreadable evidence is a blocking finding (ESCALATED for a human), not a runtime failure that could be requeued.
      if (err instanceof EvidenceError) return incompleteInspection(`baseline status: ${err.message}`, capacity);
      throw err;
    }
    return inspectChange({ repoRoot: path, allowedFiles: ownedFilesOf(task.spec), statusBefore, capacity });
  }

  /** Entries present before the worker ran: link symlinks only (the worktree starts clean otherwise). */
  private async baselineStatus(task: TaskRow): Promise<string[]> {
    const path = this.requirePath(task);
    const links = (task.artifacts.linkPaths as string[] | undefined) ?? [];
    const entries = await gitStatusEntries(path);
    return entries.filter((e) => links.some((l) => e.slice(3) === l || e.slice(3) === `${l}/`));
  }

  async commit(task: TaskRow): Promise<string> {
    const path = this.requirePath(task);
    const files = ownedFilesOf(task.spec);
    await this.mustGit(path, ['add', '--', ...files]);
    const staged = await this.mustGit(path, ['diff', '--cached', '--name-only']);
    const stagedFiles = staged.split('\n').filter(Boolean);
    const extra = stagedFiles.filter((f) => !files.includes(f));
    if (extra.length > 0) throw new WorkspaceError('git_failed', `refusing to commit files outside the allowed set: ${extra.join(', ')}`);
    if (stagedFiles.length === 0) throw new WorkspaceError('git_failed', 'nothing to commit: the worktree has no change to the allowed files');
    await this.mustGit(path, [...IDENTITY, 'commit', '-m', `${task.id}: ${task.title}\n\nTask worktree commit by local worker ${task.assignedWorker ?? 'unknown'}; run ${task.runId ?? 'n/a'}.`]);
    return this.mustGit(path, ['rev-parse', 'HEAD']);
  }

  private requirePath(task: TaskRow): string {
    if (!task.worktreePath) throw new WorkspaceError('not_a_task_worktree', `task ${task.id} has no worktree`);
    return task.worktreePath;
  }

  /** Lists worktree directories under the repository's worktree root (real paths, for reconciliation). */
  async listManagedPaths(repository: string, batch?: Pick<BatchRow, 'repository' | 'target'>): Promise<string[]> {
    const list = await this.mustGit(repository, ['worktree', 'list', '--porcelain']);
    const base = this.layout === 'fixed' ? this.root : this.rootFor(batch ?? { repository, target: null });
    const root = await realpath(base).catch(() => base);
    return list
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length))
      .filter((p) => !relative(root, p).startsWith('..'));
  }

  /** Removes a finished task's worktree. Refuses anything not proven to be a managed, clean-or-committed worktree. */
  async remove(task: TaskRow, repository: string, batch?: Pick<BatchRow, 'repository' | 'target'>): Promise<boolean> {
    const path = task.worktreePath;
    if (!path || !existsSync(path)) return false;
    await this.assertManaged(path, repository, this.layout === 'fixed' ? this.root : this.rootFor(batch ?? { repository, target: null }));
    const status = await this.mustGit(path, ['status', '--porcelain']);
    const ignoredLinks = (task.artifacts.linkPaths as string[] | undefined) ?? [];
    const dirty = status.split('\n').filter((l) => l && !ignoredLinks.some((p) => l.slice(3).replace(/\/$/, '') === p));
    if (dirty.length > 0) throw new WorkspaceError('unsafe_path', `refusing to remove ${path}: it has uncommitted changes (${dirty.join('; ')})`);
    await this.mustGit(repository, ['worktree', 'remove', path]);
    return true;
  }
}

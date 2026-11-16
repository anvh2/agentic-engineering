import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { findProjectRoot } from '../../core/paths.ts';

/**
 * The TARGET repository a batch operates on, as opposed to the FRAMEWORK repository this runtime is installed in.
 *
 * The two used to be conflated: worktrees for every target were created under the framework checkout's `.workdir/worktrees`,
 * so a CloudFarm task branch was a worktree of CloudFarm living inside agentic-engineering. Now each batch records the
 * identity of its target when it is created, worktrees live in the target's own `<canonical root>/.worktrees/`, and the
 * identity is checked again before every worker execution, verification and integration. Anything that does not match
 * fails closed (`repository_identity_mismatch`); nothing here moves or deletes an existing worktree.
 */

export const TARGET_SCHEMA = 'agentic.target-repository/1';
/** Directory inside the target's canonical root that holds runtime-created worktrees. */
export const TARGET_WORKTREE_DIR = '.worktrees';

export interface TargetRepository {
  schema: typeof TARGET_SCHEMA;
  /** `repo-` + sha256(root commit, git common dir): stable while the repository stays where it is. */
  repositoryId: string;
  /** Real path of the repository's main worktree (the primary checkout), never a linked worktree. */
  canonicalRoot: string;
  /** Real path of the shared Git directory every worktree of this repository belongs to. */
  gitCommonDir: string;
  /** First root commit, or null for a repository without commits. */
  rootCommit: string | null;
  /** remote.origin.url with any embedded credentials removed; null when there is none. */
  origin: string | null;
  /** Where this runtime creates worktrees for the target: `<canonicalRoot>/.worktrees`. */
  worktreeRoot: string;
  /** True when the target is the framework repository itself (self-hosting). Recorded, never silently assumed. */
  isFramework: boolean;
}

export type TargetErrorCode = 'not_a_repository' | 'bare_repository' | 'repository_identity_mismatch' | 'worktree_not_owned';

export class TargetRepositoryError extends Error {
  readonly code: TargetErrorCode;
  constructor(code: TargetErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'TargetRepositoryError';
    this.code = code;
  }
}

/** git with an environment that cannot redirect it to another repository (GIT_DIR and friends are dropped). */
function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const tryGit = (cwd: string, args: string[]): string | null => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Strips `user:password@` from an https remote; ssh remotes carry no secret. */
export function sanitizeRemote(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/^(https?:\/\/)[^/@]+@/i, '$1');
}

let frameworkCommonDir: string | null | undefined;
/** The framework checkout's git common dir, found from this module's location (not the cwd, which may be a target). */
export function frameworkGitCommonDir(): string | null {
  if (frameworkCommonDir !== undefined) return frameworkCommonDir;
  const root = findProjectRoot(import.meta.dirname);
  const dir = root ? tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']) : null;
  frameworkCommonDir = dir ? real(dir) : null;
  return frameworkCommonDir;
}

/** Resolves the target repository that contains `path` (any worktree of it). Throws TargetRepositoryError; never guesses. */
export function resolveTargetRepository(path: string, options: { frameworkCommonDir?: string | null } = {}): TargetRepository {
  if (!isAbsolute(path)) throw new TargetRepositoryError('not_a_repository', `target repository path must be absolute, got ${path}`);
  if (!existsSync(path)) throw new TargetRepositoryError('not_a_repository', `${path} does not exist`);
  const bare = tryGit(path, ['rev-parse', '--is-bare-repository']);
  if (bare === null) throw new TargetRepositoryError('not_a_repository', `${path} is not inside a git repository`);
  if (bare === 'true') throw new TargetRepositoryError('bare_repository', `${path} is a bare repository; a target needs a checkout`);
  const commonDir = real(git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  // The main worktree is the first entry of `worktree list`, whichever worktree we were handed.
  const main = git(path, ['worktree', 'list', '--porcelain']).split('\n').find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
  if (!main) throw new TargetRepositoryError('not_a_repository', `cannot determine the main worktree of ${path}`);
  const canonicalRoot = real(main);
  const roots = tryGit(path, ['rev-list', '--max-parents=0', 'HEAD']);
  const rootCommit = roots ? (roots.split('\n').filter(Boolean).sort()[0] ?? null) : null;
  const origin = sanitizeRemote(tryGit(path, ['config', '--get', 'remote.origin.url']));
  const framework = options.frameworkCommonDir === undefined ? frameworkGitCommonDir() : options.frameworkCommonDir;
  return {
    schema: TARGET_SCHEMA,
    repositoryId: `repo-${createHash('sha256').update(`${rootCommit ?? '(no commits)'}\n${commonDir}`).digest('hex').slice(0, 24)}`,
    canonicalRoot,
    gitCommonDir: commonDir,
    rootCommit,
    origin,
    worktreeRoot: join(canonicalRoot, TARGET_WORKTREE_DIR),
    isFramework: framework !== null && framework === commonDir,
  };
}

/**
 * Re-resolves `path` and refuses when it is no longer the recorded repository (moved, replaced, re-cloned, or a different
 * repository at the same path). Returns the fresh identity.
 */
export function assertTargetIdentity(recorded: Pick<TargetRepository, 'repositoryId' | 'gitCommonDir'>, path: string): TargetRepository {
  let now: TargetRepository;
  try {
    now = resolveTargetRepository(path);
  } catch (err) {
    throw new TargetRepositoryError('repository_identity_mismatch', `recorded target ${recorded.repositoryId} cannot be resolved at ${path}: ${(err as Error).message}`);
  }
  if (now.repositoryId !== recorded.repositoryId || now.gitCommonDir !== recorded.gitCommonDir) {
    throw new TargetRepositoryError('repository_identity_mismatch', `${path} is now ${now.repositoryId} (${now.gitCommonDir}), but the batch was created for ${recorded.repositoryId} (${recorded.gitCommonDir})`);
  }
  return now;
}

/**
 * A worktree a worker, verifier or integrator is about to use must belong to the recorded target's git common dir and lie
 * under its worktree root. Anything else (a worktree of the framework repository, a stray directory, another clone) is refused.
 */
export function assertWorktreeOwnedBy(target: Pick<TargetRepository, 'gitCommonDir' | 'worktreeRoot' | 'repositoryId'>, worktreePath: string): void {
  const rel = relative(real(target.worktreeRoot), real(worktreePath));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new TargetRepositoryError('worktree_not_owned', `${worktreePath} is outside the target's worktree root ${target.worktreeRoot}`);
  const common = tryGit(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common || real(common) !== target.gitCommonDir) throw new TargetRepositoryError('worktree_not_owned', `${worktreePath} belongs to ${common ?? 'no repository'}, not to target ${target.repositoryId} (${target.gitCommonDir})`);
}

/**
 * Makes `.worktrees/` invisible to the target's `git status` without committing anything: appends one line to the common
 * dir's `info/exclude` unless the path is already ignored. Local, reversible, and never touches tracked files.
 */
export function ensureWorktreesExcluded(target: Pick<TargetRepository, 'canonicalRoot' | 'gitCommonDir'>): boolean {
  if (tryGit(target.canonicalRoot, ['check-ignore', '-q', '--no-index', `${TARGET_WORKTREE_DIR}/probe`]) !== null) return false; // already ignored
  const exclude = join(target.gitCommonDir, 'info', 'exclude');
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (current.split('\n').some((l) => l.trim() === `/${TARGET_WORKTREE_DIR}/`)) return false;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# agentic-engineering task worktrees\n/${TARGET_WORKTREE_DIR}/\n`);
  return true;
}

/** Parses a stored identity (scheduler database JSON). Malformed data is refused, never repaired. */
export function parseTargetRepository(value: unknown): TargetRepository {
  const v = value as Partial<TargetRepository> | null;
  const str = (x: unknown) => typeof x === 'string' && x.length > 0;
  if (!v || v.schema !== TARGET_SCHEMA || !str(v.repositoryId) || !str(v.canonicalRoot) || !str(v.gitCommonDir) || !str(v.worktreeRoot) || typeof v.isFramework !== 'boolean') {
    throw new TargetRepositoryError('repository_identity_mismatch', 'stored target identity is malformed');
  }
  return v as TargetRepository;
}

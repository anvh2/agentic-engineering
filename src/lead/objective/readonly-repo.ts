import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { run } from '../session/run.ts';

/**
 * The only way planning touches a target repository. Two pieces:
 *
 *  - `readGit`: runs git with an allow-list of read-only subcommands (and --no-optional-locks, so even `status` leaves
 *    the index alone). Anything else is refused before a process starts.
 *  - `fingerprintRepository`: a digest of everything a mutation could change (HEAD, refs, the porcelain status and the
 *    size/mtime of every dirty path). The orchestrator compares it before and after research and planning.
 */

export class PlanningIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningIsolationError';
  }
}

// Deliberately tiny: subcommands that cannot write even with unusual flags (`diff --output`, `symbolic-ref <ref> <v>` can).
const READ_ONLY_GIT = new Set(['rev-parse', 'ls-files', 'status', 'for-each-ref']);

export async function readGit(repo: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const [sub] = args;
  if (!READ_ONLY_GIT.has(sub)) throw new PlanningIsolationError(`git ${sub} is not a read-only command; planning may not run it`);
  const result = await run('git', ['--no-optional-locks', ...args], { cwd: repo, timeoutMs });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.startError ?? (result.timedOut ? 'timed out' : result.stderr.trim())}`);
  return result.stdout;
}

/** The git work tree root for `path`, or throws. The objective's repository must BE that root (the scheduler's batch repository). */
export async function requireGitRoot(path: string): Promise<string> {
  const dir = resolve(path);
  if (!(await lstat(dir).catch(() => undefined))?.isDirectory()) throw new Error(`repository ${dir} is not a directory`);
  const top = (await readGit(dir, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
  if (!top) throw new Error(`repository ${dir} is not a git work tree`);
  const [a, b] = await Promise.all([realpath(top), realpath(dir)]);
  if (a !== b) throw new Error(`repository ${dir} is inside the git work tree ${top}; point the objective at the repository root`);
  return dir;
}

export interface PorcelainEntry {
  code: string;
  path: string;
}

export async function dirtyEntries(repo: string): Promise<PorcelainEntry[]> {
  const raw = await readGit(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const tokens = raw.split('\0');
  const out: PorcelainEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    out.push({ code: token.slice(0, 2), path: token.slice(3) });
    if (token[0] === 'R' || token[0] === 'C') i++; // skip the rename source
  }
  return out;
}

export async function headCommit(repo: string): Promise<string> {
  return (await readGit(repo, ['rev-parse', 'HEAD']).catch(() => 'unborn')).trim();
}

export async function fingerprintRepository(repo: string): Promise<string> {
  const [head, refs, dirty] = await Promise.all([headCommit(repo), readGit(repo, ['for-each-ref', '--format=%(refname) %(objectname)']), dirtyEntries(repo)]);
  const stats: string[] = [];
  for (const entry of dirty) {
    const info = await lstat(join(repo, entry.path)).catch(() => undefined);
    stats.push(`${entry.code} ${entry.path} ${info ? `${info.size}:${info.mtimeMs}` : 'missing'}`);
  }
  return createHash('sha256').update(JSON.stringify({ head, refs, stats })).digest('hex');
}

/** Runs `fn` and throws PlanningIsolationError if the repository's fingerprint changed while it ran (even if `fn` threw). */
export async function assertUnchanged<T>(repo: string, phase: string, fn: () => Promise<T>): Promise<T> {
  const before = await fingerprintRepository(repo);
  const changed = async () => before !== (await fingerprintRepository(repo));
  const violation = () => new PlanningIsolationError(`the target repository changed during ${phase}; planning must be read-only, so the result was discarded`);
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    if (await changed()) throw violation();
    throw err;
  }
  if (await changed()) throw violation();
  return result;
}

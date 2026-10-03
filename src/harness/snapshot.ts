import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { git, gitExitCode } from './run.ts';
import type { RepoSnapshot, WorktreeEntry } from './types.ts';

/**
 * Objective repository facts, read from git and the filesystem only. Never
 * reads diff contents: dirty files are fingerprinted by blob hash and size,
 * so secrets in locally-modified config files never reach a checkpoint.
 */

export const MAX_ENTRIES = 500;
export const MAX_HASH_BYTES = 5 * 1024 * 1024;
const CHUNK = 100;

export function isExpectedLocal(path: string, expectedLocal: string[]): boolean {
  return expectedLocal.some((p) => (p.endsWith('/') ? path === p || path.startsWith(p) : path === p));
}

interface StatusLine {
  code: string;
  path: string;
}

/** Parses `git status --porcelain=v1 -z` output. Renames/copies carry an extra NUL-separated source path. */
export function parsePorcelainZ(raw: string): StatusLine[] {
  const tokens = raw.split('\0');
  const lines: StatusLine[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    lines.push({ code, path: token.slice(3) });
    if (code[0] === 'R' || code[0] === 'C') i++; // skip the source path
  }
  return lines;
}

export function foldExpectedDirs(lines: StatusLine[], expectedLocal: string[]): StatusLine[] {
  const dirs = expectedLocal.filter((p) => p.endsWith('/'));
  const out: StatusLine[] = [];
  const folded = new Set<string>();
  for (const line of lines) {
    const dir = line.code === '??' ? dirs.find((d) => line.path.startsWith(d)) : undefined;
    if (!dir) out.push(line);
    else if (!folded.has(dir)) {
      folded.add(dir);
      out.push({ code: '??', path: dir });
    }
  }
  return out;
}

export function parseShortStat(raw: string): RepoSnapshot['diffStat'] {
  const num = (re: RegExp) => Number(raw.match(re)?.[1] ?? 0);
  return {
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  };
}

async function optionalGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).trim() || null;
  } catch {
    return null;
  }
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** Size of each path in HEAD (absent from the map when not in HEAD). */
async function headSizes(cwd: string, paths: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const batch of chunks(paths)) {
    const raw = await git(cwd, ['ls-tree', '-z', '-l', 'HEAD', '--', ...batch]);
    for (const record of raw.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const size = Number(record.slice(0, tab).trim().split(/\s+/)[3]);
      if (Number.isFinite(size)) sizes.set(record.slice(tab + 1), size);
    }
  }
  return sizes;
}

async function blobHashes(cwd: string, paths: string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const batch of chunks(paths)) {
    const lines = (await git(cwd, ['hash-object', '--', ...batch])).trim().split('\n');
    batch.forEach((p, i) => hashes.set(p, lines[i]));
  }
  return hashes;
}

export async function takeSnapshot(repoPath: string, expectedLocal: string[]): Promise<RepoSnapshot> {
  const rootCommit = (await git(repoPath, ['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n').sort().join(',');
  const head = await optionalGit(repoPath, ['rev-parse', 'HEAD']);
  const headSubject = await optionalGit(repoPath, ['log', '-1', '--format=%s']);
  const branch = await optionalGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const origin = await optionalGit(repoPath, ['config', '--get', 'remote.origin.url']);

  // -uall lists files inside new directories individually, so edits to an
  // uncommitted package are fingerprinted per file. Untracked files under an
  // expected-local directory (e.g. docs/) are folded back into one entry.
  const status = foldExpectedDirs(
    parsePorcelainZ(await git(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])),
    expectedLocal,
  );
  const entriesTruncated = status.length > MAX_ENTRIES;
  const lines = status.slice(0, MAX_ENTRIES);

  const entries: WorktreeEntry[] = [];
  const toHash: string[] = [];
  for (const { code, path } of lines) {
    const entry: WorktreeEntry = {
      path,
      code,
      kind: 'file',
      sha: null,
      size: null,
      mtimeMs: null,
      headSize: null,
      expected: isExpectedLocal(path, expectedLocal),
    };
    if (path.endsWith('/')) entry.kind = 'dir';
    else {
      const st = await lstat(join(repoPath, path)).catch(() => null);
      if (!st) entry.kind = 'missing';
      else if (st.isSymbolicLink()) {
        entry.kind = 'symlink';
        entry.size = st.size;
      } else if (st.size > MAX_HASH_BYTES) {
        entry.kind = 'large';
        entry.size = st.size;
        entry.mtimeMs = Math.round(st.mtimeMs);
      } else {
        entry.size = st.size;
        toHash.push(path);
      }
    }
    entries.push(entry);
  }

  const hashes = await blobHashes(repoPath, toHash);
  const tracked = entries.filter((e) => e.code !== '??' && e.kind !== 'dir').map((e) => e.path);
  const sizes = head ? await headSizes(repoPath, tracked) : new Map<string, number>();
  for (const e of entries) {
    e.sha = hashes.get(e.path) ?? null;
    e.headSize = sizes.get(e.path) ?? null;
  }

  const diffStat = head ? parseShortStat(await git(repoPath, ['diff', 'HEAD', '--shortstat'])) : parseShortStat('');

  return { path: repoPath, rootCommit, origin, head, headSubject, branch, entries, entriesTruncated, diffStat };
}

/** Tracked files that are 0 bytes now but were non-empty in HEAD. */
export function emptiedFiles(snapshot: RepoSnapshot): string[] {
  return snapshot.entries
    .filter((e) => e.kind === 'file' && e.size === 0 && (e.headSize ?? 0) > 0)
    .map((e) => e.path);
}

export interface HeadRelation {
  /** 'same' | 'advanced' (checkpoint HEAD is an ancestor) | 'rewritten' (not an ancestor) | 'unknown' (commit not found). */
  relation: 'same' | 'advanced' | 'rewritten' | 'unknown';
  commitCount: number | null;
  log: string[];
  shortStat: string | null;
}

export async function relateHeads(repoPath: string, recorded: string | null, current: string | null): Promise<HeadRelation> {
  if (recorded === current) return { relation: 'same', commitCount: 0, log: [], shortStat: null };
  if (!recorded || !current) return { relation: 'unknown', commitCount: null, log: [], shortStat: null };
  if ((await gitExitCode(repoPath, ['cat-file', '-e', `${recorded}^{commit}`])) !== 0) {
    return { relation: 'unknown', commitCount: null, log: [], shortStat: null };
  }
  const ancestor = (await gitExitCode(repoPath, ['merge-base', '--is-ancestor', recorded, current])) === 0;
  const range = `${recorded}..${current}`;
  const count = Number((await git(repoPath, ['rev-list', '--count', range])).trim());
  const log = (await git(repoPath, ['log', '--oneline', '-n', '10', range])).trim().split('\n').filter(Boolean);
  const shortStat = (await git(repoPath, ['diff', '--shortstat', recorded, current])).trim() || null;
  return { relation: ancestor ? 'advanced' : 'rewritten', commitCount: count, log, shortStat };
}

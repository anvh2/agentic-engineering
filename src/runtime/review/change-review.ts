import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capacityFindings, type ResolvedCapacity } from '../execution/delegation-capacity.ts';
import { runControlledCommand } from '../../workers/tools/execution-tools.ts';
import { classifyWhitespaceChanges } from './whitespace-changes.ts';

/**
 * Deterministic quality gates over a worker's PASSED change, run by the runtime before the Lead reviews the diff.
 * `block` findings reject the change automatically (the tree is restored); `warn` findings are shown to the
 * Lead's review and must be acknowledged there. A PASS from the verifier is necessary, never sufficient.
 *
 * Every decision here is made on COMPLETE evidence. Git output is read through readGitEvidence, which refuses (rather than
 * cuts) anything above REVIEW_EVIDENCE_MAX_BYTES and refuses a failed or timed-out command. Evidence that cannot be read in
 * full becomes an `evidence_incomplete` block: the change escalates to a human and is never judged on a partial diff.
 */
export type FindingCode =
  | 'out_of_scope_file'
  | 'eof_newline'
  | 'whitespace_only_change'
  | 'whitespace_reindent'
  | 'too_large'
  | 'capacity_exceeded'
  | 'security_block'
  | 'security_warn'
  | 'comment_removed'
  | 'allowed_file_deleted'
  | 'evidence_incomplete'
  | 'no_change';

export interface ChangeFinding {
  code: FindingCode;
  severity: 'block' | 'warn';
  detail: string;
}

export interface ChangeInspection {
  findings: ChangeFinding[];
  /** Concatenated unified diff of the allowed files (new files diffed against /dev/null). Complete, never truncated. */
  diff: string;
  /** Allowed files that actually differ from HEAD. */
  changedAllowedFiles: string[];
  /** Everything that changed in the work tree during the task (porcelain delta). */
  newlyChangedPaths: string[];
  /** Added + deleted lines per changed allowed file, as git counts them. */
  changedLines: Record<string, number>;
  /** The delegation capacity policy the change was judged by, with where it came from. */
  capacity: ResolvedCapacity;
}

/**
 * The largest single piece of git output (a status listing, a diff, a file at HEAD) the review accepts. It bounds memory, it
 * is not a sampling size: evidence above it is refused as `evidence_incomplete`, never truncated and judged.
 */
export const REVIEW_EVIDENCE_MAX_BYTES = 32 * 1024 * 1024;
const GIT_EVIDENCE_TIMEOUT_MS = 60_000;

/** Review evidence that could not be read completely. Callers turn it into a blocking finding or an ESCALATE; never a pass. */
export class EvidenceError extends Error {
  readonly code = 'evidence_incomplete';
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceError';
  }
}

/**
 * Runs git and returns its COMPLETE stdout, or throws EvidenceError: on output above the evidence limit (`maxBytes`, default
 * REVIEW_EVIDENCE_MAX_BYTES), a timeout, a failure to start, or an exit code outside `okExitCodes` (default: 0 only).
 */
export async function readGitEvidence(repoRoot: string, args: string[], options: { okExitCodes?: readonly number[]; maxBytes?: number } = {}): Promise<{ stdout: string; exitCode: number }> {
  const maxBytes = options.maxBytes ?? REVIEW_EVIDENCE_MAX_BYTES;
  const r = await runControlledCommand('git', args, { cwd: repoRoot, timeoutMs: GIT_EVIDENCE_TIMEOUT_MS, maxOutputBytes: maxBytes });
  const label = `git ${args.join(' ')}`.slice(0, 200);
  if (r.truncated) throw new EvidenceError(`${label} produced more than ${maxBytes} bytes; the review does not judge partial evidence`);
  if (r.timedOut) throw new EvidenceError(`${label} timed out after ${GIT_EVIDENCE_TIMEOUT_MS}ms`);
  if (r.exitCode === null || !(options.okExitCodes ?? [0]).includes(r.exitCode)) {
    throw new EvidenceError(`${label} failed (exit ${r.exitCode ?? 'none'}): ${r.stderr.trim().slice(0, 200)}`);
  }
  return { stdout: r.stdout, exitCode: r.exitCode };
}

const SECURITY_BLOCK = /child_process|\beval\s*\(|new\s+Function\s*\(|\bexecSync?\b|\bspawn(Sync)?\b/;
const SECURITY_WARN = /\bfetch\s*\(|https?:\/\/|XMLHttpRequest|require\(['"](net|http|https|dgram)['"]\)|process\.env|\bfs\.(rm|unlink|writeFile)/;

/** Security patterns over every ADDED line of a unified diff (the whole diff; there is no cut-off). */
export function addedLineSecurityFindings(file: string, diffText: string): ChangeFinding[] {
  const findings: ChangeFinding[] = [];
  for (const line of diffText.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (SECURITY_BLOCK.test(line)) findings.push({ code: 'security_block', severity: 'block', detail: `${file}: added line matches a blocked pattern: ${line.slice(0, 120)}` });
    else if (SECURITY_WARN.test(line)) findings.push({ code: 'security_warn', severity: 'warn', detail: `${file}: added line needs security review: ${line.slice(0, 120)}` });
  }
  return findings;
}

/** Porcelain entries ("XY path") for the whole work tree; used as a before/after delta. Throws EvidenceError if incomplete. */
export async function gitStatusEntries(repoRoot: string): Promise<string[]> {
  const r = await readGitEvidence(repoRoot, ['status', '--porcelain', '-uall', '-z']);
  return r.stdout.split('\0').filter((e) => e.length > 3);
}

/** Added + deleted lines from `git diff --numstat` for one file. A binary change ("-\t-") cannot be reviewed as text. */
function numstatLines(file: string, out: string): number {
  const line = out.split('\n').find((l) => l.trim() !== '');
  if (line === undefined) return 0;
  const [added, deleted] = line.split('\t');
  if (added === '-' || deleted === '-') throw new EvidenceError(`${file}: git reports a binary change, which the review cannot inspect as text`);
  if (!/^\d+$/.test(added ?? '') || !/^\d+$/.test(deleted ?? '')) throw new EvidenceError(`${file}: unreadable numstat line "${line.slice(0, 80)}"`);
  return Number(added) + Number(deleted);
}

/**
 * Parses `git diff --numstat -z --no-renames` into file -> added + deleted lines. Throws EvidenceError on a binary change or
 * a record it cannot read (callers must pass --no-renames: a rename record would hide the path it came from).
 */
export function parseNumstatZ(out: string): Map<string, number> {
  const lines = new Map<string, number>();
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
    if (!m) throw new EvidenceError(`unreadable numstat record "${record.slice(0, 80)}"`);
    if (m[1] === '-' || m[2] === '-') throw new EvidenceError(`${m[3]}: git reports a binary change, which the review cannot inspect as text`);
    lines.set(m[3], Number(m[1]) + Number(m[2]));
  }
  return lines;
}

/** An inspection that blocks because its evidence could not be read; used where the inspection cannot even start. */
export function incompleteInspection(detail: string, capacity: ResolvedCapacity): ChangeInspection {
  return { findings: [{ code: 'evidence_incomplete', severity: 'block', detail }], diff: '', changedAllowedFiles: [], newlyChangedPaths: [], changedLines: {}, capacity };
}

export async function inspectChange(options: {
  repoRoot: string;
  allowedFiles: string[];
  statusBefore: string[];
  /** Required: the review never falls back to a limit the task did not carry (resolveCapacity records a default explicitly). */
  capacity: ResolvedCapacity;
}): Promise<ChangeInspection> {
  const { repoRoot, allowedFiles, statusBefore, capacity } = options;
  const findings: ChangeFinding[] = [];
  const incomplete = (detail: string) => findings.push({ code: 'evidence_incomplete', severity: 'block', detail });

  // 1. allowed-file compliance: anything that changed since the task started must be an allowed file.
  let newlyChangedPaths: string[] = [];
  try {
    const before = new Set(statusBefore);
    newlyChangedPaths = (await gitStatusEntries(repoRoot)).filter((e) => !before.has(e)).map((e) => e.slice(3));
  } catch (err) {
    if (!(err instanceof EvidenceError)) throw err;
    incomplete(`work-tree status: ${err.message}`);
  }
  for (const path of newlyChangedPaths) {
    if (!allowedFiles.includes(path)) findings.push({ code: 'out_of_scope_file', severity: 'block', detail: `${path} changed but is not an allowed file` });
  }

  let tracked = new Set<string>();
  if (allowedFiles.length > 0) {
    try {
      tracked = new Set((await readGitEvidence(repoRoot, ['ls-files', '-z', '--', ...allowedFiles])).stdout.split('\0').filter(Boolean));
    } catch (err) {
      if (!(err instanceof EvidenceError)) throw err;
      incomplete(`tracked allowed files: ${err.message}`);
      return { findings, diff: '', changedAllowedFiles: [], newlyChangedPaths, changedLines: {}, capacity };
    }
  }

  const changedAllowedFiles: string[] = [];
  const changedLines = new Map<string, number>();
  const diffs: string[] = [];
  for (const file of allowedFiles) {
    try {
      const isTracked = tracked.has(file);
      const info = await lstat(join(repoRoot, file)).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw new EvidenceError(`${file}: cannot stat (${err.code ?? err.message})`);
      });
      if (info?.isSymbolicLink()) throw new EvidenceError(`${file}: is a symbolic link; the review will not judge content it does not own`);
      if (info && !info.isFile()) throw new EvidenceError(`${file}: is not a regular file`);

      if (!info) {
        if (!isTracked) continue; // never created: nothing to review for this file
        const diff = (await readGitEvidence(repoRoot, ['diff', 'HEAD', '--', file])).stdout;
        changedAllowedFiles.push(file);
        changedLines.set(file, numstatLines(file, (await readGitEvidence(repoRoot, ['diff', 'HEAD', '--numstat', '--', file])).stdout));
        diffs.push(diff);
        findings.push({ code: 'allowed_file_deleted', severity: 'block', detail: `${file}: a tracked allowed file was deleted; delegated tasks edit files, they do not remove them` });
        continue;
      }

      const current = await readFile(join(repoRoot, file), 'utf8').catch((err: NodeJS.ErrnoException) => {
        throw new EvidenceError(`${file}: cannot read (${err.code ?? err.message})`);
      });

      let diffText: string;
      if (isTracked) {
        diffText = (await readGitEvidence(repoRoot, ['diff', 'HEAD', '--', file])).stdout;
        if (diffText.trim() === '') continue;
        changedLines.set(file, numstatLines(file, (await readGitEvidence(repoRoot, ['diff', 'HEAD', '--numstat', '--', file])).stdout));
        // The file at HEAD, complete: its final byte decides the newline check (a cut copy never ends in "\n").
        const head = (await readGitEvidence(repoRoot, ['cat-file', 'blob', `HEAD:${file}`])).stdout;
        if (head.endsWith('\n') !== current.endsWith('\n')) {
          findings.push({ code: 'eof_newline', severity: 'block', detail: `${file}: final newline ${head.endsWith('\n') ? 'removed' : 'added'}` });
        }
        // Whitespace-only lines are judged by where they are and what they are (see whitespace-changes.ts), not counted: a block
        // re-indented because the real change nested it is part of that change; reformatting elsewhere is not.
        const ws = classifyWhitespaceChanges(
          (await readGitEvidence(repoRoot, ['diff', 'HEAD', '-U0', '--', file])).stdout,
          (await readGitEvidence(repoRoot, ['diff', 'HEAD', '-w', '-U0', '--', file])).stdout,
        );
        for (const u of ws.unrelated) {
          findings.push({ code: 'whitespace_only_change', severity: 'block', detail: `${file}: ${u.count} line(s) differ only in whitespace (${u.reason}; lines ${u.lines.slice(0, 5).join(', ')}${u.lines.length > 5 ? ', ...' : ''})` });
        }
        if (ws.unrelated.length === 0 && ws.attachedReindent + ws.attachedNoise > 0) {
          findings.push({ code: 'whitespace_reindent', severity: 'warn', detail: `${file}: ${ws.attachedReindent} line(s) re-indented with the change${ws.attachedNoise ? ` and ${ws.attachedNoise} stray spacing edit(s)` : ''}; confirm it is only the nesting the change needed` });
        }
      } else {
        // `diff --no-index` exits 1 when the files differ, which for a new file is the expected answer.
        diffText = (await readGitEvidence(repoRoot, ['diff', '--no-index', '--', '/dev/null', file], { okExitCodes: [0, 1] })).stdout;
        if (current !== '' && diffText.trim() === '') throw new EvidenceError(`${file}: a non-empty new file produced no diff`);
        changedLines.set(file, current === '' ? 0 : numstatLines(file, (await readGitEvidence(repoRoot, ['diff', '--no-index', '--numstat', '--', '/dev/null', file], { okExitCodes: [0, 1] })).stdout));
        if (current !== '' && !current.endsWith('\n')) findings.push({ code: 'eof_newline', severity: 'block', detail: `${file}: new file lacks a final newline` });
      }
      changedAllowedFiles.push(file);
      diffs.push(diffText);

      // Deleting an existing comment is rarely part of the task; the Lead must see it (observed: S2 dropped a doc comment).
      // TODO/FIXME markers are excluded: replacing the stub's TODO is the task itself.
      const removedComments = diffText.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---') && /^-\s*(\/\/|\/\*|\*)/.test(l) && !/TODO|FIXME/.test(l));
      if (isTracked && removedComments.length > 0) {
        findings.push({ code: 'comment_removed', severity: 'warn', detail: `${file}: ${removedComments.length} existing comment line(s) removed: ${removedComments[0].slice(1, 100).trim()}` });
      }
      findings.push(...addedLineSecurityFindings(file, diffText));
    } catch (err) {
      if (!(err instanceof EvidenceError)) throw err;
      incomplete(err.message);
    }
  }
  findings.push(...capacityFindings(changedLines, capacity));
  if (changedAllowedFiles.length === 0 && !findings.some((f) => f.code === 'evidence_incomplete')) findings.push({ code: 'no_change', severity: 'block', detail: 'a PASS with no change to any allowed file' });

  return { findings, diff: diffs.join('\n'), changedAllowedFiles, newlyChangedPaths, changedLines: Object.fromEntries(changedLines), capacity };
}

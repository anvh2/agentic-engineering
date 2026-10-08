import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runControlledCommand } from '../../workers/tools/execution-tools.ts';
import { classifyWhitespaceChanges } from './whitespace-changes.ts';

/**
 * Deterministic quality gates over a worker's PASSED change, run by the runtime before the Lead reviews the diff.
 * `block` findings reject the change automatically (the tree is restored); `warn` findings are shown to the
 * Lead's review and must be acknowledged there. A PASS from the verifier is necessary, never sufficient.
 */
export type FindingCode =
  | 'out_of_scope_file'
  | 'eof_newline'
  | 'whitespace_only_change'
  | 'whitespace_reindent'
  | 'too_large'
  | 'security_block'
  | 'security_warn'
  | 'comment_removed'
  | 'no_change';

export interface ChangeFinding {
  code: FindingCode;
  severity: 'block' | 'warn';
  detail: string;
}

export interface ChangeInspection {
  findings: ChangeFinding[];
  /** Concatenated unified diff of the allowed files (new files diffed against /dev/null). */
  diff: string;
  /** Allowed files that actually differ from HEAD. */
  changedAllowedFiles: string[];
  /** Everything that changed in the work tree during the task (porcelain delta). */
  newlyChangedPaths: string[];
}

const SECURITY_BLOCK = /child_process|\beval\s*\(|new\s+Function\s*\(|\bexecSync?\b|\bspawn(Sync)?\b/;
const SECURITY_WARN = /\bfetch\s*\(|https?:\/\/|XMLHttpRequest|require\(['"](net|http|https|dgram)['"]\)|process\.env|\bfs\.(rm|unlink|writeFile)/;

const git = (repoRoot: string, args: string[]) => runControlledCommand('git', args, { cwd: repoRoot, timeoutMs: 30_000 });

/** Porcelain entries ("XY path") for the whole work tree; used as a before/after delta. */
export async function gitStatusEntries(repoRoot: string): Promise<string[]> {
  const r = await git(repoRoot, ['status', '--porcelain', '-uall', '-z']);
  return r.stdout.split('\0').filter((e) => e.length > 3);
}

function numstat(out: string): number {
  let total = 0;
  for (const line of out.split('\n')) {
    const [added, deleted] = line.split('\t');
    if (/^\d+$/.test(added ?? '') && /^\d+$/.test(deleted ?? '')) total += Number(added) + Number(deleted);
  }
  return total;
}

export async function inspectChange(options: {
  repoRoot: string;
  allowedFiles: string[];
  statusBefore: string[];
  maxChangedLines?: number;
}): Promise<ChangeInspection> {
  const { repoRoot, allowedFiles, statusBefore } = options;
  const maxChangedLines = options.maxChangedLines ?? 80;
  const findings: ChangeFinding[] = [];

  // 1. allowed-file compliance: anything that changed since the task started must be an allowed file.
  const before = new Set(statusBefore);
  const newlyChangedPaths = (await gitStatusEntries(repoRoot)).filter((e) => !before.has(e)).map((e) => e.slice(3));
  for (const path of newlyChangedPaths) {
    if (!allowedFiles.includes(path)) findings.push({ code: 'out_of_scope_file', severity: 'block', detail: `${path} changed but is not an allowed file` });
  }

  const changedAllowedFiles: string[] = [];
  const diffs: string[] = [];
  for (const file of allowedFiles) {
    const tracked = (await git(repoRoot, ['ls-files', '--error-unmatch', '--', file])).success;
    const current = await readFile(join(repoRoot, file), 'utf8').catch(() => undefined);
    if (current === undefined) continue;

    let diffText: string;
    let raw = 0;
    if (tracked) {
      const diff = await git(repoRoot, ['diff', 'HEAD', '--', file]);
      if (diff.stdout.trim() === '') continue;
      diffText = diff.stdout;
      raw = numstat((await git(repoRoot, ['diff', 'HEAD', '--numstat', '--', file])).stdout);
      const head = (await git(repoRoot, ['show', `HEAD:${file}`])).stdout;
      if (head.endsWith('\n') !== current.endsWith('\n')) {
        findings.push({ code: 'eof_newline', severity: 'block', detail: `${file}: final newline ${head.endsWith('\n') ? 'removed' : 'added'}` });
      }
      // Whitespace-only lines are judged by where they are and what they are (see whitespace-changes.ts), not counted: a block
      // re-indented because the real change nested it is part of that change; reformatting elsewhere is not.
      const ws = classifyWhitespaceChanges((await git(repoRoot, ['diff', 'HEAD', '-U0', '--', file])).stdout, (await git(repoRoot, ['diff', 'HEAD', '-w', '-U0', '--', file])).stdout);
      for (const u of ws.unrelated) {
        findings.push({ code: 'whitespace_only_change', severity: 'block', detail: `${file}: ${u.count} line(s) differ only in whitespace (${u.reason}; lines ${u.lines.slice(0, 5).join(', ')}${u.lines.length > 5 ? ', ...' : ''})` });
      }
      if (ws.unrelated.length === 0 && ws.attachedReindent + ws.attachedNoise > 0) {
        findings.push({ code: 'whitespace_reindent', severity: 'warn', detail: `${file}: ${ws.attachedReindent} line(s) re-indented with the change${ws.attachedNoise ? ` and ${ws.attachedNoise} stray spacing edit(s)` : ''}; confirm it is only the nesting the change needed` });
      }
    } else {
      const diff = await git(repoRoot, ['diff', '--no-index', '--', '/dev/null', file]);
      diffText = diff.stdout;
      raw = current.split('\n').length;
      if (current !== '' && !current.endsWith('\n')) findings.push({ code: 'eof_newline', severity: 'block', detail: `${file}: new file lacks a final newline` });
    }
    changedAllowedFiles.push(file);
    diffs.push(diffText);

    if (raw > maxChangedLines) findings.push({ code: 'too_large', severity: 'warn', detail: `${file}: ${raw} changed lines exceeds ${maxChangedLines}; review for unrelated edits` });

    // Deleting an existing comment is rarely part of the task; the Lead must see it (observed: S2 dropped a doc comment).
    // TODO/FIXME markers are excluded: replacing the stub's TODO is the task itself.
    const removedComments = diffText.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---') && /^-\s*(\/\/|\/\*|\*)/.test(l) && !/TODO|FIXME/.test(l));
    if (tracked && removedComments.length > 0) {
      findings.push({ code: 'comment_removed', severity: 'warn', detail: `${file}: ${removedComments.length} existing comment line(s) removed: ${removedComments[0].slice(1, 100).trim()}` });
    }

    const added = diffText.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    for (const line of added) {
      if (SECURITY_BLOCK.test(line)) findings.push({ code: 'security_block', severity: 'block', detail: `${file}: added line matches a blocked pattern: ${line.slice(0, 120)}` });
      else if (SECURITY_WARN.test(line)) findings.push({ code: 'security_warn', severity: 'warn', detail: `${file}: added line needs security review: ${line.slice(0, 120)}` });
    }
  }
  if (changedAllowedFiles.length === 0) findings.push({ code: 'no_change', severity: 'block', detail: 'a PASS with no change to any allowed file' });

  return { findings, diff: diffs.join('\n'), changedAllowedFiles, newlyChangedPaths };
}

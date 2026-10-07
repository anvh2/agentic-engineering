import type { HeadRelation } from './snapshot.ts';
import { emptiedFiles } from './snapshot.ts';
import { compareTests } from './tests.ts';
import type { Checkpoint, Finding, RepoSnapshot, TestResult, WorktreeEntry } from './types.ts';

/**
 * Pure comparison of a checkpoint against current repository evidence.
 * Repository evidence wins: findings report both values and never mutate
 * the checkpoint. All I/O (snapshot, head relation, file existence, tests)
 * is done by the caller and passed in.
 */

export interface ReconcileInput {
  checkpoint: Checkpoint;
  now: RepoSnapshot;
  heads: HeadRelation;
  missingReferences: string[];
  /** null when tests were not re-run. */
  test: TestResult | null;
}

function fingerprintChanged(a: WorktreeEntry, b: WorktreeEntry): boolean {
  if (a.kind !== b.kind || a.code !== b.code) return true;
  if (a.kind === 'large') return a.size !== b.size || a.mtimeMs !== b.mtimeMs;
  if (a.kind === 'dir') return false; // untracked dir contents are not fingerprinted
  return a.sha !== b.sha || a.size !== b.size;
}

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 10) : 'none');

export function reconcile({ checkpoint, now, heads, missingReferences, test }: ReconcileInput): Finding[] {
  const rec = checkpoint.repo;
  const findings: Finding[] = [];
  const add = (severity: Finding['severity'], code: string, message: string) => findings.push({ severity, code, message });

  if (rec.rootCommit !== now.rootCommit) {
    add('critical', 'repo-identity', `Repository root commit differs (recorded ${rec.rootCommit}, now ${now.rootCommit}). This is a different repository.`);
  }
  if (rec.origin !== now.origin) add('warn', 'origin-changed', `origin URL recorded ${rec.origin ?? 'none'}, now ${now.origin ?? 'none'}.`);

  if (rec.branch !== now.branch) {
    add('critical', 'branch-changed', `Branch recorded ${rec.branch ?? '(detached)'}, now ${now.branch ?? '(detached)'}.`);
  }

  switch (heads.relation) {
    case 'advanced':
      add(
        'warn',
        'head-advanced',
        `HEAD moved ${shortSha(rec.head)} -> ${shortSha(now.head)} (+${heads.commitCount} commits${heads.shortStat ? `; ${heads.shortStat}` : ''}): ${heads.log.join(' | ')}`,
      );
      break;
    case 'rewritten':
      add('critical', 'head-rewritten', `HEAD ${shortSha(now.head)} does not contain checkpoint HEAD ${shortSha(rec.head)} (reset/rebase/branch switch).`);
      break;
    case 'unknown':
      add('critical', 'head-unknown', `Checkpoint HEAD ${shortSha(rec.head)} not found in this repository (now ${shortSha(now.head)}).`);
      break;
  }

  const recByPath = new Map(rec.entries.map((e) => [e.path, e]));
  const nowByPath = new Map(now.entries.map((e) => [e.path, e]));

  const emptied = new Set(emptiedFiles(now));
  for (const e of now.entries) {
    const before = recByPath.get(e.path);
    if (e.kind === 'file' && e.size === 0 && (before?.size ?? 0) > 0) emptied.add(e.path);
  }
  for (const p of [...emptied].sort()) add('critical', 'file-emptied', `${p} is 0 bytes but was non-empty in HEAD or at checkpoint.`);

  const expectedNow: string[] = [];
  for (const e of now.entries) {
    const before = recByPath.get(e.path);
    if (e.expected) {
      expectedNow.push(`${e.code.trim()} ${e.path}`);
      if (before && fingerprintChanged(before, e)) add('warn', 'expected-local-modified', `Protected local file ${e.path} changed since checkpoint.`);
      continue;
    }
    if (!before) add('warn', 'newly-dirty', `${e.code.trim()} ${e.path} became dirty after checkpoint.`);
    else if (fingerprintChanged(before, e)) {
      add('warn', 'modified-after-checkpoint', `${e.path} changed after checkpoint (${before.code.trim()} ${shortSha(before.sha)} -> ${e.code.trim()} ${shortSha(e.sha)}).`);
    }
  }
  for (const e of rec.entries) {
    if (nowByPath.has(e.path)) continue;
    const likelyCommitted = heads.relation === 'advanced';
    add(
      e.expected || likelyCommitted ? 'info' : 'warn',
      'no-longer-dirty',
      `${e.path} was dirty at checkpoint and is clean now${likelyCommitted ? ' (likely committed)' : ' (reverted or discarded?)'}.`,
    );
  }
  if (expectedNow.length) add('info', 'expected-local', `Intentional local state (do not commit/revert): ${expectedNow.join(', ')}`);
  if (rec.entriesTruncated || now.entriesTruncated) add('warn', 'entries-truncated', 'Worktree listing was truncated; dirty-file comparison is incomplete.');

  for (const p of missingReferences) add('warn', 'referenced-missing', `${p} was referenced in the checkpoint notes but no longer exists.`);

  findings.push(...compareTests(checkpoint.test, test));
  return findings;
}

export function verdict(findings: Finding[]): string {
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warn = findings.filter((f) => f.severity === 'warn').length;
  if (!critical && !warn) return 'CLEAN';
  return `DRIFT (${critical} critical, ${warn} warning)`;
}

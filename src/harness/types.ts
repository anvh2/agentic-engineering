/**
 * Persisted, model-agnostic state formats. Nothing here names a specific
 * engine: `engine` is a free-text label recorded for humans only.
 */

export interface ProjectConfig {
  schema: 'harness.project/1';
  /** Repository path, relative to the harness repository root. */
  repo: string;
  identity: { rootCommit: string };
  test: { command: string[]; timeoutMs: number };
  /** Paths (file, or directory ending in "/") that are intentionally dirty and must not be committed or reverted. */
  expectedLocal: string[];
}

export type EntryKind = 'file' | 'dir' | 'missing' | 'large' | 'symlink';

export interface WorktreeEntry {
  path: string;
  /** Two-character porcelain v1 XY code, e.g. " M", "??", "D ". */
  code: string;
  kind: EntryKind;
  /** git blob hash of the working-tree content; null for dirs, missing, or large files. */
  sha: string | null;
  size: number | null;
  /** mtime in ms; recorded only for large (unhashed) files. */
  mtimeMs: number | null;
  /** Byte size of this path in HEAD, null if absent from HEAD. */
  headSize: number | null;
  expected: boolean;
}

export interface RepoSnapshot {
  path: string;
  rootCommit: string;
  origin: string | null;
  head: string | null;
  headSubject: string | null;
  /** null when HEAD is detached. */
  branch: string | null;
  entries: WorktreeEntry[];
  entriesTruncated: boolean;
  diffStat: { files: number; insertions: number; deletions: number };
}

export interface TestResult {
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  startError: string | null;
  durationMs: number;
  runner: 'jest' | 'unknown';
  /** Jest "Test Suites:" / "Tests:" lines, if found. */
  summary: string[];
  /** Sorted failing suite paths (jest only); null when not parseable. */
  failingSuites: string[] | null;
  failedTests: number | null;
  tail: string;
}

export const NOTE_SECTIONS = [
  ['goal', 'Goal'],
  ['changed', 'Changed'],
  ['why', 'Why'],
  ['attempts', 'Attempts'],
  ['discoveries', 'Discoveries'],
  ['questions', 'Open questions'],
  ['blockers', 'Blockers'],
  ['next', 'Next'],
] as const;

export type NoteKey = (typeof NOTE_SECTIONS)[number][0];
export type EngineNotes = Record<NoteKey, string>;

export interface Checkpoint {
  schema: 'harness.checkpoint/1';
  id: string;
  project: string;
  createdAt: string;
  engine: string;
  repo: RepoSnapshot;
  test: TestResult | { skipped: true };
  /** Tracked files that were 0 bytes at capture but non-empty in HEAD. */
  emptiedAtCapture: string[];
  notes: EngineNotes;
  /** Repo-relative paths named in the notes that existed at capture time. */
  referencedPaths: string[];
}

export type Severity = 'critical' | 'warn' | 'info';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
}

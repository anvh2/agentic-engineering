import type { CodingTaskResult, FailureCategory } from '../../src/runtime/execution/coding-task-runner.ts';

/** One finished run, reduced to what aggregation needs. */
export interface RunSummary {
  level: string;
  verdict: 'PASS' | 'FAIL';
  failureCategory?: FailureCategory;
  /** Coding attempts consumed (runtime-failed invocations excluded). */
  attempts: number;
  /** Coding attempts whose verifier ran and failed. */
  verificationFailedAttempts: number;
  runtimeRetries: number;
  runtimeFailed: boolean;
  forbiddenMutation: boolean;
  durationMs: number;
  /** Category of every failed attempt (coding and runtime), including attempts later recovered by a retry. */
  attemptCategories: FailureCategory[];
}

export function summarizeRun(level: string, result: CodingTaskResult): RunSummary {
  return {
    level,
    verdict: result.verdict,
    failureCategory: result.failureCategory,
    attempts: result.attempts,
    verificationFailedAttempts: result.records.filter((r) => !r.runtimeError && r.verification && r.verification.exitCode !== 0).length,
    runtimeRetries: result.runtimeRetries,
    runtimeFailed: result.runtimeFailed,
    forbiddenMutation: result.forbiddenFilesChanged.length > 0,
    durationMs: result.durationMs,
    attemptCategories: result.records.flatMap((r) => (r.category ? [r.category] : [])),
  };
}

export interface Metrics {
  runs: number;
  passes: number;
  first_attempt_pass_rate: number;
  eventual_pass_rate: number;
  /** Failed-verification coding attempts / all coding attempts. */
  verification_failure_rate: number;
  /** Runs that ended in an exhausted runtime failure / all runs. */
  runtime_failure_rate: number;
  forbidden_mutation_rate: number;
  average_attempts_to_pass: number | null;
  average_latency_ms: number;
  runtime_retries_total: number;
  runs_with_runtime_retry: number;
  /** Final failure class of each failed run. */
  failure_classes: Partial<Record<FailureCategory, number>>;
  /** Class of every failed attempt, including ones a later coding retry recovered from. */
  attempt_failure_classes: Partial<Record<FailureCategory, number>>;
}

const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);
const count = (cats: FailureCategory[]) => {
  const out: Partial<Record<FailureCategory, number>> = {};
  for (const c of cats) out[c] = (out[c] ?? 0) + 1;
  return out;
};

export function aggregate(runs: RunSummary[]): Metrics {
  const passed = runs.filter((r) => r.verdict === 'PASS');
  const totalAttempts = runs.reduce((n, r) => n + r.attempts, 0);
  return {
    runs: runs.length,
    passes: passed.length,
    first_attempt_pass_rate: rate(passed.filter((r) => r.attempts === 1).length, runs.length),
    eventual_pass_rate: rate(passed.length, runs.length),
    verification_failure_rate: rate(runs.reduce((n, r) => n + r.verificationFailedAttempts, 0), totalAttempts),
    runtime_failure_rate: rate(runs.filter((r) => r.runtimeFailed).length, runs.length),
    forbidden_mutation_rate: rate(runs.filter((r) => r.forbiddenMutation).length, runs.length),
    average_attempts_to_pass: passed.length ? passed.reduce((n, r) => n + r.attempts, 0) / passed.length : null,
    average_latency_ms: runs.length ? runs.reduce((n, r) => n + r.durationMs, 0) / runs.length : 0,
    runtime_retries_total: runs.reduce((n, r) => n + r.runtimeRetries, 0),
    runs_with_runtime_retry: runs.filter((r) => r.runtimeRetries > 0).length,
    failure_classes: count(runs.flatMap((r) => (r.failureCategory ? [r.failureCategory] : []))),
    attempt_failure_classes: count(runs.flatMap((r) => r.attemptCategories)),
  };
}

export function aggregateByLevel(runs: RunSummary[]): Record<string, Metrics> {
  const levels = [...new Set(runs.map((r) => r.level))].sort();
  return Object.fromEntries(levels.map((l) => [l, aggregate(runs.filter((r) => r.level === l))]));
}

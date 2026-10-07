import { run } from './run.ts';
import type { Finding, TestResult } from './types.ts';

/**
 * Runs the project's test command and reduces the output to a comparable
 * fingerprint. For Jest the fingerprint is the set of failing suites, so a
 * baseline that is already red still detects regressions (red -> red with a
 * new failing suite). Other runners fall back to exit-code comparison.
 */

const TAIL_BYTES = 1_500;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function parseJest(output: string): Pick<TestResult, 'runner' | 'summary' | 'failingSuites' | 'failedTests'> {
  const lines = output.replace(ANSI, '').split(/\r?\n/);
  const summary = lines.map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => /^(Test Suites|Tests):/.test(l));
  if (summary.length === 0) return { runner: 'unknown', summary: [], failingSuites: null, failedTests: null };
  const failing = new Set<string>();
  for (const line of lines) {
    const match = line.trim().match(/^FAIL\s+(\S+)/);
    if (match) failing.add(match[1]);
  }
  const testsLine = summary.find((l) => l.startsWith('Tests:'));
  const failedTests = testsLine ? Number(testsLine.match(/(\d+) failed/)?.[1] ?? 0) : null;
  return { runner: 'jest', summary, failingSuites: [...failing].sort(), failedTests };
}

function tail(text: string): string {
  const buffer = Buffer.from(text, 'utf8');
  return buffer.byteLength <= TAIL_BYTES ? text : buffer.subarray(buffer.byteLength - TAIL_BYTES).toString('utf8');
}

export async function runTests(command: string[], cwd: string, timeoutMs: number): Promise<TestResult> {
  const [bin, ...args] = command;
  const result = await run(bin, args, { cwd, timeoutMs });
  const combined = `${result.stdout}\n${result.stderr}`;
  return {
    command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    startError: result.startError,
    durationMs: result.durationMs,
    ...parseJest(combined),
    tail: tail(combined.replace(ANSI, '').trim()),
  };
}

export function isUnknown(t: TestResult): boolean {
  return t.timedOut || t.startError !== null || t.exitCode === null;
}

export function describeTest(t: TestResult | { skipped: true }): string {
  if ('skipped' in t) return 'not run';
  if (t.timedOut) return `TIMED OUT after ${t.durationMs}ms`;
  if (t.startError) return `could not start: ${t.startError}`;
  const base = `exit ${t.exitCode}`;
  if (t.runner !== 'jest') return base;
  return `${base}; ${t.summary.join('; ')}${t.failingSuites?.length ? `; failing suites: ${t.failingSuites.length}` : ''}`;
}

/** Compares a recorded test result with the current one. Repository evidence (current) wins. */
export function compareTests(recorded: TestResult | { skipped: true }, current: TestResult | null): Finding[] {
  if (!current) return [{ severity: 'info', code: 'tests-not-reverified', message: 'Tests NOT re-verified in this resume.' }];
  if (isUnknown(current)) {
    return [{ severity: 'warn', code: 'tests-unknown', message: `Current test result UNKNOWN (${describeTest(current)}).` }];
  }
  if ('skipped' in recorded || isUnknown(recorded)) {
    return [{ severity: 'info', code: 'tests-no-baseline', message: `No recorded test baseline; now: ${describeTest(current)}.` }];
  }

  const findings: Finding[] = [];
  if (recorded.failingSuites && current.failingSuites) {
    const before = new Set(recorded.failingSuites);
    const after = new Set(current.failingSuites);
    const added = current.failingSuites.filter((s) => !before.has(s));
    const fixed = recorded.failingSuites.filter((s) => !after.has(s));
    if (added.length) {
      findings.push({ severity: 'critical', code: 'test-regression', message: `New failing suites since checkpoint: ${added.join(', ')}` });
    }
    if (fixed.length) findings.push({ severity: 'info', code: 'tests-fixed', message: `Suites now passing: ${fixed.join(', ')}` });
    if (!added.length && recorded.exitCode === 0 && current.exitCode !== 0) {
      findings.push({ severity: 'critical', code: 'test-regression', message: `Tests passed at checkpoint; now exit ${current.exitCode}.` });
    } else if (!added.length && (current.failedTests ?? 0) > (recorded.failedTests ?? 0)) {
      findings.push({
        severity: 'warn',
        code: 'more-failing-tests',
        message: `Failing tests rose ${recorded.failedTests} -> ${current.failedTests} within the same failing suites.`,
      });
    }
    return findings;
  }

  // Unsupported runner: exit-code fallback.
  if (recorded.exitCode === 0 && current.exitCode !== 0) {
    findings.push({ severity: 'critical', code: 'test-regression', message: `Tests passed at checkpoint; now exit ${current.exitCode}.` });
  } else if (recorded.exitCode !== 0 && current.exitCode === 0) {
    findings.push({ severity: 'info', code: 'tests-fixed', message: `Tests failed at checkpoint (exit ${recorded.exitCode}); now pass.` });
  } else if (recorded.exitCode !== current.exitCode) {
    findings.push({ severity: 'warn', code: 'test-exit-changed', message: `Test exit code ${recorded.exitCode} -> ${current.exitCode}.` });
  }
  return findings;
}

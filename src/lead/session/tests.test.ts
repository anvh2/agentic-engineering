import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { jestOutput } from './__testing__/fixture.ts';
import { compareTests, parseJest } from './tests.ts';
import type { TestResult } from './types.ts';

function result(exitCode: number | null, out: string, extra: Partial<TestResult> = {}): TestResult {
  return { command: ['x'], exitCode, timedOut: false, startError: null, durationMs: 1, tail: '', ...parseJest(out), ...extra };
}

const codes = (findings: ReturnType<typeof compareTests>) => findings.map((f) => `${f.severity}:${f.code}`);

describe('parseJest', () => {
  it('extracts summary, failing suites and failed test count, ignoring ANSI colour', () => {
    const parsed = parseJest(`\u001b[1mFAIL\u001b[22m src/b.test.js\n${jestOutput(['src/a.test.js'], ['src/c.test.js'], 3)}`);
    assert.equal(parsed.runner, 'jest');
    assert.deepEqual(parsed.failingSuites, ['src/a.test.js', 'src/b.test.js']);
    assert.equal(parsed.failedTests, 3);
    assert.equal(parsed.summary.length, 2);
  });

  it('reports unknown runner for non-jest output', () => {
    assert.deepEqual(parseJest('ok 1 - all good\n'), { runner: 'unknown', summary: [], failingSuites: null, failedTests: null });
  });
});

describe('compareTests', () => {
  const red = result(1, jestOutput(['a.test.js'], ['b.test.js']));

  it('red -> red with the same failing suites is not drift', () => {
    assert.deepEqual(compareTests(red, result(1, jestOutput(['a.test.js'], ['b.test.js']))), []);
  });

  it('red -> red with a NEW failing suite is a critical regression', () => {
    assert.deepEqual(codes(compareTests(red, result(1, jestOutput(['a.test.js', 'b.test.js'], [])))), ['critical:test-regression']);
  });

  it('green -> red is critical; fewer failing suites is info', () => {
    const green = result(0, jestOutput([], ['a.test.js']));
    assert.deepEqual(codes(compareTests(green, result(1, jestOutput(['a.test.js'], [])))), ['critical:test-regression']);
    assert.deepEqual(codes(compareTests(red, result(0, jestOutput([], ['a.test.js', 'b.test.js'])))), ['info:tests-fixed']);
  });

  it('more failing tests inside the same failing suites is a warning', () => {
    assert.deepEqual(codes(compareTests(red, result(1, jestOutput(['a.test.js'], ['b.test.js'], 4)))), ['warn:more-failing-tests']);
  });

  it('timeouts are UNKNOWN, never pass or fail', () => {
    assert.deepEqual(codes(compareTests(red, result(null, '', { timedOut: true }))), ['warn:tests-unknown']);
  });

  it('not re-run and no-baseline cases are info', () => {
    assert.deepEqual(codes(compareTests(red, null)), ['info:tests-not-reverified']);
    assert.deepEqual(codes(compareTests({ skipped: true }, red)), ['info:tests-no-baseline']);
  });

  it('falls back to exit codes for unsupported runners', () => {
    assert.deepEqual(codes(compareTests(result(0, 'ok'), result(2, 'not ok'))), ['critical:test-regression']);
    assert.deepEqual(codes(compareTests(result(1, 'not ok'), result(2, 'not ok'))), ['warn:test-exit-changed']);
    assert.deepEqual(codes(compareTests(result(1, 'not ok'), result(0, 'ok'))), ['info:tests-fixed']);
  });
});

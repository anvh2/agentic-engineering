import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LEVELS, buildFixture, loadReference } from './go-ladder.ts';
import { runCodingTask } from '../mastra/workflows/coding-task-runner.ts';
import { aggregate, aggregateByLevel, type RunSummary } from './metrics.ts';
import { createCodingWorker, resolveEditMode } from '../mastra/agents/coding-worker.ts';

describe('go ladder fixtures', () => {
  for (const level of LEVELS) {
    it(`${level}: untouched stub FAILS verification; reference solution PASSES (fixture is valid and non-trivial)`, async () => {
      const fx = await buildFixture(level);
      try {
        // Stub: a worker that does nothing must not pass.
        const stub = await runCodingTask(fx.task, { repoRoot: fx.root, worker: { generate: async () => ({ text: 'done', steps: [{}], finishReason: 'stop' }) }, maxAttempts: 1, runtimeRetryDelayMs: 0 });
        assert.equal(stub.verdict, 'FAIL');
        assert.equal(stub.failureCategory, 'A_no_mutation');
        // Reference: applying the known-good solution must pass visible + hidden tests.
        const reference = await loadReference(level);
        const solved = await runCodingTask(fx.task, {
          repoRoot: fx.root,
          worker: {
            generate: async () => {
              for (const [path, content] of Object.entries(reference)) {
                await mkdir(dirname(join(fx.root, path)), { recursive: true });
                await writeFile(join(fx.root, path), content);
              }
              return { text: 'done', steps: [{}], finishReason: 'stop' };
            },
          },
          maxAttempts: 1,
          runtimeRetryDelayMs: 0,
        });
        assert.equal(solved.verdict, 'PASS', solved.verifier?.output ?? '');
      } finally {
        await fx.cleanup();
      }
    });
  }

  it('hidden tests exist for every level and are not part of the repository the worker gets', async () => {
    for (const level of LEVELS) {
      const fx = await buildFixture(level);
      try {
        const hidden = Object.keys(fx.task.hiddenFiles ?? {});
        assert.ok(hidden.length > 0, `${level} has hidden tests`);
        for (const h of hidden) {
          const dirEntries = await readdir(join(fx.root, dirname(h))).catch(() => [] as string[]);
          assert.ok(!dirEntries.includes(h.split('/').pop()!), `${level}: ${h} must not be in the worker's repo`);
        }
      } finally {
        await fx.cleanup();
      }
    }
  });

  it('fresh fixture isolation: two builds never share a root or state', async () => {
    const a = await buildFixture('L1');
    const b = await buildFixture('L1');
    try {
      assert.notEqual(a.root, b.root);
      const file = join(a.root, 'internal/calculator/calculator.go');
      await writeFile(file, 'package calculator\n\nfunc Add(a, b int) int { return a + b }\n');
      const other = await readFile(join(b.root, 'internal/calculator/calculator.go'), 'utf8');
      assert.match(other, /return 0/, 'mutating fixture A must not affect fixture B');
      const c = await buildFixture('L1');
      try {
        assert.match(await readFile(join(c.root, 'internal/calculator/calculator.go'), 'utf8'), /return 0/, 'a new build starts pristine even after A was mutated');
      } finally {
        await c.cleanup();
      }
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});

describe('benchmark metric aggregation', () => {
  const run = (over: Partial<RunSummary>): RunSummary => ({
    level: 'L1',
    verdict: 'PASS',
    attempts: 1,
    verificationFailedAttempts: 0,
    runtimeRetries: 0,
    runtimeFailed: false,
    forbiddenMutation: false,
    durationMs: 1000,
    attemptCategories: [],
    ...over,
  });

  it('computes rates, averages and class counts', () => {
    const m = aggregate([
      run({}),
      run({ attempts: 2, verificationFailedAttempts: 1, durationMs: 3000, attemptCategories: ['C_wrong_implementation'], runtimeRetries: 1 }),
      run({ verdict: 'FAIL', failureCategory: 'C_wrong_implementation', attempts: 3, verificationFailedAttempts: 3, durationMs: 5000, attemptCategories: ['C_wrong_implementation', 'C_wrong_implementation', 'C_wrong_implementation'] }),
      run({ verdict: 'FAIL', failureCategory: 'F_model_runtime', attempts: 0, runtimeFailed: true, runtimeRetries: 1, durationMs: 1000, attemptCategories: ['F_model_runtime'] }),
    ]);
    assert.equal(m.runs, 4);
    assert.equal(m.first_attempt_pass_rate, 0.25);
    assert.equal(m.eventual_pass_rate, 0.5);
    assert.equal(m.average_attempts_to_pass, 1.5);
    assert.equal(m.verification_failure_rate, 4 / 6);
    assert.equal(m.runtime_failure_rate, 0.25);
    assert.equal(m.runtime_retries_total, 2);
    assert.equal(m.runs_with_runtime_retry, 2);
    assert.equal(m.forbidden_mutation_rate, 0);
    assert.equal(m.average_latency_ms, 2500);
    assert.deepEqual(m.failure_classes, { C_wrong_implementation: 1, F_model_runtime: 1 });
    assert.deepEqual(m.attempt_failure_classes, { C_wrong_implementation: 4, F_model_runtime: 1 });
  });

  it('handles an empty run list and groups by level', () => {
    assert.equal(aggregate([]).eventual_pass_rate, 0);
    assert.equal(aggregate([]).average_attempts_to_pass, null);
    const by = aggregateByLevel([run({ level: 'L2' }), run({ level: 'L1' }), run({ level: 'L1', verdict: 'FAIL', failureCategory: 'A_no_mutation', attempts: 3 })]);
    assert.deepEqual(Object.keys(by), ['L1', 'L2']);
    assert.equal(by.L1.runs, 2);
    assert.equal(by.L2.eventual_pass_rate, 1);
  });
});

describe('Go worker edit mode', () => {
  const toolIds = async (mode?: 'writeFile' | 'applyPatch') =>
    Object.keys(await createCodingWorker('go', mode).listTools()).sort();

  it('writeFile is the default when CODING_WORKER_EDIT_MODE is unset or empty', () => {
    assert.equal(resolveEditMode({}), 'writeFile');
    assert.equal(resolveEditMode({ CODING_WORKER_EDIT_MODE: '' }), 'writeFile');
    assert.equal(resolveEditMode({ CODING_WORKER_EDIT_MODE: 'writeFile' }), 'writeFile');
  });

  it('applyPatch is available as an explicit legacy override; unknown values are rejected', () => {
    assert.equal(resolveEditMode({ CODING_WORKER_EDIT_MODE: 'applyPatch' }), 'applyPatch');
    assert.throws(() => resolveEditMode({ CODING_WORKER_EDIT_MODE: 'diff' }), /must be/);
  });

  it('the default Go worker has writeFile and not applyPatch; the override swaps them', async () => {
    const def = await toolIds();
    assert.ok(def.includes('writeFile') && !def.includes('applyPatch'));
    const legacy = await toolIds('applyPatch');
    assert.ok(legacy.includes('applyPatch') && !legacy.includes('writeFile'));
  });

  it('the JS worker follows the same edit mode: writeFile by default, applyPatch only by explicit override', async () => {
    const def = Object.keys(await createCodingWorker('js').listTools());
    assert.ok(def.includes('writeFile') && !def.includes('applyPatch'));
    const legacy = Object.keys(await createCodingWorker('js', 'applyPatch').listTools());
    assert.ok(legacy.includes('applyPatch') && !legacy.includes('writeFile'));
  });
});

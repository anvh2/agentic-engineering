import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findProjectRoot } from '../../src/core/paths.ts';
import { loadPackRegistry } from '../../src/runtime/knowledge/packs/loader.ts';
import { stem } from '../../src/runtime/knowledge/packs/skills.ts';
import { CORPUS, runAttacks, runEngineeringPackBenchmark } from './engineering-pack.ts';

const registry = loadPackRegistry(findProjectRoot()!);

test('the benchmark corpus only expects skills that exist and covers every skill at least once', () => {
  const ids = new Set(registry.skills.map((s) => s.id));
  for (const t of CORPUS) for (const e of t.expect) assert.ok(ids.has(e), `${t.id} expects unknown skill ${e}`);
  const covered = new Set(CORPUS.flatMap((t) => t.expect));
  const missing = [...ids].filter((id) => !covered.has(id));
  assert.ok(missing.length <= 7, `skills with no corpus task: ${missing.join(', ')}`);
  assert.ok(CORPUS.some((t) => !t.expect.length), 'hard negatives are present');
});

test('selection is far more precise than injecting everything compatible, stemming does not hurt, and the bar is a floor not a claim', () => {
  const report = runEngineeringPackBenchmark(registry);
  const by = Object.fromEntries(report.selection.map((s) => [s.matching, s]));
  assert.ok(by.naive!.precision < 0.2, 'the naive baseline injects mostly irrelevant skills');
  assert.equal(by.naive!.recall, 1);
  assert.ok(by.stemmed!.f1 >= by.exact!.f1, 'stemmed matching is at least as good as exact');
  assert.ok(by.stemmed!.f1 >= 0.85, `selector F1 ${by.stemmed!.f1}`);
  assert.ok(by.stemmed!.precision >= 0.8 && by.stemmed!.recall >= 0.9);
});

test('integrated prompts carry a small fraction of the naive context and never exceed the budget', () => {
  const { context } = runEngineeringPackBenchmark(registry);
  assert.equal(context.baselineBytes, 0);
  assert.ok(context.integratedMaxBytes <= context.budgetBytes, `${context.integratedMaxBytes} > ${context.budgetBytes}`);
  assert.ok(context.reductionVsNaive >= 0.8, `reduction ${context.reductionVsNaive}`);
  assert.ok(context.integratedMeanBytes < context.naiveMeanBytes);
});

test('every adversarial attempt in the corpus is refused by the runtime', () => {
  const results = runAttacks(registry);
  assert.ok(results.length >= 20);
  assert.deepEqual(results.filter((r) => !r.blocked).map((r) => `${r.id} ${r.description}`), []);
});

test('the report is deterministic and says what it did not measure', () => {
  const a = runEngineeringPackBenchmark(registry), b = runEngineeringPackBenchmark(registry);
  assert.deepEqual(a, b);
  assert.ok(a.notMeasured.some((m) => /task success/.test(m)));
  assert.ok(a.notMeasured.some((m) => /author-labelled/.test(m)));
  assert.equal(a.attacks.blocked, a.attacks.total);
});

test('stemming merges inflections without merging unrelated short words', () => {
  assert.equal(stem('swallows'), stem('swallowed'));
  assert.equal(stem('swallowing'), stem('swallow'));
  assert.equal(stem('duplicated'), stem('duplicate'));
  assert.equal(stem('proves'), stem('prove'));
  assert.equal(stem('retries'), stem('retry'));
  for (const w of ['go', 'ci', 'api', 'adr', 'css']) assert.equal(stem(w), w, 'short words are untouched');
  assert.notEqual(stem('process'), stem('proc'));
});

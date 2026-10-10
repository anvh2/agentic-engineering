import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { tempDir } from '../../src/runtime/scheduler/test-helpers.ts';
import { classify, EVIDENCE_SCHEMA, type Evidence } from './classify.ts';
import { MAX_CONCURRENCY, MAX_REPEAT, runScenarios } from './run.ts';
import { SCENARIOS } from './scenarios.ts';

const base = (over: Partial<Evidence>): Evidence => ({ schema: EVIDENCE_SCHEMA, scenario: 's', run: 1, ok: false, durationMs: 1, ...over });

describe('M10 reliability classifier: rules', () => {
  it('a confirmed-clean timeout that the test waited out is a test race; with a live process it is not', () => {
    const message = 'timed out waiting for: the (fake) Gemini CLI to be running under the Mastra server';
    assert.equal(classify(base({ failure: { message }, runtime: { cancelOutcome: 'stopped', processes: [{ pid: 1, groupGone: true }] } })).category, 'test_race');
    assert.equal(classify(base({ failure: { message }, runtime: { cancelOutcome: 'stopped', processes: [{ pid: 1, groupGone: false }] } })).category, 'product_defect', 'cancel says stopped while a group is alive');
  });

  it('runtime contract violations are product defects whatever the test asserted', () => {
    assert.equal(classify(base({ failure: { message: 'x' }, runtime: { claims: 2 } })).category, 'product_defect');
    assert.equal(classify(base({ failure: { message: 'x' }, runtime: { requeued: ['T'] } })).category, 'product_defect');
    assert.equal(classify(base({ failure: { message: 'x' }, runtime: { cancelOutcome: 'still_active', engaged: [{ kind: 'lease', holder: 'gemini:T:pid9', pid: 9, resource: 'gemini', alive: false }], taskResource: 'gemini' } })).category, 'product_defect', 'a dead holder blocking the confirmation');
    assert.equal(classify(base({ scenario: 'timeout-before-spawn', failure: { message: 'x' }, runtime: { cancelOutcome: 'stopped', faultsFired: ['provider.before-spawn'], processes: [{ pid: 3, groupGone: true }] } })).category, 'product_defect', 'late spawn');
  });

  it('an own-resource still_active without more evidence stays unknown (no guessing)', () => {
    const c = classify(base({ failure: { message: 'still_active run status canceled; model still engaged: lease pid 4' }, runtime: { cancelOutcome: 'still_active', engaged: [{ kind: 'lease', holder: 'gemini:T:pid4', pid: 4, resource: 'gemini', alive: true }], taskResource: 'gemini' } }));
    assert.equal(c.category, 'unknown');
    assert.match(c.reasons[0], /does not say which/);
  });

  it('environmental signatures win over everything else', () => {
    for (const m of ['spawn gemini ENOENT', 'ENOSPC: no space left on device', 'EMFILE: too many open files', 'macOS sandbox-exec is not usable here']) assert.equal(classify(base({ failure: { message: m }, runtime: { claims: 2 } })).category, 'environmental', m);
  });
});

describe('M10 reliability runner', () => {
  it('enforces its ceilings and refuses unknown scenarios', async () => {
    const outDir = tempDir('rl-');
    await assert.rejects(runScenarios({ scenarios: ['nope'], repeat: 1, concurrency: 1, outDir }), /unknown scenario/);
    await assert.rejects(runScenarios({ scenarios: ['lease-isolation'], repeat: 1, concurrency: MAX_CONCURRENCY + 1, outDir }), /concurrency must be/);
    await assert.rejects(runScenarios({ scenarios: ['lease-isolation'], repeat: MAX_REPEAT + 1, concurrency: 1, outDir }), /repeat must be/);
  });

  it('a node-test scenario reuses an existing test by name and records its outcome', async () => {
    const outDir = tempDir('rl-');
    const s = await runScenarios({ scenarios: ['interrupted-run'], repeat: 1, concurrency: 1, outDir });
    assert.deepEqual(s.byCategory, { pass: 1 });
    const e = JSON.parse(readFileSync(join(outDir, 'interrupted-run-001.json'), 'utf8'));
    assert.equal(e.kind, 'node-test');
    assert.equal(e.detail.file, 'src/runtime/scheduler/failure-injection.test.ts');
    assert.ok(e.detail.pass >= 1);
  });

  it('a scenario that throws is recorded and classified, never lost', async () => {
    const outDir = tempDir('rl-');
    const original = SCENARIOS['lease-isolation'].run;
    SCENARIOS['lease-isolation'].run = async () => {
      throw new Error('listen EADDRINUSE: address already in use');
    };
    try {
      const s = await runScenarios({ scenarios: ['lease-isolation'], repeat: 2, concurrency: 2, outDir });
      assert.deepEqual(s.byCategory, { environmental: 2 });
      assert.equal(readdirSync(outDir).filter((f) => f.startsWith('lease-isolation-')).length, 2);
    } finally {
      SCENARIOS['lease-isolation'].run = original;
    }
  });
});

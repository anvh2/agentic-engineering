import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { tempDir } from '../../src/runtime/scheduler/test-helpers.ts';
import { M85_LIMITS, M85_OPT_IN_ENV, TASK_A, TASK_B, checkM85Authorization, judge, runM85Objective } from '../provider-smoke/m85-objective.ts';
import { SharedInvocationBudget } from '../provider-smoke/smoke-server.ts';

/**
 * The M8.5 objective with a FAKE Codex CLI: the same scheduler, dedicated Mastra HTTP server, workflow, adapter, verified review,
 * integrateBatch and pinned oracle as the real run, with no network, account or model.
 */

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'provider-smoke', 'fake-codex-m85.mjs');
const ALLOW = [`codex:${TASK_A}`, `codex:${TASK_B}`];

function run(mode: string, extra: Partial<Parameters<typeof runM85Objective>[0]> = {}) {
  const outDir = tempDir('m85-');
  return runM85Objective({ outDir, allowProviders: ALLOW, codex: { command: FAKE, model: 'gpt-fake', termGraceMs: 200, env: { FAKE_M85: mode, FAKE_LOG: join(outDir, 'fake.log') } }, pollMs: 100, limits: { perInvocationTimeoutMs: 60_000, taskActiveTimeoutMs: 120_000, maxRounds: 6 }, log: () => {}, ...extra });
}

describe('M8.5 objective: gates (pure)', () => {
  it('is disabled by default, takes no arguments and narrows the allow-list to the two tasks', () => {
    assert.equal(checkM85Authorization({ AGENTIC_ALLOW_PROVIDERS: ALLOW.join(',') }).ok, false);
    const on = { [M85_OPT_IN_ENV]: 'codex-objective', AGENTIC_ALLOW_PROVIDERS: ALLOW.join(',') };
    assert.equal(checkM85Authorization({ ...on }, ['--x']).ok, false);
    assert.equal(checkM85Authorization({ [M85_OPT_IN_ENV]: 'codex-http', AGENTIC_ALLOW_PROVIDERS: 'codex' }).ok, false, 'the single-task smoke opt-in does not enable this');
    assert.equal(checkM85Authorization({ [M85_OPT_IN_ENV]: 'codex-objective', AGENTIC_ALLOW_PROVIDERS: `codex:${TASK_A}` }).ok, false, 'one task is not enough');
    assert.deepEqual(checkM85Authorization({ ...on, AGENTIC_ALLOW_PROVIDERS: 'codex' }), { ok: true, allowProviders: ALLOW });
  });
  it('the server-wide budget refuses a 2nd call for a task and a 3rd call overall, consuming nothing when refused', () => {
    const events: Record<string, unknown>[] = [];
    const b = new SharedInvocationBudget({ total: 2, perWorkdir: 1 }, (e) => events.push(e), tempDir('budget-'));
    assert.equal(b.take('/wt/a'), true);
    assert.equal(b.take('/wt/a'), false, 'same task again');
    assert.equal(b.take('/wt/b'), true);
    assert.equal(b.take('/wt/c'), false, 'a third task exceeds the total');
    assert.deepEqual(events.map((e) => e.allowed), [true, false, true, false]);
  });
  it('states the authorized bounds', () => {
    assert.deepEqual([M85_LIMITS.maxInvocationsTotal, M85_LIMITS.maxInvocationsPerTask, M85_LIMITS.maxClaimsPerTask, M85_LIMITS.perInvocationTimeoutMs, M85_LIMITS.taskActiveTimeoutMs], [2, 1, 1, 300_000, 420_000]);
  });
});

describe('M8.5 objective: full path with a fake Codex', () => {
  it('happy path: A integrated before B, oracle passes on the tip and fails on the base, ACCEPTED', { timeout: 300_000 }, async () => {
    const { report } = await run('good');
    assert.equal(report.lifecycle.phase, 'ACCEPTED', JSON.stringify(report.lifecycle));
    const [a, b] = [report.tasks.find((t: any) => t.id === TASK_A), report.tasks.find((t: any) => t.id === TASK_B)];
    assert.equal(a.state, 'DONE');
    assert.equal(b.state, 'DONE');
    assert.equal(a.claims, 1);
    assert.equal(b.claims, 1);
    assert.ok(a.integratedCommit && b.integratedCommit);
    // dependency order: B was claimed only after A was integrated
    const aDone = Date.parse(a.events.find((e: any) => e.to === 'DONE').at);
    const bClaim = Date.parse(b.events.find((e: any) => e.to === 'CLAIMED').at);
    assert.ok(bClaim >= aDone, 'B claimed after A was DONE');
    assert.equal(report.checks.codexInvocationsAllowed, 2);
    assert.equal(report.checks.codexInvocationsRefused, 0);
    assert.deepEqual(Object.values(report.checks.codexInvocationsPerTaskWorktree), [1, 1]);
    assert.ok(report.checks.negativeControlExitCodes.some((c: number) => c !== 0), 'negative control fails on the base');
    assert.ok(report.checks.candidateExitCodes.every((c: number) => c === 0));
    assert.equal(report.checks.mainUntouched, true);
    assert.equal(report.checks.serverStopped, true);
    assert.equal(report.checks.ownedProviderGroupsGone, true);
    assert.deepEqual(report.checks.modelPermitsHeld, []);
    assert.equal(judge(report).verdict, 'M8_5_REAL_OBJECTIVE_ACCEPTED', JSON.stringify(judge(report)));
    assert.match(readFileSync(join(report.paths.pinned), 'utf8'), /criteriaSha256/);
  });

  it('a solution that passes the task verifiers but not the oracle is NOT_ACCEPTED (FAILED), not accepted', { timeout: 300_000 }, async () => {
    const { report } = await run('ascii-only');
    assert.equal(report.lifecycle.phase, 'NOT_ACCEPTED', JSON.stringify(report.lifecycle));
    assert.equal(report.lifecycle.reason, 'oracle_failed');
    assert.equal(report.checks.codexInvocationsAllowed, 2);
    assert.equal(judge(report).verdict, 'M8_5_REAL_OBJECTIVE_FAILED');
  });

  it('a task whose verifier fails gets no second Codex call and no repair: the objective stops with evidence', { timeout: 300_000 }, async () => {
    const { report } = await run('wrong-normalize');
    assert.notEqual(report.lifecycle.phase, 'ACCEPTED');
    assert.ok(report.checks.codexInvocationsAllowed <= 1, `invocations allowed: ${report.checks.codexInvocationsAllowed}`);
    assert.equal(report.checks.codexInvocationsWithinPerTask, true);
    assert.equal(report.checks.noCorrectionTasks, true);
    const b = report.tasks.find((t: any) => t.id === TASK_B);
    assert.equal(b.claims, 0, 'the dependent never ran');
    assert.equal(judge(report).verdict, 'M8_5_REAL_OBJECTIVE_INCONCLUSIVE');
    assert.equal(report.checks.serverStopped, true);
  });
});

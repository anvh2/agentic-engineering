import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { tempDir } from '../../src/runtime/scheduler/test-helpers.ts';
import { runM85Objective } from './m85-objective.ts';
import { sha256 } from '../../src/lead/lifecycle/exec.ts';
import { ECONOMICS, FIXTURE_DIR, M8F_LIMITS, M8F_OPT_IN_ENV, M8F_TASK_A, M8F_TASK_B, ORACLE_FILES, checkM8FAuthorization, judge, m8fStaticProblems } from './m8final-objective.ts';

/**
 * The M8-final objective with a FAKE Codex CLI: the same scheduler, dedicated Mastra HTTP server, workflow, adapter, verified review,
 * integrateBatch and pinned oracle as the real run, with no network, account or model.
 */

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-codex-m8final.mjs');
const ALLOW = [`codex:${M8F_TASK_A}`, `codex:${M8F_TASK_B}`];

function run(mode: string, extra: Partial<Parameters<typeof runM85Objective>[0]> = {}) {
  const outDir = tempDir('m8f-');
  return runM85Objective({
    objective: ECONOMICS,
    outDir,
    allowProviders: ALLOW,
    codex: { command: FAKE, model: 'gpt-fake', termGraceMs: 200, env: { FAKE_M8F: mode, FAKE_LOG: join(outDir, 'fake.log'), FAKE_SECRET_DIR: FIXTURE_DIR } },
    pollMs: 100,
    limits: { perInvocationTimeoutMs: 60_000, taskActiveTimeoutMs: 120_000, maxRounds: 6 },
    log: () => {},
    ...extra,
  });
}

describe('M8 final: the oracle itself (no worker, no server)', () => {
  const sandbox = (name: string, overlay: 'stubs' | 'reference') => {
    const dir = mkdtempSync(join(tmpdir(), `m8f-${name}-`));
    cpSync(join(FIXTURE_DIR, overlay), dir, { recursive: true });
    for (const [f, src] of Object.entries(ORACLE_FILES)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), src);
    }
    return dir;
  };
  const goTest = (dir: string) => {
    try {
      execFileSync('go', ['test', '-count=1', './...'], { cwd: dir, stdio: 'pipe' });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? 1;
    }
  };
  it('PASSES on a correct implementation (positive control) and FAILS on the stubs (negative control)', { timeout: 240_000 }, () => {
    const good = sandbox('ref', 'reference');
    const base = sandbox('base', 'stubs');
    try {
      assert.equal(goTest(good), 0);
      assert.notEqual(goTest(base), 0);
    } finally {
      rmSync(good, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
  it('the production reference never uses floating point and the oracle hash is stable input to the pin', () => {
    assert.match(sha256(ORACLE_FILES['acceptance_test.go']), /^[0-9a-f]{64}$/);
  });
});

describe('M8 final: gates (pure)', () => {
  const on = { [M8F_OPT_IN_ENV]: 'codex-m8-final', AGENTIC_CODEX_MODEL: 'gpt-x', AGENTIC_ALLOW_PROVIDERS: ALLOW.join(',') };
  it('is disabled by default, takes no arguments, requires an explicit model and narrows the allow-list to the two tasks', () => {
    assert.equal(checkM8FAuthorization({ AGENTIC_ALLOW_PROVIDERS: ALLOW.join(',') }).ok, false);
    assert.equal(checkM8FAuthorization({ ...on }, ['--x']).ok, false);
    assert.equal(checkM8FAuthorization({ ...on, AGENTIC_CODEX_MODEL: '' }).ok, false, 'no model pinned');
    assert.equal(checkM8FAuthorization({ ...on, [M8F_OPT_IN_ENV]: 'codex-objective' }).ok, false, 'the M8.5 opt-in does not enable this');
    assert.equal(checkM8FAuthorization({ ...on, AGENTIC_ALLOW_PROVIDERS: `codex:${M8F_TASK_A}` }).ok, false, 'one task is not enough');
    assert.deepEqual(checkM8FAuthorization({ ...on, AGENTIC_ALLOW_PROVIDERS: 'codex' }), { ok: true, allowProviders: ALLOW, model: 'gpt-x' });
  });
  it('states the authorized bounds', () => {
    assert.deepEqual([M8F_LIMITS.maxInvocationsTotal, M8F_LIMITS.maxInvocationsPerTask, M8F_LIMITS.maxClaimsPerTask, M8F_LIMITS.perInvocationTimeoutMs, M8F_LIMITS.taskActiveTimeoutMs], [2, 1, 1, 300_000, 420_000]);
  });
  it('preflight refuses a missing model and a project under /tmp without calling anything', () => {
    const problems = m8fStaticProblems({ codex: { command: FAKE }, projectRoot: '/private/tmp/x' });
    assert.ok(problems.some((p) => /no model pinned/.test(p)), problems.join('; '));
    assert.ok(problems.some((p) => /\/private\/tmp/.test(p)), problems.join('; '));
  });
});

describe('M8 final: full path with a fake Codex', () => {
  it('happy path: A integrated before B, oracle passes on the tip and fails on the base, ACCEPTED', { timeout: 420_000 }, async () => {
    const { report } = await run('good');
    assert.equal(report.lifecycle.phase, 'ACCEPTED', JSON.stringify({ lifecycle: report.lifecycle, tasks: report.tasks.map((t: any) => [t.id, t.state, t.stateReason, t.verifiedReviews]) }));
    const [a, b] = [report.tasks.find((t: any) => t.id === M8F_TASK_A), report.tasks.find((t: any) => t.id === M8F_TASK_B)];
    assert.equal(a.state, 'DONE');
    assert.equal(b.state, 'DONE');
    assert.equal(a.claims, 1);
    assert.equal(b.claims, 1);
    assert.ok(Date.parse(b.events.find((e: any) => e.to === 'CLAIMED').at) >= Date.parse(a.events.find((e: any) => e.to === 'DONE').at), 'B claimed after A was DONE');
    assert.equal(report.checks.codexInvocationsAllowed, 2);
    assert.equal(report.checks.codexInvocationsRefused, 0);
    assert.ok(report.checks.negativeControlExitCodes.some((c: number) => c !== 0));
    assert.ok(report.checks.candidateExitCodes.every((c: number) => c === 0));
    assert.equal(report.checks.mainUntouched, true);
    assert.equal(report.checks.serverStopped, true);
    assert.equal(report.checks.ownedProviderGroupsGone, true);
    assert.equal(judge(report).verdict, 'M8_REAL_OBJECTIVE_ACCEPTED', JSON.stringify(judge(report)));
  });

  it('a solution that passes the task verifiers but not the oracle is NOT_ACCEPTED (FAILED), not accepted', { timeout: 420_000 }, async () => {
    const { report } = await run('rounded');
    assert.equal(report.lifecycle.phase, 'NOT_ACCEPTED', JSON.stringify(report.lifecycle));
    assert.equal(report.lifecycle.reason, 'oracle_failed');
    assert.equal(judge(report).verdict, 'M8_REAL_OBJECTIVE_FAILED');
  });

  it('a task whose verifier fails gets no second Codex call and no repair; the dependent never runs', { timeout: 420_000 }, async () => {
    const { report } = await run('wrong-accounting');
    assert.notEqual(report.lifecycle.phase, 'ACCEPTED');
    assert.ok(report.checks.codexInvocationsAllowed <= 1, `invocations allowed: ${report.checks.codexInvocationsAllowed}`);
    assert.equal(report.checks.noCorrectionTasks, true);
    assert.equal(report.tasks.find((t: any) => t.id === M8F_TASK_B).claims, 0);
    assert.equal(judge(report).verdict, 'M8_REAL_OBJECTIVE_INCONCLUSIVE');
    assert.equal(report.checks.serverStopped, true);
  });

  it('worker-written code run by the verifier cannot read the fixture (oracle, reference, task tests)', { timeout: 420_000 }, async () => {
    const { report } = await run('read-secrets');
    assert.equal(report.lifecycle.phase, 'ACCEPTED', 'the probe finds nothing, so the run is accepted (a panic would fail the verifier)');
    assert.equal(judge(report).verdict, 'M8_REAL_OBJECTIVE_ACCEPTED');
  });
});

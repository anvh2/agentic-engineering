import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { resumeObjective, runObjectiveLifecycle } from '../../src/lead/lifecycle/driver.ts';
import { sandboxRunner } from '../../src/lead/lifecycle/exec.ts';
import { LifecycleStore } from '../../src/lead/lifecycle/store.ts';
import { Scheduler, type Executor } from '../../src/runtime/scheduler/scheduler.ts';
import { SchedulerStore } from '../../src/runtime/scheduler/store.ts';
import { tempDir } from '../../src/runtime/scheduler/test-helpers.ts';
import { WorktreeManager } from '../../src/runtime/worktree/worktree.ts';
import { OBJECTIVE_ID, TASK_A, TASK_B, judge, runM85Objective, sandboxPath, summarizeTelemetry } from './m85-objective.ts';
import { readIsolationCanary } from './read-isolation-canary.ts';
import { SharedInvocationBudget } from './smoke-server.ts';
import { serverEnvironment } from './http-backend.ts';

/**
 * M8.6: repeatability and failure recovery of the M8.5 objective, with a FAKE Codex CLI (no network, account or model). Every scenario
 * runs the same path as the real run: scheduler -> dedicated Mastra HTTP server -> workflow -> Codex adapter -> worktree -> verifier ->
 * verified review -> integrateBatch -> pinned oracle. The one exception is read isolation, whose canary drives the REAL codex binary
 * against a local stub model (still no cloud call).
 */

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-codex-m85.mjs');
const ALLOW = [`codex:${TASK_A}`, `codex:${TASK_B}`];

type Report = Record<string, any>;
interface RunExtra {
  limits?: Parameters<typeof runM85Objective>[0]['limits'];
  isolation?: Parameters<typeof runM85Objective>[0]['isolation'];
  chaos?: Parameters<typeof runM85Objective>[0]['chaos'];
  env?: (outDir: string) => Record<string, string>;
}

async function run(mode: string, extra: RunExtra = {}): Promise<{ outDir: string; report: Report }> {
  const outDir = tempDir('m86-');
  const { report } = await runM85Objective({
    outDir,
    allowProviders: ALLOW,
    codex: { command: FAKE, model: 'gpt-fake', termGraceMs: 200, env: { FAKE_M85: mode, FAKE_PIDFILE: join(outDir, 'fake.pids'), ...extra.env?.(outDir) } },
    pollMs: 100,
    limits: { perInvocationTimeoutMs: 60_000, taskActiveTimeoutMs: 120_000, maxRounds: 6, cancelConfirmationMs: 15_000, ...extra.limits },
    ...(extra.isolation !== undefined ? { isolation: extra.isolation } : {}),
    ...(extra.chaos ? { chaos: extra.chaos } : {}),
    log: () => {},
  });
  return { outDir, report };
}

const task = (report: Report, id: string) => report.tasks.find((t: any) => t.id === id);

/** Invariants that must hold after ANY scenario, success or failure. */
function assertBoundedAndClean(report: Report, label: string) {
  const c = report.checks;
  assert.ok(c.codexInvocationsAllowed <= 2, `${label}: total invocations ${c.codexInvocationsAllowed}`);
  assert.equal(c.codexInvocationsWithinPerTask, true, `${label}: per-task invocations ${JSON.stringify(c.codexInvocationsPerTaskWorktree)}`);
  assert.equal(c.claimsWithinBound, true, `${label}: claims`);
  assert.equal(c.noCorrectionTasks, true, `${label}: a repair task was created`);
  assert.equal(c.noRuntimeRetries, true, `${label}: runtime retry`);
  assert.equal(c.mainUntouched, true, `${label}: main`);
  assert.equal(c.existingRefsUnchanged, true, `${label}: refs`);
  assert.deepEqual(c.unexpectedNewRefs, [], `${label}: new refs`);
  assert.equal(c.fsckOk, true, `${label}: fsck`);
  assert.equal(c.oracleHashUnchangedOnDisk, true, `${label}: oracle`);
  assert.equal(c.ownedProviderGroupsGone, true, `${label}: a Codex process group is still alive`);
  assert.equal(c.serverStopped, true, `${label}: the Mastra server is still running`);
  assert.deepEqual(c.modelPermitsHeld, [], `${label}: permit rows`);
  assert.equal(c.modelPermitFree, true, `${label}: the Codex permit cannot be taken`);
  // every provider spawn in the ledger belongs to an allowed invocation
  const spawns = report.ledger.filter((e: any) => e.event === 'spawn').length;
  assert.ok(spawns <= c.codexInvocationsAllowed, `${label}: ${spawns} process(es) spawned for ${c.codexInvocationsAllowed} allowed invocation(s)`);
}

/** Re-opens a finished run's durable state with an executor that fails the test if anything is ever dispatched to it. */
function reopen(outDir: string) {
  const store = new SchedulerStore(join(outDir, 'scheduler.db'));
  const worktrees = new WorktreeManager(join(outDir, 'worktrees'));
  const lifecycle = new LifecycleStore(store);
  const dispatched: string[] = [];
  const executor: Executor = {
    run: async (input) => {
      dispatched.push(input.task.id);
      throw new Error(`tripwire: ${input.task.id} must not be dispatched`);
    },
  };
  const config = { maxConcurrentWorkers: 1, pollMs: 50, workerLeaseTimeoutMs: 60_000, taskTimeoutMs: 60_000, maxCapacityWaitMs: 1_000, maxTasksPerBatch: 5, maxReviewCorrections: 2 };
  const scheduler = new Scheduler({ store, executor, workspace: worktrees, config, allowProviders: ALLOW });
  const deps = { store, worktrees, lifecycle, scheduler, executor, run: sandboxRunner(300_000), config, maxRounds: 4 };
  return { store, lifecycle, deps, dispatched };
}

const claimsOf = (store: SchedulerStore) => Object.fromEntries(store.listTasks({ batchId: OBJECTIVE_ID }).map((t) => [t.id, t.claims]));

// ---------------------------------------------------------------------------------------------------------------------------------

describe('M8.6 repeatability and idempotency', () => {
  it('three runs on three fresh disposable repositories give the same result, the same trees and independent evidence', { timeout: 600_000 }, async () => {
    const runs: { outDir: string; report: Report }[] = [];
    for (let i = 0; i < 3; i += 1) runs.push(await run('good'));
    const signature = (r: Report) => ({
      phase: r.lifecycle.phase,
      reason: r.lifecycle.reason,
      states: r.tasks.map((t: any) => `${t.id}:${t.state}:claims${t.claims}:attempts${t.codingAttempts}`),
      invocations: [r.checks.codexInvocationsAllowed, r.checks.codexInvocationsRefused],
      oracleSpec: r.acceptance.oracle.specHash,
      criteria: r.pinned.criteriaSha256,
      // the content the objective produced and the content it was judged on: commit ids differ (timestamps), trees must not
      candidateTree: r.acceptance.candidate.treeId,
      baseTree: r.acceptance.negativeControl.treeId,
      candidateExit: r.checks.candidateExitCodes,
      baseExit: r.checks.negativeControlExitCodes,
      verdict: judge(r).verdict,
    });
    const first = signature(runs[0].report);
    assert.equal(first.phase, 'ACCEPTED');
    assert.equal(first.verdict, 'M8_5_REAL_OBJECTIVE_ACCEPTED');
    for (const r of runs.slice(1)) assert.deepEqual(signature(r.report), first);
    for (const r of runs) assertBoundedAndClean(r.report, r.outDir);
    // independence: nothing is shared between runs
    const uniq = (f: (r: Report) => unknown) => new Set(runs.map((r) => f(r.report))).size;
    assert.equal(uniq((r) => r.paths.repo), 3, 'distinct repositories');
    assert.equal(uniq((r) => r.backend.serverPid), 3, 'distinct servers');
    assert.equal(uniq((r) => r.backend.serverUrl), 3, 'distinct server addresses');
    assert.equal(uniq((r) => r.tasks.flatMap((t: any) => t.runIds).join()), 3, 'distinct Mastra run ids');
    assert.equal(uniq((r) => r.dag.integrationTip), 3, 'distinct integration commits (each repository has its own history)');
    for (const r of runs) assert.equal(r.report.checks.codexInvocationsAllowed, 2);
  });

  it('driving a finished objective again claims nothing, dispatches nothing and returns the same verdict; two drivers cannot run at once', { timeout: 300_000 }, async () => {
    const { outDir, report } = await run('good');
    assert.equal(report.lifecycle.phase, 'ACCEPTED');
    const ctx = reopen(outDir);
    const claimsBefore = claimsOf(ctx.store);
    const eventsBefore = ctx.store.events().length;
    const [a, b] = await Promise.all([runObjectiveLifecycle(ctx.deps, OBJECTIVE_ID), runObjectiveLifecycle(ctx.deps, OBJECTIVE_ID)]);
    assert.deepEqual([a.verdict, a.reason].join(), 'ACCEPTED,accepted');
    assert.equal(b.reason, 'driver_locked', 'the second concurrent driver is refused while the first holds the objective');
    const again = await runObjectiveLifecycle(ctx.deps, OBJECTIVE_ID);
    assert.equal(again.verdict, 'ACCEPTED');
    assert.deepEqual(ctx.dispatched, []);
    assert.deepEqual(claimsOf(ctx.store), claimsBefore);
    assert.equal(ctx.store.events().length, eventsBefore, 'no task event was written');
    assert.equal(report.checks.codexInvocationsAllowed, 2, 'and the ledger still says two');
    assert.equal(ctx.lifecycle.require(OBJECTIVE_ID).phase, 'ACCEPTED');
  });

  it('a durable budget survives a server restart: a new server cannot spend what the first one spent', () => {
    const dir = tempDir('budget-');
    const note = () => {};
    const first = new SharedInvocationBudget({ total: 2, perWorkdir: 1 }, note, dir);
    assert.equal(first.take('/wt/a'), true);
    const afterRestart = new SharedInvocationBudget({ total: 2, perWorkdir: 1 }, note, dir); // a new process: no memory of the first
    assert.equal(afterRestart.take('/wt/a'), false, 'the same task cannot get a second invocation by restarting the server');
    assert.equal(afterRestart.take('/wt/b'), true);
    assert.equal(new SharedInvocationBudget({ total: 2, perWorkdir: 1 }, note, dir).take('/wt/c'), false, 'the total is spent');
    assert.deepEqual(readdirSync(dir).sort().filter((f) => f.startsWith('total-')), ['total-1', 'total-2']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('M8.6 failure-injection matrix', () => {
  it('verifier failure: no second paid call, the dependent never runs, the oracle never runs, terminal state is explicit', { timeout: 300_000 }, async () => {
    const { report } = await run('wrong-normalize');
    const a = task(report, TASK_A);
    const b = task(report, TASK_B);
    assert.equal(report.lifecycle.phase, 'ESCALATED', JSON.stringify(report.lifecycle));
    assert.equal(a.state, 'RUNTIME_FAILURE');
    assert.match(a.stateReason, /invocation budget reached/, 'the runner asked for a 2nd coding attempt; the server refused it');
    assert.equal(report.checks.codexInvocationsAllowed, 1);
    assert.equal(report.checks.codexInvocationsRefused, 1);
    assert.equal(report.ledger.filter((e: any) => e.event === 'spawn').length, 1, 'the refused call started no process');
    assert.equal(b.state, 'BLOCKED', 'dependency failure');
    assert.equal(b.claims, 0);
    assert.match(b.stateReason, /dependency m85-normalize is RUNTIME_FAILURE/);
    assert.equal(report.acceptance, null, 'the oracle never ran on a half-built objective');
    assert.equal(judge(report).verdict, 'M8_5_REAL_OBJECTIVE_INCONCLUSIVE');
    assertBoundedAndClean(report, 'verifier failure');
  });

  it('reviewer rejection: a verified review that asks for repair stops at AWAITING_OPERATOR with no repair task; authorizing it still cannot buy a call', { timeout: 300_000 }, async () => {
    const { outDir, report } = await run('drop-comments');
    const a = task(report, TASK_A);
    assert.equal(report.lifecycle.phase, 'AWAITING_OPERATOR', JSON.stringify(report.lifecycle));
    assert.equal(report.lifecycle.reason, 'repair_needs_operator_authorization');
    assert.equal(a.state, 'REVIEW_PENDING', 'the rejected result stays reviewable; it was not approved and not retried');
    assert.deepEqual(a.verifiedReviews.map((v: any) => [v.verdict, v.reasons.join()]), [['REPAIR_REQUIRED', 'finding:comment_removed']]);
    assert.equal(a.verifiedReviews[0].checks.find((c: any) => c.name === 'independent_verification').ok, true, 'the code was fine; the review rejected the comment removal, not the tests');
    assert.equal(task(report, TASK_B).claims, 0);
    assert.equal(report.checks.codexInvocationsAllowed, 1);
    assertBoundedAndClean(report, 'reviewer rejection');

    // The operator authorizes the repair and resumes. The correction task is a NEW task id the provider allow-list does not name, so the
    // scheduler refuses to run it: nothing is dispatched, nothing is invoked, and the objective stops again with a stated cause.
    const ctx = reopen(outDir);
    ctx.lifecycle.authorize(OBJECTIVE_ID, { kind: 'repair', taskId: TASK_A, uses: 1, actor: 'test-operator', reason: 'M8.6 failure injection' });
    resumeObjective(ctx.lifecycle, OBJECTIVE_ID, { actor: 'test-operator', reason: 'authorized one repair' });
    const outcome = await runObjectiveLifecycle(ctx.deps, OBJECTIVE_ID, { actor: 'test-operator' });
    assert.deepEqual(ctx.dispatched, [], 'no task was dispatched to any executor');
    assert.notEqual(outcome.verdict, 'ACCEPTED');
    assert.equal(outcome.verdict, 'ESCALATED', JSON.stringify(outcome));
    const fix = ctx.store.listTasks({ batchId: OBJECTIVE_ID }).find((t) => t.id === `${TASK_A}-fix1`);
    assert.ok(fix, 'the correction task exists');
    // The scheduler claims, then checks the provider allow-list and refuses: a claim is spent, an execution never starts.
    assert.ok(fix.claims <= 1, `at most one claim, got ${fix.claims}`);
    assert.ok(!['CLAIMED', 'CODING', 'VERIFYING', 'REVIEW_PENDING', 'APPROVED', 'INTEGRATING', 'DONE'].includes(fix.state), `the correction is not running or finished: ${fix.state}`);
    assert.equal(fix.runIds.length, 0, 'no Mastra run was ever created for it');
    assert.match(String(fix.stateReason), /provider_not_authorized/);
    assert.equal(readFileSync(join(outDir, 'server', 'provider-ledger.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"invocation"')).length, 1, 'the ledger still holds exactly one invocation');
  });

  it('Codex timeout: the call is killed at its deadline (SIGKILL of the process group), not retried, and the task ends RUNTIME_FAILURE', { timeout: 300_000 }, async () => {
    const { outDir, report } = await run('hang', { limits: { perInvocationTimeoutMs: 3_000, taskActiveTimeoutMs: 60_000 } });
    const a = task(report, TASK_A);
    assert.equal(report.lifecycle.phase, 'ESCALATED', JSON.stringify(report.lifecycle));
    assert.equal(a.state, 'RUNTIME_FAILURE');
    assert.match(a.stateReason, /exceeded 3000ms|invocation budget reached|timed out/i, a.stateReason);
    assert.equal(report.checks.codexInvocationsAllowed, 1);
    assert.equal(a.claims, 1);
    assert.equal(a.runtimeRetries, 0);
    assert.equal(task(report, TASK_B).state, 'BLOCKED');
    const pids = readFileSync(join(outDir, 'fake.pids'), 'utf8').split('\n').filter(Boolean).map(Number);
    assert.equal(pids.length, 1);
    assert.throws(() => process.kill(pids[0], 0), 'the hung CLI process is dead');
    assert.ok(report.elapsedMs < 45_000, `the run ended at the call deadline, not the task timeout (${report.elapsedMs}ms)`);
    assertBoundedAndClean(report, 'timeout');
  });

  it('server crash (SIGKILL) while Codex runs, then a restart on the same port and storage: no second invocation, orphan killed, correct terminal state', { timeout: 300_000 }, async () => {
    const { outDir, report } = await run('hang', { limits: { perInvocationTimeoutMs: 20_000, taskActiveTimeoutMs: 25_000 }, chaos: { crashServerAfterSpawn: { restartAfterMs: 1_000 } } });
    const a = task(report, TASK_A);
    assert.ok(report.chaos?.crashedServerPid, 'the server was crashed');
    assert.ok(report.chaos?.restartedServerPid, 'and restarted');
    assert.notEqual(report.chaos.restartedServerPid, report.chaos.crashedServerPid);
    assert.equal(report.checks.crashedServerGone, true);
    assert.equal(report.checks.codexInvocationsAllowed, 1, 'the restarted server did not re-run the call');
    assert.equal(report.ledger.filter((e: any) => e.event === 'spawn').length, 1, 'no process was started by the restarted server');
    assert.ok(report.checks.orphanProviderGroupsKilled.length >= 1, 'the Codex process the crashed server left behind was found through the ledger and killed');
    assert.equal(a.state, 'RUNTIME_FAILURE');
    assert.equal(a.claims, 1, 'the claim was not repeated');
    assert.equal(a.runIds.length, 1, 'one Mastra run, never a second');
    assert.equal(task(report, TASK_B).state, 'BLOCKED');
    assert.equal(report.lifecycle.phase, 'ESCALATED');
    assert.ok(existsSync(join(outDir, 'server', 'invocation-budget', 'total-1')), 'the budget slot is on disk, so it outlives the process that took it');
    assertBoundedAndClean(report, 'server restart');
  });

  it('server crash with NO restart: the scheduler gives up at a bounded time with a terminal state; nothing is left running', { timeout: 300_000 }, async () => {
    const { report } = await run('hang', { limits: { perInvocationTimeoutMs: 20_000, taskActiveTimeoutMs: 20_000 }, chaos: { crashServerAfterSpawn: {} } });
    assert.equal(task(report, TASK_A).state, 'RUNTIME_FAILURE');
    assert.equal(report.checks.codexInvocationsAllowed, 1);
    assert.equal(report.checks.crashedServerGone, true);
    assert.equal(report.lifecycle.phase, 'ESCALATED');
    assertBoundedAndClean(report, 'server crash without restart');
  });

  it('budget exhaustion: the 2nd task is refused by the server, the 1st stays integrated and is reported as partial; no oracle verdict', { timeout: 300_000 }, async () => {
    const { report } = await run('good', { limits: { maxInvocationsTotal: 1 } });
    const a = task(report, TASK_A);
    const b = task(report, TASK_B);
    assert.equal(a.state, 'DONE');
    assert.ok(a.integratedCommit);
    assert.equal(b.state, 'RUNTIME_FAILURE');
    assert.match(b.stateReason, /invocation budget reached/);
    assert.equal(report.checks.codexInvocationsAllowed, 1);
    assert.equal(report.checks.codexInvocationsRefused, 1);
    assert.equal(report.ledger.filter((e: any) => e.event === 'spawn').length, 1);
    assert.equal(report.lifecycle.phase, 'ESCALATED');
    assert.ok(report.lifecycle.stops.some((s: string) => /m85-normalize are integrated/.test(s)), `partial integration is reported: ${report.lifecycle.stops}`);
    assert.equal(report.acceptance, null);
    assert.equal(judge(report).verdict, 'M8_5_REAL_OBJECTIVE_INCONCLUSIVE');
    assertBoundedAndClean(report, 'budget exhaustion');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('M8.6 oracle read isolation', () => {
  const codexInstalled = (() => {
    try {
      execFileSync('codex', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it('the REAL codex CLI (against a local stub model) reads a protected path without isolation and is denied with it, while the worktree stays writable', { skip: !codexInstalled && 'codex is not installed', timeout: 400_000 }, async () => {
    const control = await readIsolationCanary({ mode: 'control' });
    assert.equal(control.credentials['ssh-private-key'], 'LEAK', `control: ${control.output}`);
    const isolated = await readIsolationCanary({ mode: 'deny' });
    assert.equal(isolated.launcherHealthy, true);
    assert.equal(isolated.credentials['ssh-private-key'], 'blocked');
    assert.equal(isolated.compat['worktree-write'], true);
    assert.equal(isolated.compat['outside-write-blocked'], true);
    assert.equal(control.compat['git-dir-write-blocked'], true, 'control: workspace-write protects .git');
    assert.equal(isolated.compat['git-dir-write-blocked'], true, 'the isolation profile preserves that protection');
  });

  it('the harness denies the oracle, the runtime state and its own source to the worker and to the verifier sandbox', { timeout: 300_000 }, async () => {
    const { outDir, report } = await run('good');
    assert.equal(report.isolation.enabled, true);
    const deny: string[] = report.isolation.denyRead;
    assert.ok(deny.includes(`${sandboxPath(outDir)}.oracle`), 'the oracle directory');
    assert.ok(deny.some((d) => d.endsWith('/scheduler.db')), 'the scheduler database (it holds the hidden task tests)');
    assert.ok(deny.some((d) => d.endsWith('/tests/provider-smoke/m85-objective.ts')), 'the harness source, which embeds the fixture oracle');
    assert.ok(deny.some((d) => d.endsWith('/.git')), 'the enclosing checkout history');
    const config = JSON.parse(readFileSync(join(outDir, 'server', 'server-config.json'), 'utf8'));
    assert.deepEqual(config.codex.denyReadPaths, deny, 'the Codex adapter inside the server received the same list');
    assert.equal(report.paths.oracleDir, `${sandboxPath(outDir)}.oracle`);
    assert.ok(!report.paths.oracleDir.startsWith(`${outDir}/`), 'the oracle is not inside the run directory the worker works under');
    const env = serverEnvironment({ port: 1, configPath: 'c', allowProviders: ALLOW, sandboxDenyRead: deny });
    assert.equal(env.AGENTIC_SANDBOX_DENY_READ, deny.join(':'));
    assert.equal(report.acceptance.verdict, 'ACCEPTED', 'isolation did not stop the objective from being judged');
  });

  it('worker-written code that probes for the oracle while the verifier runs it: leaks WITHOUT isolation, finds nothing WITH it', { timeout: 600_000 }, async () => {
    const probe = (isolated: boolean) => (outDir: string) => ({ FAKE_ORACLE_FILE: join(isolated ? `${sandboxPath(outDir)}.oracle` : join(sandboxPath(outDir), 'oracle'), 'acceptance_test.go') });
    const control = await run('read-oracle', { isolation: false, env: probe(false) });
    const controlA = task(control.report, TASK_A);
    assert.equal(control.report.isolation.enabled, false);
    assert.notEqual(controlA.state, 'DONE', 'control: the verifier let worker-written code read the oracle (the probe panicked), so the task could not pass');
    assert.equal(controlA.state, 'RUNTIME_FAILURE');

    const isolated = await run('read-oracle', { env: probe(true) });
    assert.equal(isolated.report.lifecycle.phase, 'ACCEPTED', JSON.stringify(isolated.report.lifecycle));
    assert.equal(task(isolated.report, TASK_A).state, 'DONE', 'with isolation the same code finds nothing, so the verifier, the review and the acceptance all pass');
    assertBoundedAndClean(isolated.report, 'isolated probe');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('M8.6 telemetry reporting', () => {
  it('reports what was measured and UNKNOWN for what was not, never zero or a guess', () => {
    const none = summarizeTelemetry([{ id: 't', activeMs: null, telemetry: [{ provider: 'codex', model: 'UNKNOWN', inferenceMs: 10, usage: { inputTokens: 'UNKNOWN', outputTokens: 5, costUsd: 'UNKNOWN', quota: 'UNKNOWN' } }] }]);
    assert.deepEqual(none.perTask[0], { id: 't', provider: 'codex', model: 'UNKNOWN', inputTokens: 'UNKNOWN', outputTokens: 5, inferenceMs: 10, activeMs: 'UNKNOWN', costUsd: 'UNKNOWN' });
    assert.equal(none.totals.inputTokens, 'UNKNOWN');
    assert.equal(none.totals.costUsd, 'UNKNOWN');
    const some = summarizeTelemetry([
      { id: 'a', activeMs: 100, telemetry: [{ provider: 'codex', model: 'm', inferenceMs: 10, usage: { inputTokens: 7, outputTokens: 1, costUsd: 0.5 } }] },
      { id: 'b', activeMs: 50, telemetry: [{ provider: 'codex', model: 'm', inferenceMs: 20, usage: { inputTokens: 3, outputTokens: 2, costUsd: 'UNKNOWN' } }] },
    ]);
    assert.equal(some.totals.inputTokens, 10);
    assert.equal(some.totals.outputTokens, 3);
    assert.equal(some.totals.inferenceMs, 30);
    assert.equal(some.totals.costUsd, 'UNKNOWN', 'one task without a cost makes the total unknown, not partial');
    assert.deepEqual(some.totals.models, ['m']);
    assert.deepEqual(summarizeTelemetry([{ id: 'x', activeMs: 1, telemetry: [] }]).totals.inputTokens, 'UNKNOWN', 'no call, no number');
  });

  it('a run records tokens, latency and identity per task and a total', { timeout: 300_000 }, async () => {
    const { report } = await run('good');
    const t = report.telemetry;
    assert.deepEqual(t.perTask.map((x: any) => [x.id, x.model, x.inputTokens, x.outputTokens, x.costUsd]), [
      [TASK_A, 'gpt-fake', 100, 20, 'UNKNOWN'],
      [TASK_B, 'gpt-fake', 100, 20, 'UNKNOWN'],
    ]);
    assert.equal(typeof t.perTask[0].inferenceMs, 'number');
    assert.equal(typeof t.perTask[0].activeMs, 'number');
    assert.equal(t.totals.inputTokens, 200);
    assert.equal(t.totals.outputTokens, 40);
    assert.equal(t.totals.costUsd, 'UNKNOWN');
    assert.deepEqual(t.totals.models, ['gpt-fake']);
  });
});

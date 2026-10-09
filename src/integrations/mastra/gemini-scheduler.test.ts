import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// Isolate the machine-wide permit database for this file before anything opens it.
process.env.AGENTIC_MODEL_LOCK_DB = join(process.env.TMPDIR ?? '/tmp', `gemini-sched-cap-${process.pid}.db`);

import { cancelTask } from '../../lead/cancel.ts';
import { pendingReviews } from '../../lead/review.ts';
import { capacityFor } from '../../runtime/capacity/model-capacity.ts';
import { Scheduler } from '../../runtime/scheduler/scheduler.ts';
import type { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { git, makeRepo, makeStore, sleep, tempDir, plan } from '../../runtime/scheduler/test-helpers.ts';
import { WorktreeManager } from '../../runtime/worktree/worktree.ts';
import { codexEntry } from '../../workers/providers/codex.ts';
import { geminiEntry, type GeminiConfig } from '../../workers/providers/gemini.ts';
import { ProviderRegistry } from '../../workers/providers/registry.ts';
import { createInProcessExecutor } from './__testing__/in-process-executor.ts';
import { createCodingTaskWorkflow } from './workflows/coding-task-workflow.ts';

/**
 * Scheduler -> executor -> coding-task-workflow -> Gemini adapter (mock CLI) -> isolated worktree -> runtime verifier ->
 * REVIEW_PENDING. The Gemini CLI is the mock in src/workers/providers/__testing__; nothing here reaches a network or an
 * account. Everything else (scheduler, SQLite store and fencing, worktrees, workflow, runner, sandboxed `go test`) is real.
 */

const FAKES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workers', 'providers', '__testing__');
const FAKE = join(FAKES, 'fake-gemini.mjs');
const FAKE_CODEX = join(FAKES, 'fake-codex.mjs');
const STUB = 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n';
const RIGHT = 'package calc\n\nfunc Double(n int) int {\n\treturn n * 2\n}\n';
const WRONG = 'package calc\n\nfunc Double(n int) int {\n\treturn n + 1\n}\n';
const TEST_SRC = 'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif got := Double(3); got != 6 {\n\t\tt.Fatalf("Double(3) = %d, want 6", got)\n\t}\n}\n';

const waitFor = async (cond: () => boolean, what: string, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function taskSpec(provider: string | undefined) {
  return {
    id: 'T',
    title: 'Implement Double',
    priority: 50,
    executor: 'worker' as const,
    maxClaims: 1,
    request: {
      contract: {
        taskId: 'T',
        objective: 'Implement Double in calc/calc.go',
        allowedFiles: ['calc/calc.go'],
        contextFiles: ['calc/calc_test.go'],
        acceptanceCriteria: ['TestDouble passes'],
        verificationCommands: [['go', 'test', '-count=1', './...']],
        constraints: ['tests are immutable'],
      },
      assessment: { complexity: 'small' as const, risk: 'low' as const, ambiguity: 'none' as const, rationale: 'one function with an existing test' },
      ...(provider ? { provider } : {}),
    },
  };
}

function harness(options: { provider?: string; fake?: Record<string, string>; schedulerAllow?: string[]; workflowAllow?: string[]; store?: SchedulerStore; codexLog?: string } = {}) {
  const repo = makeRepo({ 'go.mod': 'module example.com/calc\n\ngo 1.22\n', 'calc/calc.go': STUB, 'calc/calc_test.go': TEST_SRC });
  const dir = tempDir('gemini-sched-');
  const log = join(dir, 'calls.jsonl');
  const config: GeminiConfig = { command: FAKE, env: { FAKE_LOG: log, FAKE_FILE: 'calc/calc.go', FAKE_CONTENT: JSON.stringify(RIGHT), ...options.fake }, termGraceMs: 200 };
  const providers = new ProviderRegistry().register(geminiEntry(config));
  // Codex is registered next to Gemini only when a test asks, to prove nothing ever falls over to it.
  if (options.codexLog) providers.register(codexEntry({ command: FAKE_CODEX, env: { FAKE_LOG: options.codexLog }, termGraceMs: 200 }));
  const workflow = createCodingTaskWorkflow({ providers, allowProviders: () => options.workflowAllow ?? ['gemini:T'], artifactRoot: join(dir, 'artifacts'), runOptions: { runtimeRetryDelayMs: 0 } });
  const executor = createInProcessExecutor(workflow);
  const store = options.store ?? makeStore();
  store.createBatch(plan(repo, [taskSpec(options.provider === undefined ? 'gemini' : options.provider || undefined)] as never));
  store.promote();
  const scheduler = new Scheduler({
    store,
    executor,
    workspace: new WorktreeManager(join(dir, 'worktrees')),
    capacity: capacityFor(),
    allowProviders: options.schedulerAllow ?? ['gemini:T'],
    cancelGraceMs: 2_000,
    config: { pollMs: 20, workerLeaseTimeoutMs: 1_000, taskTimeoutMs: 120_000, maxCapacityWaitMs: 120_000 },
  });
  const records = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const execCalls = () => records().filter((r) => r.args?.includes('--prompt')) as { args: string[]; cwd: string; envKeys: string[] }[];
  return { repo, dir, store, scheduler, executor, execCalls, records };
}

describe('scheduler -> gemini adapter -> verifier (mock CLI)', () => {
  it('success: the task runs in its isolated worktree, the RUNTIME verifies it, and it stops at REVIEW_PENDING', async () => {
    const h = harness();
    const headBefore = git(h.repo, 'rev-parse', 'HEAD');
    const summary = await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'REVIEW_PENDING', `${task.state}: ${task.stateReason}`);
    assert.deepEqual(summary.reviewPending, ['T']);
    assert.equal(task.claims, 1);
    assert.deepEqual(summary.requeued, []);

    const calls = h.execCalls();
    assert.equal(calls.length, 1, 'exactly one Gemini invocation');
    const args = calls[0].args;
    assert.equal(realpathSync(calls[0].cwd), realpathSync(task.worktreePath!), 'it ran in the task worktree (the CLI has no --cd: cwd is the sandbox root)');
    assert.notEqual(realpathSync(task.worktreePath!), realpathSync(h.repo));
    assert.deepEqual([args.includes('--sandbox'), args[args.indexOf('--approval-mode') + 1], args.includes('--admin-policy')], [true, 'auto_edit', true]);
    assert.ok(args.includes('--skip-trust') && !args.some((a) => /dangerously|bypass|yolo|include-directories|worktree/.test(a)));

    assert.deepEqual(pendingReviews(h.store).map((r) => r.task.id), ['T'], 'a reviewable result exists for the Lead');
    assert.ok(task.headCommit && task.headCommit !== headBefore, 'the verified change was committed on the task branch only');
    assert.equal(git(h.repo, 'rev-parse', 'HEAD'), headBefore, 'the source checkout was not touched');
    assert.equal(git(h.repo, 'status', '--porcelain'), '');
    assert.equal(readFileSync(join(h.repo, 'calc/calc.go'), 'utf8'), STUB);
    assert.match(git(h.repo, 'show', `${task.headCommit}:calc/calc.go`), /n \* 2/);

    const artifactDir = String(task.artifacts.artifactDir);
    const attempts = JSON.parse(readFileSync(join(artifactDir, 'attempts.json'), 'utf8')) as { telemetry: { provider: string; model: string; usage: Record<string, unknown> }; verification: { exitCode: number } }[];
    assert.deepEqual([attempts[0].telemetry.provider, attempts[0].telemetry.model, attempts[0].verification.exitCode], ['gemini', 'gemini-fake-pro', 0]);
    assert.equal(attempts[0].telemetry.usage.costUsd, 'UNKNOWN');
  });

  it('the operator allow-list is required in the scheduler: a plan that names gemini runs nothing', async () => {
    const h = harness({ schedulerAllow: [] });
    await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(task.failureCategory, 'provider_not_authorized');
    assert.match(task.stateReason ?? '', /not allowed/);
    assert.equal(h.executor.started.length, 0, 'the executor was never called');
    assert.equal(h.records().length, 0, 'the CLI was never started, not even probed');
    assert.equal(task.worktreePath, null, 'no worktree was prepared');
  });

  it('...and again in the workflow, in the process that would spawn the CLI (a scheduler allow-list alone is not enough)', async () => {
    const h = harness({ schedulerAllow: ['gemini'], workflowAllow: [] });
    await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(task.failureCategory, 'provider_not_authorized');
    assert.equal(h.records().length, 0);
  });

  it('an allow-list entry for one task authorizes only that task', async () => {
    const h = harness({ schedulerAllow: ['gemini:other'], workflowAllow: ['gemini:other'] });
    await h.scheduler.run();
    assert.equal(h.store.requireTask('T').failureCategory, 'provider_not_authorized');
  });

  it('a task that names no provider is unaffected: the allow-list is not consulted and the default path runs', async () => {
    const h = harness({ provider: '', schedulerAllow: [], workflowAllow: [] });
    // default provider = the local model; no Ollama here, so it fails as a RUNTIME failure of the LOCAL path, never of authorization
    const s = h.scheduler.run();
    await Promise.race([s, sleep(4_000)]);
    h.scheduler.stop();
    await s;
    assert.notEqual(h.store.requireTask('T').failureCategory, 'provider_not_authorized');
    assert.equal(h.records().length, 0, 'gemini was not used');
  });

  it('an unknown provider fails the task and does not fall back to another provider', async () => {
    const h = harness({ provider: 'nope', schedulerAllow: ['nope'], workflowAllow: ['nope'] });
    await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(task.failureCategory, 'provider_unavailable');
    assert.match(task.stateReason ?? '', /unknown_provider/);
    assert.equal(h.records().length, 0);
  });

  it('failure: a failing Gemini call is one billed invocation, no retry, no requeue, no fallback', async () => {
    const h = harness({ fake: { FAKE_MODE: 'fail' } });
    const summary = await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(h.execCalls().length, 1);
    assert.equal(task.claims, 1);
    assert.deepEqual(summary.requeued, []);
    assert.equal(readFileSync(join(task.worktreePath!, 'calc/calc.go'), 'utf8'), STUB, 'the worktree was left as it was');
  });

  it('failure: a change the runtime verifier rejects is never REVIEW_PENDING, is bounded to 2 coding attempts, and the worktree is restored', async () => {
    const h = harness({ fake: { FAKE_CONTENT: JSON.stringify(WRONG) } });
    await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'ESCALATED', `${task.state}: ${task.stateReason}`);
    assert.equal(task.failureCategory, 'coding_attempts_exhausted');
    assert.equal(h.execCalls().length, 2, 'two attempts, never three');
    assert.equal(readFileSync(join(task.worktreePath!, 'calc/calc.go'), 'utf8'), STUB);
  });

  it('failure: a write outside the allowed file is a forbidden mutation and is reverted', async () => {
    const h = harness({ fake: { FAKE_MODE: 'edit-and-forbid' } });
    await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'ESCALATED');
    assert.equal(task.failureCategory, 'forbidden_mutation');
    assert.equal(readFileSync(join(task.worktreePath!, 'README.md'), 'utf8'), '# repo\n');
  });

  it('cancellation (lead cancel): the CLI process group is killed, the task stays CANCELLED, nothing is integrated', async () => {
    const pidfile = join(tempDir('gemini-pid-'), 'pid');
    const h = harness({ fake: { FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile } });
    const running = h.scheduler.run();
    await waitFor(() => existsSync(pidfile), 'the CLI to be running');
    const pid = Number(readFileSync(pidfile, 'utf8'));
    assert.ok(alive(pid));
    const r = await cancelTask(h.store, { taskId: 'T', reason: 'operator stop', executor: h.executor, capacity: capacityFor(), graceMs: 5_000 });
    assert.equal(r.task.state, 'CANCELLED');
    assert.equal(r.clean, true, `run cancellation: ${r.run.outcome} ${r.run.detail}`);
    await running;
    await waitFor(() => !alive(pid), 'the CLI to be dead', 5_000);
    assert.equal(h.store.requireTask('T').state, 'CANCELLED', 'a late result cannot overwrite the cancel');
    assert.equal(capacityFor({ resource: 'gemini', defaultPermits: 1 }).engagedBy('T').length, 0, 'the gemini permit was released');
  });

  it('cancellation (scheduler stop): the CLI is killed, the run is confirmed stopped, no new work is claimed', async () => {
    const pidfile = join(tempDir('gemini-pid-'), 'pid');
    const h = harness({ fake: { FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile } });
    const running = h.scheduler.run();
    await waitFor(() => existsSync(pidfile), 'the CLI to be running');
    const pid = Number(readFileSync(pidfile, 'utf8'));
    h.scheduler.stop();
    const summary = await running;
    assert.deepEqual(summary.stillActive, []);
    await waitFor(() => !alive(pid), 'the CLI to be dead', 5_000);
    assert.equal(h.store.requireTask('T').state, 'RUNTIME_FAILURE');
    assert.equal(h.store.requireTask('T').claims, 1);
    assert.equal(h.execCalls().length, 1);
  });

  it('authorizing another provider does not authorize gemini: a codex-only allow-list refuses a gemini task', async () => {
    const h = harness({ schedulerAllow: ['codex:T'], workflowAllow: ['codex:T'] });
    await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.failureCategory, 'provider_not_authorized');
    assert.equal(h.records().length, 0);
  });

  it('no fallback to Codex: an unusable Gemini fails the task and the registered Codex is never started', async () => {
    const codexLog = join(tempDir('gemini-codexlog-'), 'calls.jsonl');
    const h = harness({ fake: { FAKE_HELP_OMIT: '--sandbox' }, codexLog, schedulerAllow: ['gemini:T', 'codex:T'], workflowAllow: ['gemini:T', 'codex:T'] });
    await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(task.failureCategory, 'provider_unavailable');
    assert.match(task.stateReason ?? '', /unsupported_version/);
    assert.equal(h.execCalls().length, 0, 'gemini never ran');
    assert.equal(existsSync(codexLog), false, 'codex was never started, not even probed');
  });

  it('a worktree carrying project Gemini configuration is refused before any billed call', async () => {
    const h = harness();
    // the project's own file, committed: it would be loaded by the CLI as workspace configuration
    git(h.repo, 'checkout', '-q', 'main');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(h.repo, '.gemini'));
    writeFileSync(join(h.repo, '.gemini', 'settings.json'), '{}\n');
    git(h.repo, 'add', '-A');
    git(h.repo, 'commit', '-q', '-m', 'add project gemini config');
    await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(h.execCalls().length, 0);
    assert.match(task.stateReason ?? '', /\.gemini/);
  });

  it('fencing: a lease that expires on a gemini task is NOT requeued (a second automatic paid call is never started)', async () => {
    let now = 1_000_000;
    const store = makeStore(() => now);
    const h = harness({ store });
    store.claim({ workerId: 'w', languages: ['go', 'js'], leaseMs: 1_000, maxActive: 1 });
    now += 3_600_000;
    assert.deepEqual(store.reapExpired(), { requeued: [], exhausted: ['T'] });
    const t = store.requireTask('T');
    assert.equal(t.state, 'RUNTIME_FAILURE');
    assert.equal(t.failureCategory, 'lease_expired');
    assert.match(t.stateReason ?? '', /not requeued automatically/);
    void h;
  });
});

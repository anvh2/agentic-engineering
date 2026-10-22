import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// Isolate the machine-wide permit database for this file before anything opens it.
process.env.AGENTIC_MODEL_LOCK_DB = join(process.env.TMPDIR ?? '/tmp', `codex-sched-cap-${process.pid}.db`);

import { cancelTask } from '../../lead/cancel.ts';
import { pendingReviews } from '../../lead/review.ts';
import { capacityFor } from '../../runtime/capacity/model-capacity.ts';
import { Scheduler } from '../../runtime/scheduler/scheduler.ts';
import type { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { git, makeRepo, makeStore, sleep, tempDir, plan } from '../../runtime/scheduler/test-helpers.ts';
import { WorktreeManager } from '../../runtime/worktree/worktree.ts';
import { codexEntry, type CodexConfig } from '../../workers/providers/codex.ts';
import { ProviderRegistry } from '../../workers/providers/registry.ts';
import { createInProcessExecutor } from './__testing__/in-process-executor.ts';
import { createCodingTaskWorkflow } from './workflows/coding-task-workflow.ts';
import { isAlive as alive, readPid } from '../../workers/providers/__testing__/pidfile.ts';

/**
 * Scheduler -> executor -> coding-task-workflow -> Codex adapter (mock CLI) -> isolated worktree -> runtime verifier ->
 * REVIEW_PENDING. The Codex CLI is the mock in src/workers/providers/__testing__; nothing here reaches a network or an
 * account. Everything else (scheduler, SQLite store and fencing, worktrees, workflow, runner, sandboxed `go test`) is real.
 */

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workers', 'providers', '__testing__', 'fake-codex.mjs');
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

function harness(options: { provider?: string; fake?: Record<string, string>; schedulerAllow?: string[]; workflowAllow?: string[]; store?: SchedulerStore } = {}) {
  const repo = makeRepo({ 'go.mod': 'module example.com/calc\n\ngo 1.22\n', 'calc/calc.go': STUB, 'calc/calc_test.go': TEST_SRC });
  const dir = tempDir('codex-sched-');
  const log = join(dir, 'calls.jsonl');
  const config: CodexConfig = { command: FAKE, model: 'gpt-fake', env: { FAKE_LOG: log, FAKE_FILE: 'calc/calc.go', FAKE_CONTENT: JSON.stringify(RIGHT), ...options.fake }, termGraceMs: 200 };
  const providers = new ProviderRegistry().register(codexEntry(config));
  const workflow = createCodingTaskWorkflow({ providers, allowProviders: () => options.workflowAllow ?? ['codex:T'], artifactRoot: join(dir, 'artifacts'), runOptions: { runtimeRetryDelayMs: 0 } });
  const executor = createInProcessExecutor(workflow);
  const store = options.store ?? makeStore();
  store.createBatch(plan(repo, [taskSpec(options.provider === undefined ? 'codex' : options.provider || undefined)] as never));
  store.promote();
  const scheduler = new Scheduler({
    store,
    executor,
    workspace: new WorktreeManager(join(dir, 'worktrees')),
    capacity: capacityFor(),
    allowProviders: options.schedulerAllow ?? ['codex:T'],
    cancelGraceMs: 2_000,
    // A 1s lease (three ~333ms heartbeats) expired mid-attempt on a loaded CI runner (CI run 39283415933). Lease expiry itself is
    // covered with a fake clock in the fencing test below; these cases test attempt bounding, not lease timing.
    config: { pollMs: 20, workerLeaseTimeoutMs: 10_000, taskTimeoutMs: 120_000, maxCapacityWaitMs: 120_000 },
  });
  const records = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const execCalls = () => records().filter((r) => r.args?.[0] === 'exec' && r.args.includes('--sandbox')) as { args: string[]; envKeys: string[] }[];
  return { repo, dir, store, scheduler, executor, execCalls, records };
}

describe('scheduler -> codex adapter -> verifier (mock CLI)', () => {
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
    assert.equal(calls.length, 1, 'exactly one Codex invocation');
    const args = calls[0].args;
    assert.equal(args[args.indexOf('--cd') + 1], task.worktreePath, 'it ran in the task worktree');
    assert.notEqual(task.worktreePath, h.repo);
    assert.deepEqual([args[args.indexOf('--sandbox') + 1], args.includes('--ignore-user-config')], ['workspace-write', true]);
    assert.ok(!args.some((a) => /dangerously|bypass|yolo|full-auto|add-dir/.test(a)));

    assert.deepEqual(pendingReviews(h.store).map((r) => r.task.id), ['T'], 'a reviewable result exists for the Lead');
    assert.ok(task.headCommit && task.headCommit !== headBefore, 'the verified change was committed on the task branch only');
    assert.equal(git(h.repo, 'rev-parse', 'HEAD'), headBefore, 'the source checkout was not touched');
    assert.equal(git(h.repo, 'status', '--porcelain'), '');
    assert.equal(readFileSync(join(h.repo, 'calc/calc.go'), 'utf8'), STUB);
    assert.match(git(h.repo, 'show', `${task.headCommit}:calc/calc.go`), /n \* 2/);

    const artifactDir = String(task.artifacts.artifactDir);
    const attempts = JSON.parse(readFileSync(join(artifactDir, 'attempts.json'), 'utf8')) as { telemetry: { provider: string; model: string; usage: Record<string, unknown> }; verification: { exitCode: number } }[];
    assert.deepEqual([attempts[0].telemetry.provider, attempts[0].telemetry.model, attempts[0].verification.exitCode], ['codex', 'gpt-fake', 0]);
    assert.equal(attempts[0].telemetry.usage.costUsd, 'UNKNOWN');
    // The same measurement reaches the scheduler record, attributed to the recorded run and lease owner.
    const persisted = task.artifacts.modelCalls as { runId: string; workerId: string; attempt: number; provider: string; model: string; inputTokens: number | null; outputTokens: number | null; usageSupport: string; startedAt: number | null; inferenceMs: number }[];
    assert.deepEqual(persisted.map((c) => [c.runId, c.attempt, c.provider, c.model, c.inputTokens, c.outputTokens, c.usageSupport]), [[task.runId, 1, 'codex', 'gpt-fake', 120, 34, 'tokens']]);
    assert.equal(persisted[0].workerId, h.store.events('T').find((e) => e.to === 'CLAIMED')?.actor);
    assert.ok(typeof persisted[0].startedAt === 'number' && persisted[0].inferenceMs >= 0);
    assert.ok(!('costUsd' in persisted[0]), 'cost is not persisted: never guessed');
  });

  it('telemetry: a provider that reports no usage persists null counts, not zeros', async () => {
    const h = harness({ fake: { FAKE_MODE: 'no-usage' } });
    await h.scheduler.run();
    const task = h.store.requireTask('T');
    // This mode also makes no edit, so verification fails and the runner makes its two coding attempts: one record each.
    const persisted = task.artifacts.modelCalls as { attempt: number; inputTokens: number | null; outputTokens: number | null }[];
    assert.deepEqual(persisted.map((c) => [c.attempt, c.inputTokens, c.outputTokens]), [[1, null, null], [2, null, null]]);
  });

  it('the operator allow-list is required in the scheduler: a plan that names codex runs nothing', async () => {
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
    const h = harness({ schedulerAllow: ['codex'], workflowAllow: [] });
    await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(task.failureCategory, 'provider_not_authorized');
    assert.equal(h.records().length, 0);
  });

  it('an allow-list entry for one task authorizes only that task', async () => {
    const h = harness({ schedulerAllow: ['codex:other'], workflowAllow: ['codex:other'] });
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
    assert.equal(h.records().length, 0, 'codex was not used');
  });

  it('an unknown provider fails the task and does not fall back to another provider', async () => {
    const h = harness({ provider: 'gemini', schedulerAllow: ['gemini'], workflowAllow: ['gemini'] });
    await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(task.failureCategory, 'provider_unavailable');
    assert.match(task.stateReason ?? '', /unknown_provider/);
    assert.equal(h.records().length, 0);
  });

  it('failure: a failing Codex call is one billed invocation, no retry, no requeue, no fallback', async () => {
    const h = harness({ fake: { FAKE_MODE: 'fail' } });
    const summary = await h.scheduler.run();
    const task = h.store.requireTask('T');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(h.execCalls().length, 1);
    assert.equal(task.artifacts.modelCalls, undefined, 'a call with no response has no usage to record');
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
    assert.deepEqual((task.artifacts.modelCalls as { runId: string; attempt: number }[]).map((c) => [c.runId, c.attempt]), [[task.runId, 1], [task.runId, 2]], 'one record per attempt, none double-counted');
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
    const pidfile = join(tempDir('codex-pid-'), 'pid');
    const h = harness({ fake: { FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile } });
    const running = h.scheduler.run();
    await waitFor(() => readPid(pidfile) !== undefined, 'the CLI to be running');
    const pid = readPid(pidfile)!;
    assert.ok(alive(pid));
    const r = await cancelTask(h.store, { taskId: 'T', reason: 'operator stop', executor: h.executor, capacity: capacityFor(), graceMs: 5_000 });
    assert.equal(r.task.state, 'CANCELLED');
    assert.equal(r.clean, true, `run cancellation: ${r.run.outcome} ${r.run.detail}`);
    await running;
    await waitFor(() => !alive(pid), 'the CLI to be dead', 5_000);
    assert.equal(h.store.requireTask('T').state, 'CANCELLED', 'a late result cannot overwrite the cancel');
    assert.equal(capacityFor({ resource: 'codex', defaultPermits: 1 }).engagedBy('T').length, 0, 'the codex permit was released');
  });

  it('cancellation (scheduler stop): the CLI is killed, the run is confirmed stopped, no new work is claimed', async () => {
    const pidfile = join(tempDir('codex-pid-'), 'pid');
    const h = harness({ fake: { FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile } });
    const running = h.scheduler.run();
    await waitFor(() => readPid(pidfile) !== undefined, 'the CLI to be running');
    const pid = readPid(pidfile)!;
    h.scheduler.stop();
    const summary = await running;
    assert.deepEqual(summary.stillActive, []);
    await waitFor(() => !alive(pid), 'the CLI to be dead', 5_000);
    assert.equal(h.store.requireTask('T').state, 'RUNTIME_FAILURE');
    assert.equal(h.store.requireTask('T').claims, 1);
    assert.equal(h.execCalls().length, 1);
  });

  it('fencing: a lease that expires on a codex task is NOT requeued (a second automatic paid call is never started)', async () => {
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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { integrateBatch } from './integrate.ts';
import { computeMetrics, reconcileState, renderBacklog } from './report.ts';
import { reviewDecision } from './review.ts';
import { Scheduler } from './scheduler.ts';
import { fakeExecutor, git, makeRepo, makeStore, plan, tempDir, workerTask } from './test-helpers.ts';
import { WorktreeManager } from './worktree.ts';

async function scenario() {
  const repo = makeRepo();
  const store = makeStore();
  store.createBatch(plan(repo, [workerTask('ok'), workerTask('bad'), workerTask('rej'), { id: 'kept', title: 'schema', executor: 'claude', keptReason: 'migration', ownedFiles: ['db.sql'] }]));
  store.promote();
  const worktrees = new WorktreeManager(join(tempDir('sched-wt-'), 'worktrees'));
  const executor = fakeExecutor({ behavior: (i) => (i.task.id === 'bad' ? { status: 'ESCALATED_TO_CLAUDE', reasons: ['x'], codingAttempts: 3, runtimeRetries: 0 } : undefined) });
  const scheduler = new Scheduler({ store, executor, workspace: worktrees, config: { pollMs: 20 } });
  await scheduler.run();
  reviewDecision(store, { maxReviewCorrections: 2 }, { taskId: 'ok', decision: 'APPROVED' });
  reviewDecision(store, { maxReviewCorrections: 2 }, { taskId: 'rej', decision: 'REJECTED_WITH_FEEDBACK', feedback: 'nope' });
  await integrateBatch(store, worktrees, { batchId: 'B1', run: async () => ({ exitCode: 0, output: '', timedOut: false }) });
  return { store, worktrees, repo };
}

describe('metrics, backlog view, reconciliation', () => {
  it('computes accepted-output metrics from persisted state (not just task counts)', async () => {
    const { store } = await scenario();
    const m = computeMetrics(store, 'B1');
    assert.equal(m.totalTasks, 5); // ok, bad, rej, kept, rej-fix1
    assert.equal(m.eligibleTasks, 3);
    assert.equal(m.claudeKeptTasks, 1);
    assert.equal(m.tasksDelegated, 3);
    assert.equal(m.reviewsDecided, 2);
    assert.equal(m.reviewAcceptanceRate, 0.5);
    assert.equal(m.doneByWorker, 1);
    assert.equal(m.acceptedLocalImplementationRate, 0.25, '1 of the 4 implementation tasks was accepted+integrated from a local worker');
    assert.equal(m.integrationAttempts, 1);
    assert.equal(m.integrationFailureRate, 0);
    assert.equal(m.failuresByCategory.coding_attempts_exhausted, 1);
    assert.equal(m.claudeReviewTokens, null, 'honestly unmeasured');
  });

  it('renders a Markdown backlog view', async () => {
    const { store } = await scenario();
    const md = renderBacklog(store, 'B1');
    assert.match(md, /\| ok \| DONE \|/);
    assert.match(md, /Generated from the scheduler database/);
  });

  it('reconciliation reports drift (missing worktree, orphan worktree, stale lease) and changes nothing', async () => {
    let now = 1_000;
    const repo = makeRepo();
    const store = makeStore(() => now);
    store.createBatch(plan(repo, [workerTask('a'), workerTask('b')]));
    store.promote();
    const worktrees = new WorktreeManager(join(tempDir('sched-wt-'), 'worktrees'));
    const scheduler = new Scheduler({ store, executor: fakeExecutor(), workspace: worktrees, config: { pollMs: 20 } });
    await scheduler.run({});
    assert.deepEqual(await reconcileState(store, worktrees, 'B1'), []);

    // 1. a REVIEW_PENDING task's worktree vanishes
    const a = store.requireTask('a');
    git(repo, 'worktree', 'remove', '--force', a.worktreePath!);
    // 2. a worktree appears under the root that no task owns
    const orphan = join(worktrees.root, 'B1', 'ghost');
    git(repo, 'worktree', 'add', '-q', '-b', 'ghost-branch', orphan);
    // 3. a task is left holding a lease that has expired
    store.createBatch(plan(repo, [workerTask('c')], { batchId: 'B2' }));
    store.promote();
    store.claim({ workerId: 'dead', languages: ['js'], leaseMs: 10, maxActive: 5 });
    now += 60_000;

    const before = JSON.stringify(store.listTasks().map((t) => [t.id, t.state, t.leaseOwner]));
    const kinds = (await reconcileState(store, worktrees)).map((i) => `${i.kind}:${i.taskId ?? ''}`).sort();
    assert.deepEqual(kinds, ['missing_worktree:a', 'orphan_worktree:', 'stale_lease:c']);
    assert.equal(JSON.stringify(store.listTasks().map((t) => [t.id, t.state, t.leaseOwner])), before, 'reconcile is read-only');
  });
});

describe('lead-sched CLI', () => {
  it('plan -> tasks -> status work end to end against a temp database (no server, no model)', () => {
    const repo = makeRepo();
    const dir = tempDir('sched-cli-');
    const planFile = join(dir, 'plan.json');
    writeFileSync(planFile, JSON.stringify(plan(repo, [workerTask('a'), workerTask('b', { dependsOn: ['a'] })])));
    const script = join(fileURLToPath(new URL('.', import.meta.url)), '../../../scripts/lead-sched.ts');
    const env = { ...process.env, HARNESS_SCHED_DB: join(dir, 'db', 's.db'), HARNESS_SCHED_ROOT: dir };
    const run = (...a: string[]) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...a], { env, encoding: 'utf8', cwd: dir });
    assert.match(run('plan', planFile), /READY: a/);
    assert.match(run('tasks'), /READY\s+p50 a/);
    assert.match(run('tasks'), /BACKLOG\s+p50 b\s+<- a/);
    assert.throws(() => run('plan', planFile), /already exists/);
    assert.match(run('status'), /pending reviews: none/);
    assert.match(run('cancel', 'a', '--reason', 'test'), /a -> CANCELLED/);
    assert.match(run('tasks'), /BLOCKED\s+p50 b/);
  });
});

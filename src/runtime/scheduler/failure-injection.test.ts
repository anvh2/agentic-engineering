import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { integrateBatch, type CommandRunner } from '../integration/integrate.ts';
import { createMastraExecutor } from '../../integrations/mastra/executor.ts';
import { reconcileState } from './report.ts';
import { reviewDecision } from '../../lead/review.ts';
import { Scheduler, type Executor } from './scheduler.ts';
import { SchedulerStore } from './store.ts';
import { fakeExecutor, git, makeRepo, makeStore, plan, sleep, tempDir, workerTask } from './test-helpers.ts';
import { WorktreeManager } from '../worktree/worktree.ts';

/**
 * Deterministic failure injection for crash / race / restart paths that the main suites do not reach. Every test uses a
 * temporary repository, a temporary SQLite file and (where Mastra is involved) an in-process fake of the Mastra HTTP API.
 */

const passRunner: CommandRunner = async () => ({ exitCode: 0, output: 'ok', timedOut: false });

function setup(tasks: ReturnType<typeof workerTask>[], options: { executor?: Executor; config?: object; store?: SchedulerStore } = {}) {
  const repo = makeRepo();
  const store = options.store ?? makeStore();
  store.createBatch(plan(repo, tasks));
  store.promote();
  const worktrees = new WorktreeManager(join(tempDir('sched-wt-'), 'worktrees'));
  const scheduler = new Scheduler({ store, executor: options.executor ?? fakeExecutor(), workspace: worktrees, config: { pollMs: 20, ...options.config } });
  return { repo, store, worktrees, scheduler };
}
const approve = (store: SchedulerStore, id: string) => reviewDecision(store, { maxReviewCorrections: 2 }, { taskId: id, decision: 'APPROVED', feedback: 'lgtm' });

describe('integration crash recovery', () => {
  it('integrator died DURING a conflicted merge (MERGE_HEAD present, tip == preSha): recovery cleans up instead of wedging the batch', async () => {
    const { store, worktrees, scheduler } = setup([workerTask('a')]);
    await scheduler.run();
    approve(store, 'a');
    const iw = await worktrees.integrationWorktree(store.getBatch('B1')!);
    // someone (e.g. a Claude-direct task) changed the same file on the integration branch
    mkdirSync(join(iw.path, 'src'), { recursive: true });
    writeFileSync(join(iw.path, 'src/a.js'), 'module.exports = "conflicting";\n');
    git(iw.path, 'add', '-A');
    git(iw.path, 'commit', '-q', '-m', 'conflicting change');
    const preSha = git(iw.path, 'rev-parse', 'HEAD');
    store.transition('a', 'INTEGRATING', { actor: 'dead', expectFrom: 'APPROVED', patch: { artifacts: { integration: { preSha } } } });
    assert.throws(() => git(iw.path, 'merge', '--no-ff', '-m', 'half merge', store.requireTask('a').headCommit!)); // conflict, then "crash"

    const first = await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.deepEqual(first.reports.map((r) => [r.taskId, r.outcome, r.category]), [['a', 'ESCALATED', 'integration_conflict']]);
    assert.equal(git(iw.path, 'rev-parse', 'HEAD'), preSha, 'branch at the recorded pre-merge SHA');
    assert.equal(git(iw.path, 'status', '--porcelain'), '', 'no merge in progress, no conflict markers left');
    // and the batch is not wedged: a later integration run works
    await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
  });

  it('integrator died after writing the oracle but before committing it: the untracked oracle does not wedge the batch', async () => {
    const { store, worktrees, scheduler } = setup([workerTask('a')]);
    await scheduler.run();
    approve(store, 'a');
    const iw = await worktrees.integrationWorktree(store.getBatch('B1')!);
    const preSha = git(iw.path, 'rev-parse', 'HEAD');
    store.transition('a', 'INTEGRATING', { actor: 'dead', expectFrom: 'APPROVED', patch: { artifacts: { integration: { preSha } } } });
    git(iw.path, 'merge', '--no-ff', '-m', 'half merge', store.requireTask('a').headCommit!);
    mkdirSync(join(iw.path, 'tests'), { recursive: true });
    writeFileSync(join(iw.path, 'tests/a.test.js'), 'test("x",()=>{})\n'); // oracle written, process killed before `git commit`

    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.deepEqual(reports.map((r) => r.outcome), ['DONE']);
    assert.equal(git(iw.path, 'status', '--porcelain'), '');
    assert.match(git(iw.path, 'log', '--oneline', '-3'), /tests: oracle for a/);
  });

  it('a failing oracle commit is not ignored: the task escalates and the branch is rolled back, leaving a clean tree', async () => {
    const { repo, store, worktrees, scheduler } = setup([workerTask('a'), workerTask('b')]);
    await scheduler.run();
    approve(store, 'a');
    // a commit-msg hook (shared by all worktrees) rejects exactly the oracle commit
    const hook = join(repo, '.git', 'hooks', 'commit-msg');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\ngrep -q "^tests: oracle for a" "$1" && exit 1\nexit 0\n');
    chmodSync(hook, 0o755);
    const iw = await worktrees.integrationWorktree(store.getBatch('B1')!);
    const preSha = git(iw.path, 'rev-parse', 'HEAD');

    const { reports } = await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.equal(reports[0].outcome, 'ESCALATED');
    assert.equal(git(iw.path, 'rev-parse', 'HEAD'), preSha);
    assert.equal(git(iw.path, 'status', '--porcelain'), '', 'no uncommitted oracle left behind to wedge the next task');
    approve(store, 'b');
    const next = await integrateBatch(store, worktrees, { batchId: 'B1', run: passRunner });
    assert.deepEqual(next.reports.map((r) => r.outcome), ['DONE'], 'the next task integrates normally');
  });
});

describe('lease races across processes', () => {
  it('the reaper never requeues a lease that its owner renewed after the reaper observed it as expired', () => {
    const path = join(tempDir('sched-db-'), 'sched.db');
    let workerNow = 1_000;
    const worker = new SchedulerStore(path, { now: () => workerNow });
    worker.createBatch(plan('/repo', [workerTask('a')]));
    worker.promote();
    const claim = worker.claim({ workerId: 'w1', languages: ['js'], leaseMs: 100, maxActive: 1 })!; // lease until 1100

    let interleave: (() => void) | undefined;
    class InterleavingStore extends SchedulerStore {
      override listTasks(filter?: Parameters<SchedulerStore['listTasks']>[0]) {
        const rows = super.listTasks(filter);
        const hook = interleave;
        interleave = undefined;
        hook?.();
        return rows;
      }
    }
    const reaper = new InterleavingStore(path, { now: () => 1_200 }); // sees the lease as expired
    interleave = () => {
      workerNow = 1_150; // the owner was briefly stalled, then heartbeats: lease now valid until 1250
      assert.equal(worker.heartbeat('a', claim.fence, 100), true);
    };

    const out = reaper.reapExpired();
    assert.deepEqual(out.requeued, [], 'a renewed lease is not reaped');
    const t = worker.requireTask('a');
    assert.equal(t.state, 'CLAIMED');
    assert.equal(t.leaseOwner, 'w1');
    assert.equal(worker.heartbeat('a', claim.fence, 100), true, 'the live owner keeps its lease');
  });
});

describe('SQLite contention', () => {
  function lockFor(path: string, ms: number): Promise<void> {
    const other = new DatabaseSync(path);
    other.exec('BEGIN IMMEDIATE');
    return sleep(ms).then(() => {
      other.exec('COMMIT');
      other.close();
    });
  }

  it('a write lock held past busy_timeout while a task runs does not crash the scheduler (heartbeat degrades, task completes)', async () => {
    const path = join(tempDir('sched-db-'), 'sched.db');
    const store = new SchedulerStore(path, { busyTimeoutMs: 20 });
    let release: (() => void) | undefined;
    const logs: string[] = [];
    const executor = fakeExecutor({ gate: () => new Promise<void>((r) => (release = r)) });
    const { scheduler } = setup([workerTask('a')], { store, executor, config: { workerLeaseTimeoutMs: 1_200 } });
    (scheduler as unknown as { log: (l: string) => void }).log = (l) => logs.push(l);
    const running = scheduler.run();
    while (!release) await sleep(5);
    await lockFor(path, 450); // > busy timeout; one heartbeat (every 400ms) lands inside it; well under the lease
    release();
    const summary = await running;
    assert.deepEqual(summary.reviewPending, ['a']);
    assert.ok(logs.some((l) => /heartbeat failed \(database is locked\)/.test(l)), 'the locked heartbeat was observed and survived');
    assert.equal(store.requireTask('a').claims, 1, 'no spurious lease loss / re-claim');
  });

  it('a write lock held while the scheduler polls for work delays claiming instead of aborting the run', async () => {
    const path = join(tempDir('sched-db-'), 'sched.db');
    const store = new SchedulerStore(path, { busyTimeoutMs: 20 });
    const { scheduler } = setup([workerTask('a')], { store });
    const locked = lockFor(path, 150);
    const summary = await scheduler.run();
    await locked;
    assert.deepEqual(summary.reviewPending, ['a']);
  });
});

/** Minimal in-process stand-in for the Mastra workflow HTTP API used by mastra-client. */
function fakeMastra(behavior: { onStart?: (runId: string, inputData: { repository: string; contract: { allowedFiles: string[] } }) => void }) {
  const runs = new Map<string, { status: string; result?: Record<string, unknown> }>();
  const log: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const reply = (code: number, payload: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const base = '/api/workflows/coding-task-workflow';
      const runId = url.searchParams.get('runId');
      if (req.method === 'POST' && url.pathname === `${base}/create-run`) return reply(200, { runId });
      if (req.method === 'POST' && url.pathname === `${base}/start`) {
        log.push(`start:${runId}`);
        runs.set(runId!, { status: 'running' });
        behavior.onStart?.(runId!, JSON.parse(body).inputData);
        return reply(200, { message: 'started' });
      }
      const m = url.pathname.match(new RegExp(`^${base}/runs/([^/]+)(/cancel)?$`));
      if (m && m[2] && req.method === 'POST') {
        log.push(`cancel:${m[1]}`);
        const run = runs.get(m[1]);
        if (run) run.status = 'canceled';
        return reply(run ? 200 : 404, { message: 'Workflow run cancelled' });
      }
      if (m && req.method === 'GET') {
        const run = runs.get(m[1]);
        return run ? reply(200, { runId: m[1], status: run.status, result: run.result }) : reply(404, { error: 'not found' });
      }
      reply(404, { error: 'no route' });
    });
  });
  return {
    runs,
    log,
    listen: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('Mastra server restart / runaway runs', () => {
  const servers: { close(): Promise<void> }[] = [];
  after(() => Promise.all(servers.map((s) => s.close())));

  it('a task timeout cancels the Mastra run it gave up on (no unsupervised model work left running)', async () => {
    const mastra = fakeMastra({}); // every run stays "running" forever
    servers.push(mastra);
    const server = await mastra.listen();
    const { store, scheduler } = setup([workerTask('a')], { executor: createMastraExecutor({ server, pollMs: 10 }), config: { taskTimeoutMs: 1_500 } });
    await scheduler.run();
    const t = store.requireTask('a');
    assert.equal(t.state, 'RUNTIME_FAILURE');
    assert.equal(t.failureCategory, 'task_timeout');
    assert.deepEqual(mastra.log, [`start:${t.runId}`, `cancel:${t.runId}`]);
  });

  it('a run orphaned by a Mastra restart (stuck "running" forever) does not trap the task: after one timeout it runs fresh', async () => {
    const mastra = fakeMastra({
      onStart: (runId, input) => {
        // a healthy run: writes the allowed file in the task worktree and succeeds
        for (const f of input.contract.allowedFiles) {
          mkdirSync(dirname(join(input.repository, f)), { recursive: true });
          writeFileSync(join(input.repository, f), 'module.exports = "fresh";\n');
        }
        mastra.runs.set(runId, { status: 'success', result: { status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0 } });
      },
    });
    servers.push(mastra);
    const server = await mastra.listen();
    mastra.runs.set('orphan', { status: 'running' }); // what a server restart leaves behind in Mastra storage
    let now = 1_000;
    const store = makeStore(() => now);
    const { scheduler, worktrees } = setup([workerTask('a')], { store, executor: createMastraExecutor({ server, pollMs: 10 }), config: { taskTimeoutMs: 1_500 } });
    // the scheduler that started "orphan" died with the server; its lease expires
    const claim = store.claim({ workerId: 'dead', languages: ['js'], leaseMs: 100, maxActive: 1 })!;
    const ws = await worktrees.prepare(claim.task, store.getBatch('B1')!);
    store.patchTask('a', { worktreePath: ws.path, branch: ws.branch, baseCommit: ws.baseCommit }, 'dead', claim.fence);
    store.transition('a', 'CODING', { actor: 'dead', fence: claim.fence });
    store.recordRun('a', claim.fence, 'orphan');
    now += 10_000;

    await scheduler.run(); // re-claim -> reconcile waits on the orphan -> task timeout
    assert.equal(store.requireTask('a').state, 'RUNTIME_FAILURE');
    store.transition('a', 'READY', { actor: 'human', reason: 'retry', expectFrom: 'RUNTIME_FAILURE' }); // `lead:sched retry a`
    await scheduler.run();

    const t = store.requireTask('a');
    assert.equal(t.state, 'REVIEW_PENDING', `expected a fresh run after the orphan was given up on, got ${t.state} (${t.stateReason})`);
    assert.ok(mastra.log.includes('cancel:orphan'), 'the orphaned run was cancelled so it is terminal in Mastra storage');
    assert.equal(mastra.log.filter((l) => l.startsWith('start:')).length, 1);
    // the dead scheduler's claim was refunded when its lease expired (a lost host is not the task's fault): fresh run + retry = 2
    assert.equal(t.claims, 2);
  });
});

describe('missing execution artifacts', () => {
  it('an adopted PASS whose worktree was deleted is never fabricated into a review: the empty change is escalated', async () => {
    let now = 1_000;
    const executor = fakeExecutor();
    executor.reconcile = async ({ runId }) => ({ runId, status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0 });
    const store = makeStore(() => now);
    const { scheduler, worktrees, repo } = setup([workerTask('a')], { store, executor });
    const claim = store.claim({ workerId: 'dead', languages: ['js'], leaseMs: 100, maxActive: 1 })!;
    const ws = await worktrees.prepare(claim.task, store.getBatch('B1')!);
    store.patchTask('a', { worktreePath: ws.path, branch: ws.branch, baseCommit: ws.baseCommit }, 'dead', claim.fence);
    store.transition('a', 'CODING', { actor: 'dead', fence: claim.fence });
    store.recordRun('a', claim.fence, 'finished-run');
    git(repo, 'worktree', 'remove', '--force', ws.path); // artifacts lost (disk cleanup, manual rm, ...)
    now += 10_000;
    await scheduler.run();
    const t = store.requireTask('a');
    assert.equal(t.state, 'ESCALATED');
    assert.equal(t.failureCategory, 'review_gate_blocked');
    assert.equal(store.listReviews().length, 0);
  });

  it('a corrupted Mastra run result (no status) is never treated as a PASS', async () => {
    const mastra = fakeMastra({ onStart: (runId) => mastra.runs.set(runId, { status: 'success', result: { garbage: true } }) });
    const server = await mastra.listen();
    try {
      const { store, scheduler } = setup([workerTask('a')], { executor: createMastraExecutor({ server, pollMs: 10 }) });
      await scheduler.run();
      const t = store.requireTask('a');
      assert.equal(t.state, 'ESCALATED');
      assert.equal(store.listReviews().length, 0);
    } finally {
      await mastra.close();
    }
  });

});

describe('retry after a recorded failure', () => {
  it('`retry` of a RUNTIME_FAILURE runs the task again instead of re-adopting the failed run\'s outcome', async () => {
    const outcomes = new Map<string, Awaited<ReturnType<Executor['run']>>>();
    const executor = fakeExecutor({
      behavior: (input, n) => (n === 1 ? { status: 'RUNTIME_FAILURE', reasons: ['ollama unavailable'], codingAttempts: 0, runtimeRetries: 1 } : undefined),
    });
    const run = executor.run.bind(executor);
    executor.run = async (input) => {
      const outcome = await run(input);
      outcomes.set(outcome.runId!, outcome);
      return outcome;
    };
    // like the Mastra executor: a finished run's outcome can always be fetched again by its id
    executor.reconcile = async ({ runId }) => outcomes.get(runId);
    const { store, scheduler } = setup([workerTask('a')], { executor });
    await scheduler.run();
    assert.equal(store.requireTask('a').state, 'RUNTIME_FAILURE');
    store.transition('a', 'READY', { actor: 'human', reason: 'runtime failure retried', expectFrom: 'RUNTIME_FAILURE' }); // `lead:sched retry a`
    await scheduler.run();
    const t = store.requireTask('a');
    assert.equal(t.state, 'REVIEW_PENDING', `retry should run the task again, got ${t.state}: ${t.stateReason}`);
    assert.equal(executor.calls.length, 2);
    assert.deepEqual(t.runIds, ['run-a-1', 'run-a-2'], 'run history is kept');
  });
});

describe('corrupt scheduler rows are quarantined, not fatal', () => {
  const corrupt = (store: SchedulerStore, id: string, column = 'spec') => store.db.prepare(`UPDATE tasks SET ${column} = '{not json' WHERE id = ?`).run(id);

  it('one corrupted task row does not take the whole scheduler down; it is reported, never rewritten', async () => {
    const store = new SchedulerStore(join(tempDir('sched-db-'), 'sched.db'));
    const { scheduler, worktrees } = setup([workerTask('a'), workerTask('b')], { store });
    corrupt(store, 'b');
    const summary = await scheduler.run();
    assert.deepEqual(summary.reviewPending, ['a']);
    assert.deepEqual(store.corruptRows().map((c) => [c.table, c.id, c.state]), [['tasks', 'b', 'READY']]);
    assert.throws(() => store.requireTask('b'), /task b: column spec is not valid JSON/);
    const issues = await reconcileState(store, worktrees);
    assert.ok(issues.some((i) => i.kind === 'corrupt_row' && i.taskId === 'b'));
    assert.equal((store.db.prepare("SELECT spec FROM tasks WHERE id = 'b'").get() as { spec: string }).spec, '{not json', 'evidence kept as-is');
  });

  it('a corrupt row that may hold files blocks claims in its repository (ownership unknown: fail closed)', () => {
    const store = makeStore();
    store.createBatch(plan('/repo-x', [workerTask('a'), workerTask('b')]));
    store.promote();
    store.claim({ workerId: 'w', languages: ['js'], leaseMs: 60_000, maxActive: 5 }); // a is now CLAIMED (owns its files)
    corrupt(store, 'a');
    assert.equal(store.claim({ workerId: 'w2', languages: ['js'], leaseMs: 60_000, maxActive: 5 }), undefined);
  });

  it('a task depending on a corrupt row waits (neither promoted nor blocked)', () => {
    const store = makeStore();
    store.createBatch(plan('/repo-y', [workerTask('a'), workerTask('b', { dependsOn: ['a'] })]));
    corrupt(store, 'a', 'run_ids');
    const p = store.promote();
    assert.deepEqual(p, { ready: [], blocked: [], unblocked: [] });
    assert.equal(store.requireTask('b').state, 'BACKLOG');
  });

  it('lead CLI status and tasks still work and print the quarantined row', () => {
    const dir = tempDir('sched-cli-');
    const dbFile = join(dir, 'db', 's.db');
    const store = new SchedulerStore(dbFile);
    store.createBatch(plan(makeRepo(), [workerTask('a'), workerTask('b')]));
    store.promote();
    corrupt(store, 'b', 'artifacts');
    store.close();
    const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'lead.ts');
    const env = { ...process.env, AGENTIC_SCHED_DB: dbFile, AGENTIC_SCHED_ROOT: dir };
    const cli = (...a: string[]) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...a], { env, encoding: 'utf8', cwd: dir });
    assert.match(cli('tasks'), /READY\s+p50 a/);
    assert.match(cli('status'), /ISSUE corrupt_row b: tasks row quarantined \(state READY\): task b: column artifacts is not valid JSON/);
  });
});

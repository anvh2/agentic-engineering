import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { reviewDecision } from '../review.ts';
import { integrateBatch, type CommandRunner } from '../../runtime/integration/integrate.ts';
import { Scheduler } from '../../runtime/scheduler/scheduler.ts';
import { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { barrier, fakeExecutor, makeStore, tempDir } from '../../runtime/scheduler/test-helpers.ts';
import { WorktreeManager } from '../../runtime/worktree/worktree.ts';
import { draftOf, lead, makeFixture, objectiveFor, scriptedLead, worker, type Fixture } from './__testing__/fixture.ts';
import { ARTIFACTS, planObjective } from './plan-objective.ts';
import { PlanNotSubmittableError, StalePlanError, submitObjective } from './submit.ts';
import type { PlannedTask } from './types.ts';

/**
 * M7.5 -> M7 contract. Everything the producer (planObjective) emits is submitted to the REAL scheduler store and the
 * REAL scheduler/worktree/integration code, and the DAG, ownership and staleness semantics are checked end to end.
 * Planning executes nothing; submitting queues; only `scheduler.run` executes.
 */

const passRunner: CommandRunner = async () => ({ exitCode: 0, output: 'ok', timedOut: false });
const ID = 'rate-limit';
const tid = (id: string, objective = ID) => `${objective}.${id}`;

let fx: Fixture;
before(async () => {
  fx = await makeFixture();
});
after(() => fx.cleanup());

/** A,B,C independent workers; D worker depends on all three; L is Lead-owned and independent. */
const diamond = (): PlannedTask[] => [worker('a'), worker('b'), worker('c'), worker('d', { dependsOn: ['a', 'b', 'c'] }), lead('l', { allowedFiles: ['src/server.js'] })];

async function plan(tasks: PlannedTask[], id = ID, workdir = fx.workdir) {
  const outcome = await planObjective(objectiveFor(fx, { id }), scriptedLead(draftOf(tasks)), { workdir });
  assert.equal(outcome.status, 'planned', JSON.stringify(outcome.status === 'rejected' ? outcome.validation.errors : outcome.status));
  return outcome;
}
const stateOf = (store: SchedulerStore, id: string, objective = ID) => store.requireTask(tid(id, objective)).state;
const approve = (store: SchedulerStore, id: string) => reviewDecision(store, { maxReviewCorrections: 2 }, { taskId: id, decision: 'APPROVED', feedback: 'lgtm' });

describe('plan -> submit -> execute is three explicit steps', () => {
  it('planning executes nothing and queues nothing; submit queues; only run executes', async () => {
    const store = makeStore();
    const wt = join(tempDir('contract-wt-'), 'worktrees');
    try {
      await plan(diamond());
      assert.deepEqual(store.listTasks({}), [], 'PLAN persisted nothing to the scheduler');
      assert.equal(existsSync(wt), false);
      assert.equal(fx.git('worktree', 'list').trim().split('\n').length, 1, 'PLAN created no worktree');

      const submitted = await submitObjective(fx.workdir, ID, store);
      assert.deepEqual([...submitted.ready].sort(), [tid('a'), tid('b'), tid('c'), tid('l')]);
      assert.equal(store.listTasks({}).length, 5);
      assert.ok(store.listTasks({}).every((t) => t.claims === 0 && t.runId === null), 'SUBMIT executed nothing');
      assert.equal(fx.git('worktree', 'list').trim().split('\n').length, 1, 'SUBMIT created no worktree');
      assert.equal(JSON.parse(await readFile(join(fx.workdir, 'objectives', ID, ARTIFACTS.submitted), 'utf8')).batchId, ID);

      // batch semantics: base commit, repository and task ownership carried across unchanged
      const batch = store.getBatch(ID)!;
      const research = JSON.parse(await readFile(join(fx.workdir, 'objectives', ID, ARTIFACTS.research), 'utf8'));
      assert.equal(batch.baseRef, research.commit);
      assert.equal(batch.repository, fx.repo);
      assert.equal(store.requireTask(tid('l')).executor, 'claude');
      assert.equal(store.requireTask(tid('a')).executor, 'worker');
      assert.equal(store.requireTask(tid('a')).spec.request?.contract.taskId, tid('a'));
      assert.deepEqual(store.requireTask(tid('d')).spec.dependsOn, [tid('a'), tid('b'), tid('c')]);
    } finally {
      store.close();
    }
  });

  it('a second submit of the same objective is refused, not duplicated', async () => {
    const store = makeStore();
    try {
      await plan(diamond(), 'twice');
      await submitObjective(fx.workdir, 'twice', store);
      await assert.rejects(submitObjective(fx.workdir, 'twice', store), /already exists/);
      assert.equal(store.listTasks({}).length, 5);
    } finally {
      store.close();
    }
  });
});

describe('DAG semantics agree between planning and runtime (A,B,C -> D)', () => {
  it('D is dependency-blocked, runs only after A, B and C are integrated; A/B/C run concurrently; Lead task is never run by a worker', async () => {
    const store = makeStore();
    const worktrees = new WorktreeManager(join(tempDir('contract-wt-'), 'worktrees'));
    try {
      await plan(diamond(), 'diamond');
      await submitObjective(fx.workdir, 'diamond', store);
      const id = (t: string) => tid(t, 'diamond');
      assert.equal(store.requireTask(id('d')).state, 'BACKLOG', 'D starts dependency-blocked');
      assert.deepEqual(store.dependencyStatus(store.requireTask(id('d'))).waitingOn.map((w) => w.id).sort(), [id('a'), id('b'), id('c')]);

      const gate = barrier(3);
      const executor = fakeExecutor({ gate: async (input) => (input.task.id === id('d') ? undefined : gate.wait()) });
      const scheduler = new Scheduler({ store, executor, workspace: worktrees, config: { pollMs: 20, maxConcurrentWorkers: 3 } });
      const summary = await scheduler.run();

      assert.equal(summary.peakInFlight, 3, 'the three independent branches ran at the same time');
      assert.deepEqual([...executor.calls].sort(), [id('a'), id('b'), id('c')], 'D did not run early; the Lead-owned task was not run by a worker');
      assert.equal(store.requireTask(id('l')).state, 'READY', 'CLAUDE_LEAD is retained, not silently executed');
      assert.equal(store.requireTask(id('l')).claims, 0);
      assert.equal(store.requireTask(id('d')).state, 'BACKLOG');

      // approval alone is not enough; the prerequisite must be integrated (DONE)
      for (const t of ['a', 'b', 'c']) approve(store, id(t));
      assert.equal(store.requireTask(id('d')).state, 'BACKLOG');
      await integrateBatch(store, worktrees, { batchId: 'diamond', run: passRunner });
      assert.deepEqual(['a', 'b', 'c'].map((t) => store.requireTask(id(t)).state), ['DONE', 'DONE', 'DONE']);
      assert.equal(store.requireTask(id('d')).state, 'READY');

      await scheduler.run();
      assert.deepEqual(executor.calls.filter((c) => c === id('d')).length, 1);
      assert.equal(store.requireTask(id('d')).state, 'REVIEW_PENDING');
      assert.equal(store.requireTask(id('l')).state, 'READY');
    } finally {
      store.close();
    }
  });

  it('a prerequisite that is cancelled or escalated blocks D and its descendants explicitly, with the cause', async () => {
    const store = makeStore();
    try {
      await plan([worker('a'), worker('b'), worker('c'), worker('d', { dependsOn: ['a', 'b', 'c'] }), worker('e', { dependsOn: ['d'] })], 'failing');
      await submitObjective(fx.workdir, 'failing', store);
      const id = (t: string) => tid(t, 'failing');
      store.transition(id('a'), 'CANCELLED', { actor: 'human', reason: 'dropped', patch: { failureCategory: 'cancelled' } });
      store.transition(id('b'), 'CLAIMED', { actor: 'w', reason: 'claim' });
      store.transition(id('b'), 'ESCALATED', { actor: 'w', reason: 'worker gave up' });
      store.promote('test');
      store.promote('test'); // a descendant of a descendant settles on the next pass at the latest

      for (const t of ['d', 'e']) {
        const row = store.requireTask(id(t));
        assert.equal(row.state, 'BLOCKED', t);
        assert.equal(row.failureCategory, 'dependency_failed', t);
      }
      assert.match(store.requireTask(id('d')).stateReason ?? '', /dependency .*failing\.(a|b) is (CANCELLED|ESCALATED)/);
      assert.match(store.requireTask(id('e')).stateReason ?? '', /dependency failing\.d is BLOCKED/);
      assert.equal(stateOf(store, 'c', 'failing'), 'READY', 'unrelated branches are unaffected');
    } finally {
      store.close();
    }
  });
});

describe('ownership semantics', () => {
  it('a worker task waiting on a Lead-owned prerequisite waits for the Lead; nothing falls back to a local worker', async () => {
    const store = makeStore();
    const worktrees = new WorktreeManager(join(tempDir('contract-wt-'), 'worktrees'));
    try {
      await plan([lead('l', { allowedFiles: ['src/server.js'] }), worker('x', { dependsOn: ['l'] })], 'lead-first');
      await submitObjective(fx.workdir, 'lead-first', store);
      const executor = fakeExecutor();
      const summary = await new Scheduler({ store, executor, workspace: worktrees, config: { pollMs: 20 } }).run();
      assert.deepEqual(executor.calls, []);
      assert.deepEqual(summary.claimed, []);
      assert.equal(stateOf(store, 'l', 'lead-first'), 'READY');
      assert.deepEqual(store.dependencyStatus(store.requireTask(tid('x', 'lead-first'))).waitingOn, [{ id: tid('l', 'lead-first'), state: 'READY' }]);
    } finally {
      store.close();
    }
  });

  it('a plan with an unresolved HUMAN_DECISION cannot be submitted at all', async () => {
    const store = makeStore();
    try {
      const decision = lead('pick', { executionOwner: 'HUMAN_DECISION', allowedFiles: [], acceptanceCriteria: [], decision: { question: 'Per key or per IP?', options: [] } });
      await plan([decision, worker('after', { dependsOn: ['pick'] })], 'blocked-on-human');
      await assert.rejects(submitObjective(fx.workdir, 'blocked-on-human', store), PlanNotSubmittableError);
      assert.deepEqual(store.listTasks({}), []);
    } finally {
      store.close();
    }
  });
});

describe('pre-submit staleness protection', () => {
  it('rejects a plan whose researched commit is no longer HEAD, persists nothing, and does not rewrite the base', async () => {
    const store = makeStore();
    try {
      const outcome = await plan(diamond(), 'stale');
      const planned = outcome.plan.baseCommit;
      await writeFile(join(fx.repo, 'src/config.js'), "export const config = { port: 4000 };\n");
      fx.git('commit', '-qam', 'move HEAD after planning');
      const head = fx.git('rev-parse', 'HEAD').trim();

      await assert.rejects(submitObjective(fx.workdir, 'stale', store), (err: unknown) => {
        assert.ok(err instanceof StalePlanError);
        assert.equal(err.code, 'STALE_PLAN');
        assert.equal(err.planCommit, planned);
        assert.equal(err.headCommit, head);
        assert.match(err.message, /research and plan again/);
        return true;
      });
      assert.deepEqual(store.listTasks({}), [], 'nothing reached the scheduler');
      assert.equal(existsSync(join(fx.workdir, 'objectives', 'stale', ARTIFACTS.submitted)), false);
      assert.equal(JSON.parse(await readFile(join(fx.workdir, 'objectives', 'stale', ARTIFACTS.plan), 'utf8')).baseCommit, planned, 'the plan was not silently rewritten');

      // the Lead re-plans against the new HEAD and the same objective can then be submitted
      const replanned = await plan(diamond(), 'stale');
      assert.equal(replanned.plan.baseCommit, head);
      await submitObjective(fx.workdir, 'stale', store);
      assert.equal(store.getBatch('stale')!.baseRef, head);
    } finally {
      store.close();
    }
  });

  it('re-validates plan.json at submit: a hand-edited cycle never reaches the scheduler', async () => {
    const store = makeStore();
    try {
      await plan([worker('a'), worker('b', { dependsOn: ['a'] })], 'tampered');
      const file = join(fx.workdir, 'objectives', 'tampered', ARTIFACTS.plan);
      const edited = JSON.parse(await readFile(file, 'utf8'));
      edited.tasks[0].dependsOn = ['b'];
      await writeFile(file, JSON.stringify(edited));
      await assert.rejects(submitObjective(fx.workdir, 'tampered', store), /no longer valid.*dependency_cycle/s);
      assert.deepEqual(store.listTasks({}), []);
    } finally {
      store.close();
    }
  });

  it('refuses an objective that has no plan', async () => {
    const store = makeStore();
    try {
      await assert.rejects(submitObjective(fx.workdir, 'never-planned', store), /no objective/);
      await planObjective(objectiveFor(fx, { id: 'research-only' }), scriptedLead(() => Promise.reject(new Error('later'))), { workdir: fx.workdir }, () => true);
      await assert.rejects(submitObjective(fx.workdir, 'research-only', store), /no valid plan/);
    } finally {
      store.close();
    }
  });
});

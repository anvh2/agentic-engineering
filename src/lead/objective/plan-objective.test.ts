import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { draftOf, lead, makeFixture, objectiveFor, scriptedLead, worker, type Fixture } from './__testing__/fixture.ts';
import { ObjectiveConflictError, ARTIFACTS, planObjective } from './plan-objective.ts';
import { PlanningIsolationError } from './readonly-repo.ts';
import { batchPlanSchema } from '../../runtime/scheduler/types.ts';
import { SchedulerStore } from '../../runtime/scheduler/store.ts';

let fx: Fixture;
before(async () => {
  fx = await makeFixture();
});
afterEach(async () => {
  fx.git('checkout', '--', '.');
  fx.git('clean', '-fdq');
  for (const b of fx.git('branch', '--format=%(refname:short)').split('\n').filter((b) => b && b !== 'main')) fx.git('branch', '-D', b);
});
after(() => fx.cleanup());

const now = () => new Date('2026-10-07T00:00:00Z');
const read = async (id: string, file: string) => JSON.parse(await readFile(join(fx.workdir, 'objectives', id, file), 'utf8'));
const goodDraft = () => draftOf([worker('limiter'), worker('policy'), lead('wire', { dependsOn: ['limiter', 'policy'] })], { findings: ['server.js mounts middleware via app.use'] });

describe('objective -> research -> plan -> batch (without executing)', () => {
  it('writes objective, research, plan and a scheduler-compatible batch, and touches nothing else', async () => {
    const before = fx.git('status', '--porcelain=v1', '--ignored');
    const outcome = await planObjective(objectiveFor(fx), scriptedLead(goodDraft()), { workdir: fx.workdir, now });
    assert.equal(outcome.status, 'planned');
    assert.ok(outcome.status === 'planned' && outcome.validation.executable);

    assert.deepEqual((await readdir(outcome.dir)).sort(), ['batch.json', 'objective.json', 'plan.json', 'research.json']);
    const research = await read('rate-limit', ARTIFACTS.research);
    const plan = await read('rate-limit', ARTIFACTS.plan);
    assert.equal(plan.baseCommit, research.commit);
    assert.equal(plan.producedBy, 'scripted');
    assert.equal(plan.createdAt, '2026-10-07T00:00:00.000Z');
    assert.equal(plan.validation.readiness, 'executable');
    assert.deepEqual(plan.findings, ['server.js mounts middleware via app.use']);

    // the batch is the EXISTING scheduler contract; the scheduler accepts it as-is
    const batch = batchPlanSchema.parse(await read('rate-limit', ARTIFACTS.batch));
    assert.equal(batch.baseRef, research.commit);
    assert.equal(batch.repository, fx.repo);
    const store = new SchedulerStore(':memory:');
    try {
      store.createBatch(batch);
      assert.equal(store.listTasks({ batchId: 'rate-limit' }).length, 3);
    } finally {
      store.close();
    }

    assert.equal(fx.git('status', '--porcelain=v1', '--ignored'), before, 'the target repository is untouched');
    assert.equal(existsSync(join(fx.workdir, 'scheduler')), false, 'no scheduler state, worktree or worker was created');
    assert.equal(existsSync(join(fx.workdir, 'worktrees')), false);
  });

  it('a Lead that cannot produce a draft yet still leaves the research as evidence', async () => {
    const outcome = await planObjective(objectiveFor(fx, { id: 'research-only' }), scriptedLead(() => Promise.reject(new Error('no draft yet'))), { workdir: fx.workdir }, (e) => /no draft yet/.test((e as Error).message));
    assert.equal(outcome.status, 'researched');
    assert.deepEqual((await readdir(outcome.dir)).sort(), ['objective.json', 'research.json']);
  });

  it('keeps a plan that waits on a human decision, but produces no batch', async () => {
    const decision = lead('pick-key', {
      executionOwner: 'HUMAN_DECISION',
      allowedFiles: [],
      acceptanceCriteria: [],
      decision: { question: 'Per API key or per IP?', options: ['key', 'ip'] },
      assessment: { complexity: 'medium', risk: 'high', ambiguity: 'significant', rationale: 'unclear product requirement' },
    });
    const outcome = await planObjective(objectiveFor(fx, { id: 'needs-human' }), scriptedLead(draftOf([decision, lead('after', { dependsOn: ['pick-key'] })])), { workdir: fx.workdir });
    assert.ok(outcome.status === 'planned');
    assert.equal(outcome.validation.readiness, 'needs_human_decision');
    assert.equal(outcome.batchPath, undefined);
    assert.equal(existsSync(join(outcome.dir, ARTIFACTS.batch)), false);
    assert.equal(existsSync(join(outcome.dir, ARTIFACTS.plan)), true);
  });
});

describe('invalid plans fail before anything schedulable exists', () => {
  it('a cycle yields rejected evidence, no plan.json and no batch.json', async () => {
    const cyclic = draftOf([worker('a', { dependsOn: ['b'] }), worker('b', { dependsOn: ['a'] }), worker('c')]);
    const outcome = await planObjective(objectiveFor(fx, { id: 'cyclic' }), scriptedLead(cyclic), { workdir: fx.workdir });
    assert.equal(outcome.status, 'rejected');
    assert.ok(outcome.status === 'rejected' && outcome.validation.errors.some((e) => e.code === 'dependency_cycle'));
    assert.deepEqual((await readdir(outcome.dir)).sort(), ['objective.json', 'plan.rejected.json', 'research.json']);
  });

  it('a later valid draft replaces the rejection; a later invalid one removes a stale plan and batch', async () => {
    const id = 'iterate';
    const first = await planObjective(objectiveFor(fx, { id }), scriptedLead(draftOf([worker('a', { dependsOn: ['ghost'] })])), { workdir: fx.workdir });
    assert.equal(first.status, 'rejected');
    const second = await planObjective(objectiveFor(fx, { id }), scriptedLead(draftOf([worker('a')])), { workdir: fx.workdir });
    assert.equal(second.status, 'planned');
    assert.deepEqual((await readdir(second.dir)).sort(), ['batch.json', 'objective.json', 'plan.json', 'research.json']);
    const third = await planObjective(objectiveFor(fx, { id }), scriptedLead(draftOf([worker('a', { allowedFiles: [] })])), { workdir: fx.workdir });
    assert.equal(third.status, 'rejected');
    assert.deepEqual((await readdir(third.dir)).sort(), ['objective.json', 'plan.rejected.json', 'research.json']);
  });

  it('garbage from the Lead is a rejection, not a crash', async () => {
    for (const draft of [null, 'a plan', 42, { tasks: 'none' }]) {
      const outcome = await planObjective(objectiveFor(fx, { id: 'garbage' }), scriptedLead(draft), { workdir: fx.workdir });
      assert.equal(outcome.status, 'rejected');
    }
  });

  it('a draft cannot forge the plan identity fields', async () => {
    const forged = { ...goodDraft(), baseCommit: 'deadbeef', objectiveId: 'other', producedBy: 'someone', repository: '/etc' };
    const outcome = await planObjective(objectiveFor(fx, { id: 'forged' }), scriptedLead(forged), { workdir: fx.workdir });
    assert.ok(outcome.status === 'planned');
    assert.equal(outcome.plan.objectiveId, 'forged');
    assert.equal(outcome.plan.producedBy, 'scripted');
    assert.equal(outcome.plan.repository, fx.repo);
    assert.equal(outcome.plan.baseCommit, outcome.research.commit);
  });

  it('refuses to reuse an objective id for a different objective', async () => {
    await planObjective(objectiveFor(fx, { id: 'same-id' }), scriptedLead(goodDraft()), { workdir: fx.workdir });
    await assert.rejects(planObjective(objectiveFor(fx, { id: 'same-id', title: 'Something else' }), scriptedLead(goodDraft()), { workdir: fx.workdir }), ObjectiveConflictError);
    // the identical objective may be planned again (iteration)
    assert.equal((await planObjective(objectiveFor(fx, { id: 'same-id' }), scriptedLead(goodDraft()), { workdir: fx.workdir })).status, 'planned');
  });

  it('rejects an objective id that could escape the objectives directory', async () => {
    await assert.rejects(planObjective(objectiveFor(fx, { id: '..' }), scriptedLead(goodDraft()), { workdir: fx.workdir }), /must be/);
    await assert.rejects(planObjective(objectiveFor(fx, { id: 'a/b' }), scriptedLead(goodDraft()), { workdir: fx.workdir }), /must be/);
  });
});

describe('planning isolation', () => {
  it('discards the result if research writes into the target repository', async () => {
    const mutator = scriptedLead(goodDraft(), { beforeResearch: () => writeFile(join(fx.repo, 'src/config.js'), '// tampered\n') });
    await assert.rejects(planObjective(objectiveFor(fx, { id: 'iso-research' }), mutator, { workdir: fx.workdir }), PlanningIsolationError);
    assert.equal(existsSync(join(fx.workdir, 'objectives', 'iso-research', ARTIFACTS.research)), false, 'tainted research is not recorded');
  });

  it('discards the plan if planning creates a file, a branch or a commit', async () => {
    const attempts: Array<() => Promise<void> | void> = [
      () => writeFile(join(fx.repo, 'NEW.md'), 'x\n'),
      () => void fx.git('branch', 'planner-was-here'),
      () => void fx.git('commit', '--allow-empty', '-m', 'planner commit'),
    ];
    for (const [i, attempt] of attempts.entries()) {
      const outcome = planObjective(objectiveFor(fx, { id: `iso-plan-${i}` }), scriptedLead(goodDraft(), { beforePlan: attempt }), { workdir: fx.workdir });
      await assert.rejects(outcome, PlanningIsolationError, `attempt ${i}`);
      assert.equal(existsSync(join(fx.workdir, 'objectives', `iso-plan-${i}`, ARTIFACTS.plan)), false);
      assert.equal(existsSync(join(fx.workdir, 'objectives', `iso-plan-${i}`, ARTIFACTS.batch)), false);
      fx.git('reset', '-q', '--hard', 'main'); // undo the simulated violation for the next attempt
      fx.git('clean', '-fdq');
    }
  });

  it('reports the violation even when the Lead then fails', async () => {
    const lead_ = scriptedLead(() => Promise.reject(new Error('model crashed')), { beforePlan: () => writeFile(join(fx.repo, 'NEW.md'), 'x\n') });
    await assert.rejects(planObjective(objectiveFor(fx, { id: 'iso-throw' }), lead_, { workdir: fx.workdir }), PlanningIsolationError);
  });
});

describe('PLAN is not EXECUTE (structural)', () => {
  it('no planning module imports the scheduler store/runner, worktrees, integration, executors or Mastra', async () => {
    const forbidden = /from '(\.\.\/)+(runtime\/(scheduler\/(scheduler|store|claim-child)|worktree|integration|capacity|sandbox)|integrations|workers)[^']*'|from '@mastra[^']*'/;
    for (const file of (await readdir(join(import.meta.dirname))).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = await readFile(join(import.meta.dirname, file), 'utf8');
      for (const line of source.split('\n').filter((l) => l.startsWith('import ') || /^\s*from '/.test(l))) assert.doesNotMatch(line, forbidden, `${file}: ${line}`);
    }
  });
});

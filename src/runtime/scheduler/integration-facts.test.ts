import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SchedulerStore, StoreError } from './store.ts';
import { computeMetrics, integrationNote, renderBacklog } from './report.ts';
import { makeStore } from './test-helpers.ts';
import { runObjectiveLifecycle } from '../../lead/lifecycle/driver.ts';
import { harness } from '../../lead/lifecycle/__testing__/fixture.ts';

/**
 * Execution, integration and acceptance are separate facts (M10.1). DONE is terminal and is history; whether the code is still
 * integrated is an append-only fact beside it. The pinned oracle (tests/reliability/oracle) states the behaviour; these tests
 * cover the guarantees underneath it.
 */

const claudeTask = (id: string, dependsOn: string[] = []) => ({ id, title: id, executor: 'claude' as const, keptReason: 'fixture', dependsOn });
function done(store: SchedulerStore, id: string): void {
  if (store.requireTask(id).state === 'BACKLOG') store.transition(id, 'READY', { actor: 't' });
  store.transition(id, 'CODING', { actor: 't' });
  store.transition(id, 'DONE', { actor: 't', reason: 'implemented', patch: { implementedBy: 'claude' } });
}
const batch = (store: SchedulerStore, ...tasks: ReturnType<typeof claudeTask>[]) => store.createBatch({ batchId: 'B', project: 'p', repository: '/tmp/none', tasks });

describe('integration facts are append-only at the database level', () => {
  it('UPDATE and DELETE of a fact are refused by the database itself, not only by the API', () => {
    const store = makeStore();
    batch(store, claudeTask('a'));
    done(store, 'a');
    store.recordRevert('a', { actor: 'lead', reason: 'reverted', commit: 'abc' });
    assert.throws(() => store.db.prepare("UPDATE integration_facts SET kind = 'reinstated'").run(), /append-only/);
    assert.throws(() => store.db.prepare('DELETE FROM integration_facts').run(), /append-only/);
    assert.equal(store.projection('a').integration.state, 'reverted', 'and the fact is untouched');
  });

  it('a fact and its audit event are written together or not at all', () => {
    const store = makeStore();
    batch(store, claudeTask('a'));
    done(store, 'a');
    const events = store.events().length;
    assert.throws(() => store.recordReinstatement('a', { actor: 'lead', reason: 'never reverted' }), StoreError);
    assert.equal(store.events().length, events, 'a refused fact leaves no event');
    assert.equal(store.integrationFacts('a').length, 0, 'and no fact');
    store.recordRevert('a', { actor: 'lead', reason: 'r' });
    assert.equal(store.events().length, events + 1);
    assert.equal(store.integrationFacts('a').length, 1);
  });

  it('only a DONE task has an implementation to revert; every other state is refused with a state_mismatch', () => {
    const store = makeStore();
    batch(store, claudeTask('a'));
    for (const advance of [() => undefined, () => store.transition('a', 'READY', { actor: 't' }), () => store.transition('a', 'CODING', { actor: 't' })]) {
      advance();
      assert.throws(() => store.recordRevert('a', { actor: 'lead', reason: 'x' }), (e) => e instanceof StoreError && e.code === 'state_mismatch');
    }
    assert.throws(() => store.recordRevert('a', { actor: '', reason: 'x' }), (e) => e instanceof StoreError && e.code === 'invalid');
  });
});

describe('what the views say', () => {
  it('projection separates execution, integration and acceptance for every state', () => {
    const store = makeStore();
    batch(store, claudeTask('a'), claudeTask('b'));
    done(store, 'a');
    assert.deepEqual([store.projection('a').execution.state, store.projection('a').integration.state, store.projection('a').accepted], ['DONE', 'integrated', true]);
    assert.deepEqual([store.projection('b').execution.state, store.projection('b').integration.state, store.projection('b').accepted], ['BACKLOG', 'not_integrated', false]);
    store.recordRevert('a', { actor: 'lead', reason: 'r' });
    assert.deepEqual([store.projection('a').execution.state, store.projection('a').integration.state, store.projection('a').accepted], ['DONE', 'reverted', false]);
  });

  it('integrationNote and the markdown backlog say a reverted task is not currently integrated; an intact one says nothing', () => {
    const store = makeStore();
    batch(store, claudeTask('a'), claudeTask('b'));
    done(store, 'a');
    done(store, 'b');
    store.recordRevert('a', { actor: 'lead', reason: 'false STOPPED', commit: '94f5239' });
    assert.match(integrationNote(store, store.requireTask('a')) ?? '', /REVERTED by 94f5239.*not currently integrated/);
    assert.equal(integrationNote(store, store.requireTask('b')), undefined);
    const md = renderBacklog(store, 'B');
    assert.match(md, /### a:[^\n]*\n[^\n]*REVERTED/);
    assert.doesNotMatch(md.split('### b:')[1] ?? '', /REVERTED/);
  });

  it('metrics: history counts stay, integrated counts drop, the revert is reported', () => {
    const store = makeStore();
    batch(store, claudeTask('a'), claudeTask('b'));
    done(store, 'a');
    done(store, 'b');
    store.recordRevert('a', { actor: 'lead', reason: 'r' });
    store.recordReinstatement('a', { actor: 'lead', reason: 'back' });
    assert.equal(computeMetrics(store, 'B').doneByClaude, 2);
    store.recordRevert('a', { actor: 'lead', reason: 'again' });
    const m = computeMetrics(store, 'B');
    assert.deepEqual([m.doneByClaude, m.revertedAfterDone, m.byState.DONE], [1, 1, 2]);
  });
});

describe('a reverted required task stops its objective', () => {
  it('the lifecycle driver escalates instead of accepting, and keeps the task DONE', async () => {
    const h = harness({ solutions: {} });
    await h.pin();
    for (const id of ['pad', 'title', 'describe']) {
      if (h.store.requireTask(id).state === 'BACKLOG') h.store.transition(id, 'READY', { actor: 't' });
      h.store.transition(id, 'CODING', { actor: 't', expectFrom: 'READY' });
      h.store.transition(id, 'DONE', { actor: 't', expectFrom: 'CODING', reason: 'integrated', patch: { implementedBy: 'claude' } });
    }
    h.store.recordRevert('title', { actor: 'lead', reason: 'reverted by hand', commit: 'deadbee' });
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ESCALATED', JSON.stringify(out.stops));
    assert.equal(out.reason, 'task_reverted');
    assert.match(out.stops.join('\n'), /title is DONE but its implementation was reverted/);
    assert.equal(h.store.requireTask('title').state, 'DONE');
    assert.notEqual(h.lifecycle.require('obj1').phase, 'ACCEPTED');
  });
});

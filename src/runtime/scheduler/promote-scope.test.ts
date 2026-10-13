import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cancelTask } from '../../lead/cancel.ts';
import { recoverRuntimeFailure } from '../../lead/recovery.ts';
import { Scheduler } from './scheduler.ts';
import { StoreError, type SchedulerStore } from './store.ts';
import { fakeExecutor, makeStore } from './test-helpers.ts';

/**
 * Objective-scoped promotion (M10.1). `promote()` is the scheduler's global pass; every command that acts on ONE objective
 * promotes only that objective (and what depends on it). The pinned oracle states the contract; this covers the call sites.
 */

const task = (id: string, dependsOn: string[] = []) => ({ id, title: id, executor: 'claude' as const, keptReason: 'fixture', dependsOn });
const plan = (batchId: string, ...tasks: ReturnType<typeof task>[]) => ({ batchId, project: 'p', repository: '/tmp/none', tasks });

/** Objective X holds a task whose dependency is dead: any GLOBAL promote would turn x-child BLOCKED. */
function withStrangerX(): SchedulerStore {
  const store = makeStore();
  store.createBatch(plan('X', task('x-dep'), task('x-child', ['x-dep'])));
  store.transition('x-dep', 'CANCELLED', { actor: 't', reason: 'dead' });
  return store;
}
const untouched = (store: SchedulerStore) => {
  assert.equal(store.requireTask('x-child').state, 'BACKLOG', 'the stranger objective was not promoted');
  assert.equal(store.events('x-child').length, 1, 'and gained no event');
};

describe('every single-objective command promotes only its own objective', () => {
  it('lead cancel', async () => {
    const store = withStrangerX();
    store.createBatch(plan('Y', task('y-a'), task('y-b', ['y-a'])));
    store.promote('t', { batchId: 'Y' });
    await cancelTask(store, { taskId: 'y-a', executor: {}, graceMs: 10 });
    assert.equal(store.requireTask('y-b').state, 'BLOCKED', 'its own dependent follows the cancel');
    untouched(store);
  });

  it('lead recover (retry and escalate)', () => {
    for (const action of [{ kind: 'retry' }, { kind: 'escalate' }] as const) {
      const store = withStrangerX();
      store.createBatch(plan('Y', task('y-a')));
      store.transition('y-a', 'READY', { actor: 't' });
      store.transition('y-a', 'CODING', { actor: 't' });
      store.transition('y-a', 'RUNTIME_FAILURE', { actor: 't', reason: 'boom' });
      recoverRuntimeFailure(store, 'y-a', { reason: 'again', action });
      untouched(store);
    }
  });

  it('a scheduler run limited to one batch', async () => {
    const store = withStrangerX();
    store.createBatch(plan('Y', task('y-a')));
    const scheduler = new Scheduler({ store, executor: fakeExecutor(), workspace: {} as never, config: { pollMs: 5 } });
    await scheduler.run({ batchId: 'Y' });
    assert.equal(store.requireTask('y-a').state, 'READY', 'its own batch was promoted');
    untouched(store);
  });

  it('a scheduler run limited to an unknown batch fails loudly instead of acting on everything', async () => {
    const store = withStrangerX();
    const scheduler = new Scheduler({ store, executor: fakeExecutor(), workspace: {} as never, config: { pollMs: 5 } });
    await assert.rejects(scheduler.run({ batchId: 'no-such-batch' }), /unknown batch/);
    untouched(store);
  });

  it('an unscoped scheduler run is still the global pass', async () => {
    const store = withStrangerX();
    const scheduler = new Scheduler({ store, executor: fakeExecutor(), workspace: {} as never, config: { pollMs: 5 } });
    await scheduler.run();
    assert.equal(store.requireTask('x-child').state, 'BLOCKED');
  });
});

describe('promote scope validation', () => {
  it('an empty or unknown batch id is refused with a StoreError and promotes nothing', () => {
    const store = withStrangerX();
    for (const batchId of ['', 'nope']) assert.throws(() => store.promote('t', { batchId }), (e) => e instanceof StoreError);
    untouched(store);
  });

  it('a scoped pass never reads another objective\'s corrupt row as a reason to act', () => {
    const store = withStrangerX();
    store.createBatch(plan('Y', task('y-a')));
    store.db.prepare("UPDATE tasks SET spec = '{not json' WHERE id = 'x-child'").run();
    assert.deepEqual(store.promote('t', { batchId: 'Y' }).ready, ['y-a']);
  });
});

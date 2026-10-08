import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ModelCapacity } from '../runtime/capacity/model-capacity.ts';
import { makeStore, plan, tempDir, workerTask } from '../runtime/scheduler/test-helpers.ts';
import { createMetrics } from './metrics.ts';
import { INTEGRATION_FAILURE_CATEGORIES, readModelCapacity } from './scheduler-state.ts';

/** M7 observability: the concurrency series are derived from the persisted state and carry no per-task labels. */

function series(text: string, name: string, labels = ''): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(labels ? `${name}{${labels}} ` : `${name} `));
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
}

describe('M7 concurrency metrics', () => {
  it('reports dependency-blocked tasks, scheduler retries and integration failures from the scheduler database', async () => {
    let now = 1_000;
    const dbDir = tempDir('conc-metrics-');
    const store = (await import('../runtime/scheduler/store.ts')).SchedulerStore;
    const s = new store(join(dbDir, 'sched.db'), { now: () => now });
    s.createBatch(
      plan('/r', [
        workerTask('root'),
        workerTask('child', { dependsOn: ['root'] }),
        workerTask('flaky', { maxClaims: 3 }),
        workerTask('conflicted'),
        workerTask('unverified'),
        workerTask('waiting-on-flaky', { dependsOn: ['flaky'] }),
      ]),
    );
    s.promote();
    // claims come in (priority, creation, id) order: conflicted, flaky, root, unverified
    const claimed = Object.fromEntries(Array.from({ length: 4 }, (_, i) => s.claim({ workerId: `w-${i}`, languages: ['js'], leaseMs: 100, maxActive: 10 })!).map((c) => [c.task.id, c]));
    assert.deepEqual(Object.keys(claimed).sort(), ['conflicted', 'flaky', 'root', 'unverified']);

    s.transition('root', 'ESCALATED', { actor: 'w', fence: claimed.root.fence, reason: 'exhausted' });
    s.promote(); // child -> BLOCKED(dependency_failed)
    for (const [id, category] of [['conflicted', 'integration_conflict'], ['unverified', 'integration_verification_failed']] as const) {
      s.transition(id, 'ESCALATED', { actor: 'integrator', fence: claimed[id].fence, patch: { failureCategory: category }, reason: category });
    }

    now += 1_000; // flaky's worker died: its lease expires and it is claimed a second time => one extra claim
    assert.deepEqual(s.reapExpired().requeued, ['flaky']);
    assert.equal(s.claim({ workerId: 'w-again', languages: ['js'], leaseMs: 100, maxActive: 10 })?.task.id, 'flaky');

    const text = await createMetrics({ schedulerDbPath: join(dbDir, 'sched.db'), modelCapacityDbPath: join(dbDir, 'absent.db') }).render();
    assert.equal(series(text, 'scheduler_dependency_blocked_tasks'), 1, 'child is blocked because root can never complete');
    assert.equal(series(text, 'scheduler_extra_claims'), 1, 'flaky was claimed twice');
    assert.equal(series(text, 'scheduler_integration_failed_tasks', 'category="integration_conflict"'), 1);
    assert.equal(series(text, 'scheduler_integration_failed_tasks', 'category="integration_verification_failed"'), 1);
    assert.equal(series(text, 'scheduler_integration_failed_tasks', 'category="diverged_after_review"'), 0);
    assert.equal(series(text, 'scheduler_tasks', 'state="BACKLOG"'), 1, 'waiting-on-flaky waits for a live dependency: BACKLOG, not blocked');
    assert.equal(series(text, 'scheduler_tasks', 'state="BLOCKED"'), 1);
    assert.equal(series(text, 'model_capacity_permits'), undefined, 'an absent capacity database yields no series, not zeros');

    // low cardinality: no task id, worker id or run id ever appears as a label value
    assert.doesNotMatch(text, /task_id|"root"|"flaky"|w-\d/);
  });

  it('reports model utilization from the machine-wide capacity database, and its waiting separately from inference', async () => {
    const capacityDb = join(tempDir('conc-cap-'), 'cap.db');
    const capacity = new ModelCapacity(capacityDb, { permits: 2, pollMs: 5 });
    const metrics = createMetrics({ schedulerDbPath: join(tempDir('conc-none-'), 'missing.db'), modelCapacityDbPath: capacityDb });
    try {
      assert.deepEqual(readModelCapacity(capacityDb), { permits: 2, inUse: 0 });
      const lease = capacity.tryAcquire('qwen:T-1');
      assert.ok(lease);
      let text = await metrics.render();
      assert.equal(series(text, 'model_capacity_permits'), 2);
      assert.equal(series(text, 'model_capacity_in_use'), 1);
      lease.release();
      text = await metrics.render();
      assert.equal(series(text, 'model_capacity_in_use'), 0);

      metrics.modelCapacityWait(0.4, 'acquired');
      metrics.modelCapacityWait(30, 'aborted');
      metrics.modelCapacityWait(1, 'weird-outcome'); // clamped, never a new label value
      text = await metrics.render();
      assert.equal(series(text, 'model_capacity_wait_seconds_count', 'outcome="acquired"'), 1);
      assert.equal(series(text, 'model_capacity_wait_seconds_count', 'outcome="aborted"'), 1);
      assert.equal(series(text, 'model_capacity_wait_seconds_count', 'outcome="other"'), 1);
    } finally {
      capacity.close();
    }
  });

  it('the integration failure categories it reports are exactly the ones integration produces', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../runtime/integration/integrate.ts', import.meta.url), 'utf8');
    const produced = new Set([...source.matchAll(/'(integration_[a-z_]+|diverged_after_review)'/g)].map((m) => m[1]));
    assert.deepEqual([...produced].sort(), [...INTEGRATION_FAILURE_CATEGORIES].sort());
  });
});

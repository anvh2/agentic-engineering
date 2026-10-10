import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SchedulerStore } from '../../../runtime/scheduler/store.ts';
import { plan, workerTask } from '../../../runtime/scheduler/test-helpers.ts';
import { createReader } from '../adapter.ts';

/** Synthetic data used exclusively by tests. No executor, model, or actual repository task is run. */
export function fixture(initialNow = 1700000000000) {
  const directory = mkdtempSync(join(tmpdir(), 'control-center-test-'));
  const dbPath = join(directory, 'scheduler.db');
  let time = initialNow;
  const store = new SchedulerStore(dbPath, { now: () => time });
  store.createBatch(
    plan('/synthetic-test-repo', [
      workerTask('task-a', { title: 'Implement scoped parser' }),
      workerTask('task-b', { title: 'Verify parser behavior', dependsOn: ['task-a'] }),
    ]),
  );
  store.createBatch(plan('/synthetic-test-repo', [workerTask('old-smoke')], { batchId: 'historical-smoke' }));
  const reader = createReader({ dbPath, now: () => time });
  return {
    directory,
    dbPath,
    store,
    reader,
    advance: (ms: number) => {
      time += ms;
    },
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
    claim: () => {
      store.promote();
      return store.claim({ workerId: 'worker-1', languages: ['js'], leaseMs: 1000, maxActive: 3, batchId: 'B1' })!;
    },
  };
}

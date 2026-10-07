// Child process for metrics tests: plays the separate scheduler/CLI process against a shared SQLite file.
//   hold   <db>   claim one of two tasks (lease 60s), print CLAIMED, then stay alive until stdin closes
//   decide <db>   drive two tasks to REVIEW_PENDING and record Claude review decisions (APPROVED, ESCALATED_TO_HUMAN), then exit
//   reap   <db>   a restarted scheduler: reap expired leases (requeue) and exit
import { SchedulerStore } from '../runtime/scheduler/store.ts';
import { workerTask } from '../runtime/scheduler/test-helpers.ts';

const [mode, dbPath] = process.argv.slice(2);
const store = new SchedulerStore(dbPath);
const plan = (ids: string[]) => {
  store.createBatch({ batchId: 'B1', project: 'p', repository: '/tmp/none', tasks: ids.map((id) => workerTask(id)) });
  store.promote('test');
};

if (mode === 'hold') {
  plan(['T1', 'T2']);
  const claim = store.claim({ workerId: 'child-w1', languages: ['js', 'go'], leaseMs: 60_000, maxActive: 1 });
  console.log(`CLAIMED ${claim?.task.id}`);
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else if (mode === 'decide') {
  plan(['R1', 'R2']);
  for (const id of ['R1', 'R2']) {
    const claim = store.claim({ workerId: 'child-w1', languages: ['js', 'go'], leaseMs: 60_000, maxActive: 5, batchId: 'B1' });
    if (!claim) throw new Error('nothing claimable');
    const { fence, task } = claim;
    store.transition(task.id, 'CODING', { actor: fence.owner, reason: 'start', expectFrom: 'CLAIMED', fence });
    store.transition(task.id, 'VERIFYING', { actor: fence.owner, reason: 'pass', expectFrom: 'CODING', fence });
    store.transition(task.id, 'REVIEW_PENDING', { actor: fence.owner, reason: 'verified', expectFrom: 'VERIFYING', fence, review: { taskId: task.id, title: task.title } });
    store.applyReviewDecision({ taskId: task.id, decision: id === 'R1' ? 'APPROVED' : 'ESCALATED_TO_HUMAN', reviewer: 'claude-engineering-lead', feedback: 'ok', maxCorrections: 1 });
  }
} else if (mode === 'reap') {
  console.log(JSON.stringify(store.reapExpired('restart')));
}
store.close?.();

// Child process used by store.test.ts: claims tasks in a loop against a shared DB file and prints the ids it won.
// Optional third argument: the maxActive limit to claim under (default: effectively unbounded).
import { SchedulerStore } from './store.ts';

const [dbPath, workerId, maxActive] = process.argv.slice(2);
const store = new SchedulerStore(dbPath);
const won: string[] = [];
for (;;) {
  const claim = store.claim({ workerId, languages: ['js', 'go'], leaseMs: 60_000, maxActive: Number(maxActive ?? 1000) });
  if (!claim) break;
  won.push(claim.task.id);
}
console.log(JSON.stringify(won));

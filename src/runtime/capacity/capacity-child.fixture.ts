// Child process used by model-capacity.test.ts: takes a permit on a shared lease DB, holds it, and reports timings.
import { ModelCapacity } from './model-capacity.ts';

const [dbPath, holdMs, mode] = process.argv.slice(2);
const capacity = new ModelCapacity(dbPath, { pollMs: 20, leaseMs: 2_000 });
const lease = await capacity.acquire(`child-${process.pid}`);
const start = Date.now();
if (mode === 'hold-forever') {
  console.log(JSON.stringify({ pid: process.pid, acquired: start }));
  setInterval(() => {}, 1 << 30); // a REF'd timer: a bare never-resolving promise does not keep Node alive (the child would exit and its lease be reaped as a dead pid)
  await new Promise(() => {}); // until killed
}
await new Promise((r) => setTimeout(r, Number(holdMs)));
const end = Date.now();
lease.release();
console.log(JSON.stringify({ pid: process.pid, start, end }));
process.exit(0);

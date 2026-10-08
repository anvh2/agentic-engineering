// Child process used by model-capacity-fifo.test.ts: queues for a permit on a shared capacity DB and reports, as JSON
// lines on stdout, when it is queued (with its ticket), when it is admitted, and when it releases.
//   argv: <db> <holdMs> [hold-forever]
import { ModelCapacity } from './model-capacity.ts';

const [dbPath, holdMs, mode] = process.argv.slice(2);
const capacity = new ModelCapacity(dbPath, { pollMs: 10, leaseMs: 5_000, waiterLeaseMs: 60_000 });
const say = (o: object) => console.log(JSON.stringify({ pid: process.pid, ...o }));
const waiting = capacity.acquire(`child-${process.pid}`, undefined, { tag: `child-${process.pid}` }); // the ticket is taken synchronously, here
say({ event: 'queued', ticket: capacity.queue().find((w) => w.pid === process.pid)?.ticket });
const lease = await waiting;
say({ event: 'acquired', at: Date.now() });
if (mode === 'hold-forever') {
  setInterval(() => {}, 1 << 30); // a REF'd timer: a bare never-resolving promise does not keep Node alive, the child would exit and its lease would be reaped as a dead pid
  await new Promise(() => {}); // until killed
}
await new Promise((r) => setTimeout(r, Number(holdMs)));
const releasedAt = Date.now(); // stamped BEFORE releasing: the reported hold [acquired, released] lies inside the true hold, so a successor can never appear to overlap it
lease.release();
say({ event: 'released', at: releasedAt });
process.exit(0);

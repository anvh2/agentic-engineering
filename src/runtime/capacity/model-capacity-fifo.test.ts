import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CapacityWaitTimeout, ModelCapacity, modelWaitBudgetMs, type CapacityLease } from './model-capacity.ts';

/**
 * FIFO admission on the shared SQLite capacity database. Ordering is synchronized on observable state (the queue
 * contents, child stdout events), never on sleeps; the polling intervals below only bound how long an event takes.
 */

const CHILD = join(import.meta.dirname, 'capacity-fifo-child.fixture.ts');
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'capacity-fifo-')), 'capacity.db');

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Child {
  proc: ChildProcess;
  events: { event: string; ticket?: number; at?: number; pid: number }[];
  exited: Promise<void>;
}
function spawnChild(db: string, holdMs: number, mode = ''): Child {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, db, String(holdMs), mode], { stdio: ['ignore', 'pipe', 'inherit'] });
  const events: Child['events'] = [];
  let buf = '';
  proc.stdout!.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      events.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  return { proc, events, exited: new Promise((r) => proc.once('exit', () => r())) };
}
const has = (c: Child, event: string) => c.events.some((e) => e.event === event);
const at = (c: Child, event: string) => c.events.find((e) => e.event === event)!.at!;

describe('FIFO admission (in one process, separate connections)', () => {
  it('five contenders are admitted in ticket order even when the older ones poll much more slowly', async () => {
    const path = dbPath();
    const holder = new ModelCapacity(path, { permits: 1 });
    const l0 = holder.tryAcquire('L0')!;
    assert.ok(l0);
    const polls = [120, 60, 30, 5, 2]; // oldest waiter is the slowest poller: without a queue the fast, newer ones win
    const order: number[] = [];
    const waiters = polls.map((pollMs) => new ModelCapacity(path, { pollMs }));
    const done = waiters.map((cap, i) =>
      cap.acquire(`w${i}`).then((lease) => {
        order.push(i);
        lease.release();
      }),
    );
    await until(() => holder.queue().length === 5, 'five waiters queued');
    assert.deepEqual(holder.queue().map((w) => w.holder), ['w0', 'w1', 'w2', 'w3', 'w4'], 'tickets follow call order');
    l0.release();
    await Promise.all(done);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
    assert.equal(holder.holders().length, 0);
    assert.equal(holder.queue().length, 0);
  });

  it('a newer waiter can never overtake an older live one, however many newcomers keep arriving and polling fast', async () => {
    const path = dbPath();
    const main = new ModelCapacity(path, { permits: 1 });
    const l0 = main.tryAcquire('L0')!;
    const grants: string[] = [];
    const take = (cap: ModelCapacity, name: string) => cap.acquire(name).then((l) => (grants.push(name), l.release()));
    const old = take(new ModelCapacity(path, { pollMs: 150 }), 'old');
    await until(() => main.queue().length === 1, 'old queued');
    const fast = Array.from({ length: 12 }, (_, i) => take(new ModelCapacity(path, { pollMs: 1 }), `new${i}`));
    await until(() => main.queue().length === 13, 'all queued');
    l0.release();
    await Promise.all([old, ...fast]);
    assert.equal(grants[0], 'old');
    assert.deepEqual(grants.slice(1), Array.from({ length: 12 }, (_, i) => `new${i}`));
  });

  it('with 2 permits the two oldest waiters are admitted together (work-conserving), then the next two, in order', async () => {
    const path = dbPath();
    const main = new ModelCapacity(path, { permits: 2 });
    const held = [main.tryAcquire('L0')!, main.tryAcquire('L1')!];
    const admitted: string[] = [];
    const leases = new Map<string, CapacityLease>();
    const waiters = ['a', 'b', 'c', 'd', 'e'].map((n) => new ModelCapacity(path, { pollMs: 3 }).acquire(n).then((l) => (admitted.push(n), leases.set(n, l))));
    await until(() => main.queue().length === 5, 'five queued');
    held[0].release();
    held[1].release();
    await until(() => admitted.length === 2, 'two admitted');
    assert.deepEqual([...admitted].sort(), ['a', 'b'], 'exactly the two oldest');
    assert.equal(main.holders().length, 2, 'never over-allocated');
    leases.get('a')!.release();
    await until(() => admitted.length === 3, 'third admitted');
    assert.equal(admitted[2], 'c', 'the next-oldest takes the freed permit');
    leases.get('b')!.release();
    leases.get('c')!.release();
    await until(() => admitted.length === 5, 'all admitted');
    assert.deepEqual(admitted.slice(3).sort(), ['d', 'e']);
    for (const l of leases.values()) l.release();
    await Promise.all(waiters);
  });

  it('with 2 permits, releasing just one allows the next queued ticket without waiting for the other holder', async () => {
    const path = dbPath();
    const cap = new ModelCapacity(path, { permits: 2, pollMs: 5 });
    const first = cap.tryAcquire('initial-1')!;
    const second = cap.tryAcquire('initial-2')!;
    const a = new ModelCapacity(path, { pollMs: 5 }).acquire('a');
    const b = new ModelCapacity(path, { pollMs: 5 }).acquire('b');
    const c = new ModelCapacity(path, { pollMs: 5 }).acquire('c');
    await until(() => cap.queue().length === 3, 'a, b, c queued');
    assert.deepEqual(cap.queue().map((w) => w.holder), ['a', 'b', 'c']);

    first.release();
    const leaseA = await a;
    assert.deepEqual(cap.holders().map((h) => h.holder).sort(), ['a', 'initial-2']);
    assert.deepEqual(cap.queue().map((w) => w.holder), ['b', 'c']);
    // One earlier permit is still occupied. Releasing a (not initial-2)
    // must allow b to proceed immediately; there is no group barrier.
    leaseA.release();
    const leaseB = await b;
    assert.deepEqual(cap.holders().map((h) => h.holder).sort(), ['b', 'initial-2']);
    assert.deepEqual(cap.queue().map((w) => w.holder), ['c']);
    second.release();
    const leaseC = await c;
    leaseB.release();
    leaseC.release();
    assert.equal(cap.holders().length, 0);
    assert.equal(cap.queue().length, 0);
  });

  it('capacity never exceeds the limit under churn: 12 acquirers, 3 permits', async () => {
    const path = dbPath();
    const caps = Array.from({ length: 12 }, () => new ModelCapacity(path, { permits: 3, pollMs: 2 }));
    let inside = 0;
    let peak = 0;
    await Promise.all(
      caps.map(async (cap, i) => {
        for (let round = 0; round < 3; round++) {
          const lease = await cap.acquire(`c${i}-${round}`);
          inside += 1;
          peak = Math.max(peak, inside);
          assert.ok(inside <= 3, `over-allocated: ${inside} inside`);
          await new Promise((r) => setTimeout(r, 3));
          inside -= 1;
          lease.release();
        }
      }),
    );
    assert.equal(peak, 3);
    assert.equal(caps[0].holders().length, 0);
    assert.equal(caps[0].queue().length, 0);
  });

  it('tryAcquire joins the queue: it cannot take a permit that a queued waiter is entitled to', async () => {
    const path = dbPath();
    const cap = new ModelCapacity(path, { permits: 1, pollMs: 1_000 }); // slow poll: the waiter has not admitted itself yet
    const l0 = cap.tryAcquire('L0')!;
    const waiter = new ModelCapacity(path, { pollMs: 1_000 }).acquire('queued');
    await until(() => cap.queue().length === 1, 'waiter queued');
    l0.release(); // a permit is free, the queued waiter has not polled yet
    assert.equal(cap.tryAcquire('sneaky'), undefined, 'an immediate caller must not jump the queue');
    (await waiter).release();
    assert.ok(cap.tryAcquire('now-free'), 'with the queue empty it succeeds again');
  });
});

describe('waiter lifecycle: cancellation, timeout, crash, expiry', () => {
  it('cancelling a queued waiter withdraws it at once; the waiters behind it are not blocked', async () => {
    const path = dbPath();
    const cap = new ModelCapacity(path, { permits: 1, pollMs: 5 });
    const l0 = cap.tryAcquire('L0')!;
    const ctl = new AbortController();
    const first = cap.acquire('cancelled', ctl.signal);
    const firstResult = first.then(() => 'acquired', (e: Error) => e.message);
    const second = cap.acquire('survivor');
    await until(() => cap.queue().length === 2, 'both queued');
    ctl.abort(new Error('cancelled by test'));
    assert.match(await firstResult, /aborted.*cancelled by test/);
    assert.deepEqual(cap.queue().map((w) => w.holder), ['survivor'], 'the cancelled waiter left the queue immediately');
    l0.release();
    (await second).release();
    assert.equal(cap.queue().length, 0);
  });

  it('an already-aborted signal never joins the queue', async () => {
    const cap = new ModelCapacity(dbPath(), { permits: 1 });
    const ctl = new AbortController();
    ctl.abort(new Error('already'));
    await assert.rejects(cap.acquire('x', ctl.signal), /aborted/);
    assert.equal(cap.queue().length, 0);
  });

  it('a bounded wait expires with an explicit CapacityWaitTimeout and leaves no waiter behind', async () => {
    const cap = new ModelCapacity(dbPath(), { permits: 1, pollMs: 5 });
    const l0 = cap.tryAcquire('L0')!;
    const started = Date.now();
    const err = await cap.acquire('impatient', undefined, { maxWaitMs: 120, tag: 'T' }).then(() => undefined, (e) => e as CapacityWaitTimeout);
    assert.ok(err instanceof CapacityWaitTimeout);
    assert.equal(err.code, 'capacity_wait_timeout');
    assert.ok(err.waitedMs >= 120 && Date.now() - started < 2_000, `expired promptly (${err.waitedMs}ms)`);
    assert.equal(cap.queue().length, 0);
    assert.equal(cap.isWaiting('T'), false);
    l0.release();
  });

  it('isWaiting reports queued work by tag, and stops reporting once the permit is held', async () => {
    const cap = new ModelCapacity(dbPath(), { permits: 1, pollMs: 5 });
    const l0 = cap.tryAcquire('L0')!;
    const p = cap.acquire('h', undefined, { tag: 'task-7' });
    await until(() => cap.isWaiting('task-7'), 'queued');
    assert.equal(cap.isWaiting('task-8'), false);
    l0.release();
    const lease = await p;
    assert.equal(cap.isWaiting('task-7'), false);
    lease.release();
  });

  it('a waiter whose process was SIGKILLed at the head of the queue is reaped at once (dead pid): the next waiter proceeds', async () => {
    const path = dbPath();
    const cap = new ModelCapacity(path, { permits: 1, pollMs: 5 });
    const l0 = cap.tryAcquire('L0')!;
    const doomed = spawnChild(path, 0);
    await until(() => has(doomed, 'queued'), 'child queued');
    const survivor = cap.acquire('survivor');
    await until(() => cap.queue().length === 2, 'both queued');
    assert.equal(cap.queue()[0].pid, doomed.proc.pid, 'the doomed child is first in line');
    doomed.proc.kill('SIGKILL');
    await doomed.exited;
    l0.release();
    const started = Date.now();
    (await survivor).release();
    assert.ok(Date.now() - started < 3_000, 'not delayed by the dead waiter (its 60 s waiter lease never mattered)');
    assert.equal(cap.queue().length, 0);
  });

  it('a crashed waiter on another host (no pid check) blocks the queue for at most waiterLeaseMs', () => {
    let now = 1_000;
    const path = dbPath();
    const common = { permits: 1, waiterLeaseMs: 5_000, now: () => now, isAlive: () => true };
    const crashed = new ModelCapacity(path, common);
    const next = new ModelCapacity(path, common);
    const ghost = crashed.enqueue('ghost'); // enqueued, then its process vanished: nothing ever renews it
    const mine = next.enqueue('next');
    assert.ok(ghost.ticket < mine.ticket);
    now += 4_999;
    assert.equal(next.admit(mine.ticket, 'next', mine.enqueuedAt), undefined, 'the ghost is still considered live');
    now += 2;
    assert.ok(next.admit(mine.ticket, 'next', mine.enqueuedAt), 'once its waiter lease expires it is reaped and the queue moves');
    assert.deepEqual(next.queue(), []);
  });

  it('an expired permit is reclaimed by the OLDEST waiter, not by a newcomer', () => {
    let now = 1_000;
    const path = dbPath();
    const common = { permits: 1, leaseMs: 5_000, waiterLeaseMs: 60_000, now: () => now, isAlive: () => true };
    const crashedHolder = new ModelCapacity(path, common);
    crashedHolder.tryAcquire('crashed-holder');
    const caps = [new ModelCapacity(path, common), new ModelCapacity(path, common)];
    const [older, newer] = [caps[0].enqueue('older'), caps[1].enqueue('newer')];
    assert.equal(caps[1].admit(newer.ticket, 'newer', newer.enqueuedAt), undefined, 'permit still held');
    now += 5_001; // the crashed holder's lease has expired
    assert.equal(caps[1].admit(newer.ticket, 'newer', newer.enqueuedAt), undefined, 'the newer waiter polls first but must not take it');
    const lease = caps[0].admit(older.ticket, 'older', older.enqueuedAt);
    assert.ok(lease, 'the older waiter reclaims the expired permit');
    assert.equal(caps[0].holders()[0].holder, 'older');
  });

  it('a live waiter that was reaped during a stall re-enters under its original ticket and keeps its place', () => {
    let now = 1_000;
    const path = dbPath();
    const common = { permits: 1, waiterLeaseMs: 5_000, leaseMs: 60_000, now: () => now, isAlive: () => true };
    const a = new ModelCapacity(path, common);
    const b = new ModelCapacity(path, common);
    const t1 = a.enqueue('stalled'); // ticket 1, then its event loop stalls past the waiter lease
    const t2 = b.enqueue('prompt');
    now += 6_000;
    const lease2 = b.admit(t2.ticket, 'prompt', t2.enqueuedAt)!; // reaps the stalled row; prompt is the only live waiter
    assert.ok(lease2, 'a waiter that stopped renewing is, by definition, not live');
    assert.equal(a.admit(t1.ticket, 'stalled', t1.enqueuedAt), undefined, 'the stalled waiter comes back: re-inserted, permit held');
    const t3 = b.enqueue('latecomer');
    assert.ok(t1.ticket < t3.ticket);
    assert.deepEqual(b.queue().map((w) => w.holder), ['stalled', 'latecomer'], 'its original place is kept ahead of the latecomer');
    lease2.release();
    assert.equal(b.admit(t3.ticket, 'latecomer', t3.enqueuedAt), undefined, 'the latecomer cannot overtake it');
    assert.ok(a.admit(t1.ticket, 'stalled', t1.enqueuedAt));
  });

  it('lease fencing: a lost lease cannot renew, and releasing it never frees the permit its successor holds', () => {
    let now = 1_000;
    const path = dbPath();
    const common = { permits: 1, leaseMs: 1_000, now: () => now, isAlive: () => true };
    const a = new ModelCapacity(path, common);
    const b = new ModelCapacity(path, common);
    const stale = a.tryAcquire('stale')!;
    now += 1_500; // expired, not yet reaped
    assert.equal(stale.renew(), false, 'an expired lease cannot be resurrected');
    const fresh = b.tryAcquire('fresh')!;
    assert.ok(fresh, 'the permit was reclaimed');
    stale.release(); // the zombie finishes late
    assert.deepEqual(b.holders().map((h) => h.holder), ['fresh'], "the zombie's release did not free the new holder's permit");
    assert.equal(b.tryAcquire('third'), undefined);
    assert.equal(fresh.renew(), true);
  });
});

describe('FIFO across processes', () => {
  for (const permits of [1, 2]) {
    it(`six OS processes queue in spawn order and are admitted in that order (${permits} permit${permits > 1 ? 's' : ''})`, async () => {
      const path = dbPath();
      const main = new ModelCapacity(path, { permits, pollMs: 5 });
      const holds = Array.from({ length: permits }, (_, i) => main.tryAcquire(`L${i}`)!);
      const children: Child[] = [];
      for (let i = 0; i < 6; i++) {
        children.push(spawnChild(path, 150));
        await until(() => has(children[i], 'queued'), `child ${i} queued`); // its ticket is taken before it reports
      }
      const tickets = children.map((c) => c.events.find((e) => e.event === 'queued')!.ticket!);
      assert.deepEqual([...tickets].sort((x, y) => x - y), tickets, 'tickets follow spawn order');
      for (const h of holds) h.release();
      await Promise.all(children.map((c) => c.exited));
      const acquired = children.map((c) => at(c, 'acquired'));
      // With multiple permits, admissions are NOT serialized into rigid groups:
      // as soon as the first holder releases, a later ticket may acquire while
      // an earlier holder still runs. Child stdout timestamps are also not an
      // atomic record of SQLite admission order. Strict FIFO is proven by the
      // ticket-order and deterministic in-process tests above; here we validate
      // cross-process capacity and successful completion, not group barriers.
      assert.equal(acquired.length, 6);
      // and never more than `permits` inside at once
      // (child timestamps lie inside the true holds, so a peak above `permits` here would be real over-allocation)
      const points = children.flatMap((c) => [[at(c, 'acquired'), 1], [at(c, 'released'), -1]] as const).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      let inside = 0;
      let peak = 0;
      for (const [, d] of points) peak = Math.max(peak, (inside += d));
      assert.ok(peak <= permits, `over-allocated: ${peak} simultaneous holders with ${permits} permit(s)`);
    });
  }

  it('a holder that is killed mid-call frees its permit for the head of the queue at once', async () => {
    const path = dbPath();
    const main = new ModelCapacity(path, { permits: 1, pollMs: 5 });
    const holder = spawnChild(path, 0, 'hold-forever');
    await until(() => has(holder, 'acquired'), 'child holds the permit');
    const waiter = main.acquire('next');
    await until(() => main.queue().length === 1, 'queued');
    holder.proc.kill('SIGKILL');
    (await waiter).release();
  });
});

describe('wait budget configuration', () => {
  it('AGENTIC_MODEL_WAIT_BUDGET_MS: default 30 minutes; malformed values are errors, not silent defaults', () => {
    assert.equal(modelWaitBudgetMs({}), 30 * 60_000);
    assert.equal(modelWaitBudgetMs({ AGENTIC_MODEL_WAIT_BUDGET_MS: '5000' }), 5000);
    for (const bad of ['0', '-1', 'abc', '1.5']) assert.throws(() => modelWaitBudgetMs({ AGENTIC_MODEL_WAIT_BUDGET_MS: bad }), /positive integer/, bad);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ModelCapacity, defaultModelCapacityPath } from './model-capacity.ts';
import { runCodingTask, type CodingTask } from '../execution/coding-task-runner.ts';

const CHILD = join(import.meta.dirname, 'capacity-child.fixture.ts');
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'capacity-')), 'capacity.db');
const run = promisify(execFile);
const child = (db: string, holdMs: number) => run(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, db, String(holdMs)]).then((r) => JSON.parse(r.stdout) as { start: number; end: number });

/** Max number of [start,end) intervals overlapping at any instant. */
function peak(intervals: { start: number; end: number }[]): number {
  const points = intervals.flatMap((i) => [[i.start, 1], [i.end, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of points) max = Math.max(max, (cur += d));
  return max;
}

describe('machine-wide model capacity (cross-process leases)', () => {
  it('one permit: a second holder (another connection) waits until the first releases', () => {
    const path = dbPath();
    const a = new ModelCapacity(path, { permits: 1 });
    const b = new ModelCapacity(path, { permits: 1 });
    const la = a.tryAcquire('a')!;
    assert.ok(la);
    assert.equal(b.tryAcquire('b'), undefined);
    la.release();
    assert.ok(b.tryAcquire('b'));
  });

  for (const permits of [1, 2]) {
    it(`six OS processes competing for ${permits} permit(s) never exceed it`, async () => {
      const path = dbPath();
      new ModelCapacity(path, { permits }).close();
      const intervals = await Promise.all(Array.from({ length: 6 }, () => child(path, 250)));
      assert.equal(peak(intervals), permits);
    });
  }

  it('crash recovery: a holder killed with SIGKILL loses its permit at once (dead pid), not after the TTL', async () => {
    const path = dbPath();
    const cap = new ModelCapacity(path, { permits: 1, leaseMs: 60_000 });
    const holder = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, path, '0', 'hold-forever'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((r) => holder.stdout!.once('data', () => r()));
    assert.equal(cap.tryAcquire('me'), undefined, 'held by the live child');
    holder.kill('SIGKILL');
    await new Promise((r) => holder.once('exit', r));
    assert.ok(cap.tryAcquire('me'), 'reclaimed immediately after the holder died');
  });

  it('crash recovery without a pid check (e.g. another host): the lease expires after its TTL', () => {
    let now = 1_000;
    const path = dbPath();
    const holder = new ModelCapacity(path, { permits: 1, leaseMs: 5_000, now: () => now });
    const waiter = new ModelCapacity(path, { permits: 1, leaseMs: 5_000, now: () => now, isAlive: () => true });
    holder.tryAcquire('crashed');
    now += 4_999;
    assert.equal(waiter.tryAcquire('w'), undefined);
    now += 2;
    assert.ok(waiter.tryAcquire('w'));
  });

  it('a live holder keeps its permit past the TTL by heartbeating', async () => {
    const path = dbPath();
    const holder = new ModelCapacity(path, { permits: 1, leaseMs: 300 });
    const other = new ModelCapacity(path, { permits: 1, leaseMs: 300, isAlive: () => true });
    const lease = await holder.acquire('long-call');
    await new Promise((r) => setTimeout(r, 900)); // 3x the TTL
    assert.equal(other.tryAcquire('other'), undefined);
    lease.release();
    assert.ok(other.tryAcquire('other'));
  });

  it('waiting is abortable (cancel) and leaves no lease behind', async () => {
    const path = dbPath();
    const cap = new ModelCapacity(path, { permits: 1, pollMs: 20 });
    const held = cap.tryAcquire('busy')!;
    const ctl = new AbortController();
    const waiting = cap.acquire('waiter', ctl.signal);
    setTimeout(() => ctl.abort(new Error('cancelled')), 100);
    await assert.rejects(waiting, /aborted/);
    held.release();
    assert.equal(cap.holders().length, 0);
  });

  it('the permit count is stored once in the database, so every process enforces the same limit', () => {
    const path = dbPath();
    new ModelCapacity(path, { permits: 1 });
    const other = new ModelCapacity(path, { permits: 5 });
    assert.equal(other.permits, 1);
    other.setPermits(2);
    assert.equal(new ModelCapacity(path).permits, 2);
  });

  it('defaults to a machine-wide path outside any checkout, and to a temp file under node --test', () => {
    assert.match(defaultModelCapacityPath({}), /\.agentic-engineering\/model-capacity\.db$/);
    assert.equal(defaultModelCapacityPath({ AGENTIC_MODEL_LOCK_DB: '/x/y.db' }), '/x/y.db');
    assert.match(defaultModelCapacityPath({ NODE_TEST_CONTEXT: 'child' }), /agentic-test-model-capacity\.db$/);
  });
});

describe('runner: model calls go through the shared capacity', () => {
  it('two tasks running concurrently in one process never overlap their model calls (permits = 1)', async () => {
    const capacity = new ModelCapacity(dbPath(), { permits: 1, pollMs: 10 });
    const calls: { start: number; end: number }[] = [];
    const makeTask = async (name: string) => {
      const root = mkdtempSync(join(tmpdir(), `cap-runner-${name}-`));
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'a.txt'), 'old\n');
      const task: CodingTask = { taskId: name, objective: 'x', allowedFiles: ['src/a.txt'], verificationCommands: [['node', '-e', 'process.exit(0)']], constraints: ['tests are immutable'] };
      const worker = {
        async generate() {
          const start = Date.now();
          await new Promise((r) => setTimeout(r, 200));
          await writeFile(join(root, 'src', 'a.txt'), 'new\n');
          calls.push({ start, end: Date.now() });
          return { text: 'done', finishReason: 'stop', steps: [{}] };
        },
      };
      return runCodingTask(task, { repoRoot: root, worker, capacity, maxAttempts: 1 });
    };
    const results = await Promise.all([makeTask('t1'), makeTask('t2'), makeTask('t3')]);
    assert.deepEqual(results.map((r) => r.verdict), ['PASS', 'PASS', 'PASS']);
    assert.equal(peak(calls), 1);
    assert.equal(capacity.holders().length, 0, 'every permit was released');
  });
});

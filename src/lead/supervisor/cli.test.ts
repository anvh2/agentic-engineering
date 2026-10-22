import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { runSupervisorCommand, type SupervisorContext } from './cli.ts';
import { LifecycleStore } from '../lifecycle/store.ts';
import { makeRepo, plan, workerTask } from '../../runtime/scheduler/test-helpers.ts';

const harness = async (fn: (ctx: SupervisorContext, output: string[], errors: string[]) => Promise<void>) => {
  const workdir = await mkdtemp(join(tmpdir(), 'm11-supervisor-'));
  const store = new SchedulerStore(':memory:');
  const out: string[] = [], err: string[] = [];
  try { await fn({ store, workdir, out: (message) => out.push(message), err: (message) => err.push(message), runLifecycle: async () => { throw new Error('unexpected execution'); } }, out, err); }
  finally { store.close(); await rm(workdir, { recursive: true, force: true }); }
};

test('operator commands refuse to claim completion when there is no holder', async () => {
  await harness(async (ctx, out) => {
    assert.equal(await runSupervisorCommand(['status'], ctx), 0);
    assert.match(out[0], /"STOPPED"/);
    assert.equal(await runSupervisorCommand(['pause'], ctx), 1);
    assert.equal(await runSupervisorCommand(['stop'], ctx), 1);
    assert.equal(await runSupervisorCommand(['resume'], ctx), 0);
  });
});

test('start requires an existing batch with pinned independent acceptance oracle', async () => {
  await harness(async (ctx, out) => {
    assert.equal(await runSupervisorCommand(['start', '--batch', 'missing', '--once'], ctx), 2);
    assert.equal(await runSupervisorCommand(['start', '--batch', '../bad'], ctx), 2);
    assert.equal(await runSupervisorCommand(['start', '--batch', 'missing', '--poll-ms', '0'], ctx), 2);
  });
});

test('cross-process pause/stop are durable requests; corrupt holders block automatic start', async () => {
  await harness(async (ctx, out) => {
    const folder = join(ctx.workdir, 'supervisor', 'holder');
    await mkdir(folder, { recursive: true });
    assert.equal(await runSupervisorCommand(['status'], ctx), 0);
    assert.match(out.at(-1)!, /CORRUPT_OR_ORPHANED/);
    assert.equal(await runSupervisorCommand(['pause'], ctx), 0);
    assert.match(await readFile(join(ctx.workdir, 'supervisor', 'pause-requested'), 'utf8'), /\d{4}-/);
    assert.equal(await runSupervisorCommand(['stop'], ctx), 0);
    assert.equal(await runSupervisorCommand(['resume'], ctx), 1);
    assert.equal(await runSupervisorCommand(['start', '--batch', 'missing'], ctx), 2);
  });
});

test('existing holder with mismatched ownership remains locked, never silently replaced', async () => {
  await harness(async (ctx, out) => {
    const folder = join(ctx.workdir, 'supervisor', 'holder');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'owner.json'), JSON.stringify({ token: 'foreign', pid: 123, batch: 'foo' }));
    assert.equal(await runSupervisorCommand(['status'], ctx), 0);
    assert.match(out.at(-1)!, /"HELD"|"RUNNING_OR_ORPHANED"/);
    assert.equal(await runSupervisorCommand(['resume'], ctx), 1);
  });
});

test('operator can clear stop intent only after holder gate has been removed', async () => {
  await harness(async (ctx, out) => {
    const folder = join(ctx.workdir, 'supervisor');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'stop-requested'), 'stopped');
    assert.equal(await runSupervisorCommand(['resume'], ctx), 0);
    await assert.rejects(readFile(join(folder, 'stop-requested'), 'utf8'), /ENOENT/);
  });
});

// ---- M12 queue mode ------------------------------------------------------------------------------------------------

const queueHarness = async (fn: (h: { ctx: SupervisorContext; out: string[]; err: string[]; lifecycle: LifecycleStore; ran: string[]; pin: (id: string) => void; outcome: Map<string, 'ACCEPTED' | 'ESCALATED'> }) => Promise<void>) => {
  const workdir = await mkdtemp(join(tmpdir(), 'm12-queue-'));
  let clock = 1_000;
  const store = new SchedulerStore(':memory:', { now: () => clock++ });
  const lifecycle = new LifecycleStore(store);
  const repo = makeRepo();
  const out: string[] = [], err: string[] = [], ran: string[] = [];
  const outcome = new Map<string, 'ACCEPTED' | 'ESCALATED'>();
  const pin = (id: string) => {
    store.createBatch(plan(repo, [workerTask(`${id}.t1`)], { batchId: id }));
    lifecycle.create({ objectiveId: id, batchId: id, baseCommit: 'base', actor: 'lead', oracle: { dir: '/oracle', files: {}, commands: [['true']], negativeControl: { mode: 'required' }, specHash: `spec-${id}`, pinnedAt: clock, pinnedBy: 'lead' } });
  };
  // Stands in for the lifecycle driver: walks the objective to its outcome exactly as the real driver's phases allow.
  const runLifecycle = async (id: string) => {
    ran.push(id);
    lifecycle.transition(id, 'EXECUTING', { actor: 'driver', expectFrom: 'PINNED' });
    if ((outcome.get(id) ?? 'ACCEPTED') === 'ESCALATED') {
      lifecycle.transition(id, 'ESCALATED', { actor: 'driver', reason: 'task_dead_end' });
      return 3;
    }
    lifecycle.transition(id, 'ACCEPTING', { actor: 'driver' });
    lifecycle.transition(id, 'ACCEPTED', { actor: 'driver' });
    return 0;
  };
  // Once nothing pinned is left the harness asks the supervisor to stop, so a queue that fails to stop on its own ends the
  // test with a wrong result instead of idling forever.
  const stopWhenDrained = async (id: string) => {
    try { return await runLifecycle(id); }
    finally { if (lifecycle.listByPhase('PINNED').length === 0) await writeFile(join(workdir, 'supervisor', 'stop-requested'), 'drained'); }
  };
  try { await fn({ ctx: { store, workdir, out: (m) => out.push(m), err: (m) => err.push(m), runLifecycle: stopWhenDrained }, out, err, lifecycle, ran, pin, outcome }); }
  finally { store.close(); await rm(workdir, { recursive: true, force: true }); }
};

test('queue: runs pinned objectives oldest first, one at a time, until a stop request', { timeout: 20_000 }, async () => {
  await queueHarness(async ({ ctx, ran, pin, lifecycle, out }) => {
    pin('obj-b-first');
    pin('obj-a-second');
    assert.equal(await runSupervisorCommand(['start', '--queue', '--poll-ms', '100'], ctx), 0);
    assert.deepEqual(ran, ['obj-b-first', 'obj-a-second'], 'pin order, not name order');
    assert.equal(lifecycle.require('obj-a-second').phase, 'ACCEPTED');
    assert.match(out.at(-1)!, /"objectivesRun":2/);
  });
});

test('queue: stops fail-closed at the first objective that is not ACCEPTED; the next one waits for a human', { timeout: 20_000 }, async () => {
  await queueHarness(async ({ ctx, ran, pin, outcome, lifecycle }) => {
    pin('first');
    pin('second');
    outcome.set('first', 'ESCALATED');
    assert.equal(await runSupervisorCommand(['start', '--queue', '--poll-ms', '100'], ctx), 1);
    assert.deepEqual(ran, ['first']);
    assert.equal(lifecycle.require('second').phase, 'PINNED');
  });
});

test('queue: takes only PINNED objectives, never one already started (EXECUTING after a crash) or escalated', { timeout: 20_000 }, async () => {
  await queueHarness(async ({ ctx, ran, pin, lifecycle }) => {
    pin('crashed');
    lifecycle.transition('crashed', 'EXECUTING', { actor: 'driver' });
    pin('escalated');
    lifecycle.transition('escalated', 'EXECUTING', { actor: 'driver' });
    lifecycle.transition('escalated', 'ESCALATED', { actor: 'driver', reason: 'x' });
    pin('ready');
    assert.equal(await runSupervisorCommand(['start', '--queue', '--once'], ctx), 0);
    assert.deepEqual(ran, ['ready']);
    assert.equal(lifecycle.require('crashed').phase, 'EXECUTING');
  });
});

test('queue: --once with nothing pinned runs nothing and releases the gate', { timeout: 20_000 }, async () => {
  await queueHarness(async ({ ctx, ran, out }) => {
    assert.equal(await runSupervisorCommand(['start', '--queue', '--once'], ctx), 0);
    assert.deepEqual(ran, []);
    assert.match(out.at(-1)!, /"idle":true/);
    await assert.rejects(readFile(join(ctx.workdir, 'supervisor', 'holder', 'owner.json'), 'utf8'), /ENOENT/);
    assert.equal(await runSupervisorCommand(['start', '--queue', '--once'], ctx), 0, 'a released gate can be taken again');
  });
});

test('queue: --batch and --queue are mutually exclusive', { timeout: 20_000 }, async () => {
  await queueHarness(async ({ ctx, pin, ran }) => {
    pin('x');
    assert.equal(await runSupervisorCommand(['start', '--queue', '--batch', 'x', '--once'], ctx), 2);
    assert.equal(await runSupervisorCommand(['start', '--once'], ctx), 2);
    assert.deepEqual(ran, []);
  });
});

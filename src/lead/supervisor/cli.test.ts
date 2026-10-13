import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { runSupervisorCommand } from './cli.ts';

const harness = async (fn: (ctx: { store: SchedulerStore; workdir: string; out: string[]; err: string[]; runLifecycle: (id: string) => Promise<number> }) => Promise<void>) => {
  const workdir = await mkdtemp(join(tmpdir(), 'm11-supervisor-'));
  const store = new SchedulerStore(':memory:');
  const out: string[] = [], err: string[] = [];
  try { await fn({ store, workdir, out, err, runLifecycle: async () => { throw new Error('unexpected execution'); } }); }
  finally { store.close(); await rm(workdir, { recursive: true, force: true }); }
};

test('operator commands refuse to claim completion when there is no holder', async () => {
  await harness(async (ctx) => {
    assert.equal(await runSupervisorCommand(['status'], ctx), 0);
    assert.match(ctx.out[0], /"STOPPED"/);
    assert.equal(await runSupervisorCommand(['pause'], ctx), 1);
    assert.equal(await runSupervisorCommand(['stop'], ctx), 1);
    assert.equal(await runSupervisorCommand(['resume'], ctx), 1);
  });
});

test('start requires an existing batch with pinned independent acceptance oracle', async () => {
  await harness(async (ctx) => {
    assert.equal(await runSupervisorCommand(['start', '--batch', 'missing', '--once'], ctx), 2);
    assert.equal(await runSupervisorCommand(['start', '--batch', '../bad'], ctx), 2);
    assert.equal(await runSupervisorCommand(['start', '--batch', 'missing', '--poll-ms', '0'], ctx), 2);
  });
});

test('cross-process pause/stop are durable requests; corrupt holders block automatic start', async () => {
  await harness(async (ctx) => {
    const folder = join(ctx.workdir, 'supervisor', 'holder');
    await mkdir(folder, { recursive: true });
    assert.equal(await runSupervisorCommand(['status'], ctx), 0);
    assert.match(ctx.out.at(-1)!, /CORRUPT_OR_ORPHANED/);
    assert.equal(await runSupervisorCommand(['pause'], ctx), 0);
    assert.match(await readFile(join(ctx.workdir, 'supervisor', 'pause-requested'), 'utf8'), /\d{4}-/);
    assert.equal(await runSupervisorCommand(['stop'], ctx), 0);
    assert.equal(await runSupervisorCommand(['resume'], ctx), 1);
    assert.equal(await runSupervisorCommand(['start', '--batch', 'missing'], ctx), 2);
  });
});

test('existing holder with mismatched ownership remains locked, never silently replaced', async () => {
  await harness(async (ctx) => {
    const folder = join(ctx.workdir, 'supervisor', 'holder');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'owner.json'), JSON.stringify({ token: 'foreign', pid: 123, batch: 'foo' }));
    assert.equal(await runSupervisorCommand(['status'], ctx), 0);
    assert.match(ctx.out.at(-1)!, /"HELD"|"RUNNING_OR_ORPHANED"/);
    assert.equal(await runSupervisorCommand(['resume'], ctx), 1);
  });
});

test('operator can clear stop intent only after holder gate has been removed', async () => {
  await harness(async (ctx) => {
    const folder = join(ctx.workdir, 'supervisor');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'stop-requested'), 'stopped');
    assert.equal(await runSupervisorCommand(['resume'], ctx), 0);
    await assert.rejects(readFile(join(folder, 'stop-requested'), 'utf8'), /ENOENT/);
  });
});

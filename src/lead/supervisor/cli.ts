/**
 * M11 supervisor: a foreground control loop over the existing lifecycle driver.
 * No additional scheduler or job database. LifecycleStore is the sole authority.
 * Commands from other terminals write cooperative intent, never signal a PID.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { LifecycleStore } from '../lifecycle/store.ts';

export interface SupervisorContext {
  store: SchedulerStore;
  workdir: string;
  out: (message: string) => void;
  err: (message: string) => void;
  /** Executes the EXISTING lead lifecycle driver, not an alternate task engine. */
  runLifecycle: (objectiveId: string) => Promise<number>;
}
export const SUPERVISOR_USAGE = 'lead supervisor start (--batch <id> | --queue) [--once] [--poll-ms <100..60000>] | status | pause | resume | stop';
const pauseName = 'pause-requested';
const stopName = 'stop-requested';
const intervalMs = 20_000;
const lockTtlMs = 90_000;

const flag = (a: string[], key: string) => {
  const i = a.indexOf(key);
  return i < 0 ? undefined : a[i + 1];
};
const holderDir = (wd: string) => join(wd, 'supervisor', 'holder');
const dir = (wd: string) => join(wd, 'supervisor');
const intent = (wd: string, name: string) => join(dir(wd), name);
const exists = async (path: string) => stat(path).then(() => true, (e: NodeJS.ErrnoException) => {
  if (e.code === 'ENOENT') return false;
  throw e;
});
const readHolder = async (wd: string) => {
  const body = await readFile(join(holderDir(wd), 'owner.json'), 'utf8');
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { token?: unknown }).token !== 'string')
    throw new Error('invalid supervisor owner; manual reconciliation required');
  return parsed as { token: string; pid: number; batch: string };
};
const writeIntent = async (wd: string, name: string) => {
  await mkdir(dir(wd), { recursive: true, mode: 0o700 });
  await writeFile(intent(wd, name), new Date().toISOString() + '\n', { mode: 0o600 });
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Never claim an objective is accepted from a CLI exit code alone. */
const states = new Set(['PINNED', 'EXECUTING']);
export async function runSupervisorCommand(args: string[], ctx: SupervisorContext): Promise<number> {
  const [cmd] = args;
  if (!cmd || !['start','status','pause','resume','stop'].includes(cmd)) {
    ctx.err(SUPERVISOR_USAGE);
    return 2;
  }
  if (cmd === 'status') {
    const locked = await exists(holderDir(ctx.workdir));
    let owner: unknown = null;
    if (locked) {
      try { owner = await readHolder(ctx.workdir); } catch { owner = 'CORRUPT_OR_ORPHANED'; }
    }
    const result = { state: !locked ? 'STOPPED' : (await exists(intent(ctx.workdir, stopName))) ? 'STOP_REQUESTED' :
      (await exists(intent(ctx.workdir, pauseName))) ? 'PAUSE_REQUESTED' : 'RUNNING_OR_ORPHANED',
      locked, owner, note: locked ? 'PID is diagnostic only, never proof of ownership. Reconcile on crash.' : undefined };
    ctx.out(JSON.stringify(result, null, 2));
    return 0;
  }
  if (cmd === 'pause' || cmd === 'stop') {
    if (!(await exists(holderDir(ctx.workdir)))) {
      ctx.err('No active holder. Check status; orphan lock must be reconciled manually.');
      return 1;
    }
    await writeIntent(ctx.workdir, cmd === 'pause' ? pauseName : stopName);
    ctx.out(cmd + ' requested; current lifecycle must settle before new objectives are blocked. No run was cancelled.');
    return 0;
  }
  if (cmd === 'resume') {
    if (!(await exists(holderDir(ctx.workdir)))) {
      // No live gate remains: remove only control intents and require an explicit NEW start.
      await unlink(intent(ctx.workdir, stopName)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
      await unlink(intent(ctx.workdir, pauseName)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
      ctx.out('No holder; control intents cleared. Use start explicitly after checking the lifecycle.');
      return 0;
    }
    if (await exists(intent(ctx.workdir, stopName))) {
      ctx.err('Stop was requested while holder is still present. Wait for completion or reconcile; no takeover.');
      return 1;
    }
    if (!(await exists(intent(ctx.workdir, pauseName)))) {
      ctx.err('No pause request found');
      return 1;
    }
    await unlink(intent(ctx.workdir, pauseName));
    ctx.out('Resume requested; verify owner is still alive via process table and log.');
    return 0;
  }

  const batch = flag(args, '--batch');
  // M12 queue mode: take submitted objectives whose oracle the Lead already pinned (phase PINNED), oldest pin first, one at a
  // time through the same lifecycle driver. It starts nothing that is not pinned, resumes nothing that already started
  // (EXECUTING after a crash is for a human to reconcile), and stops at the first objective that does not end ACCEPTED.
  const queue = args.includes('--queue');
  const pollInput = flag(args, '--poll-ms');
  const poll = pollInput === undefined ? 2000 : Number(pollInput);
  if (Number(Boolean(batch)) + Number(queue) !== 1 || (batch !== undefined && !/^[A-Za-z0-9._-]+$/.test(batch)) ||
      !Number.isInteger(poll) || poll < 100 || poll > 60_000) {
    ctx.err('start requires exactly one of --batch <id> or --queue; --poll-ms must be 100..60000');
    return 2;
  }
  const lifecycle = new LifecycleStore(ctx.store);
  // Verify batch exists and pre-pinned oracle BEFORE grabbing leadership.
  const pinned = batch ? lifecycle.getByBatch(batch) : undefined;
  if (batch && (!ctx.store.getBatch(batch) || !pinned || pinned.batchId !== batch)) {
    ctx.err('Batch must exist and have an independently pinned lifecycle oracle');
    return 2;
  }

  await mkdir(dir(ctx.workdir), { recursive: true, mode: 0o700 });
  try { await mkdir(holderDir(ctx.workdir)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      ctx.err('Supervisor gate held or orphaned: no automatic takeover');
      return 1;
    }
    throw e;
  }
  const token = 'supervisor:' + process.pid + ':' + randomUUID();
  const lockName = queue ? 'supervisor:queue' : 'supervisor:' + batch;
  let locked = false;
  let lost = false;
  // Per-objective dispatch claims. The leadership lock above is per batch (or `queue`), so supervisors in different workdirs
  // sharing one scheduler DB hold different leadership locks; this DB lock is what makes one objective run under one supervisor.
  const claims = new Set<string>();
  let beat: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let stopping = false;
  // Set only on the verified normal-completion path. Every other exit (a throw from the driver, a lost lock, a failed read)
  // retains the holder gate, the leadership lock and any objective claim for a human to reconcile.
  let clean = false;
  const onSignal = () => { stopping = true; };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    await writeFile(join(holderDir(ctx.workdir), 'owner.json'), JSON.stringify({ token, pid: process.pid, batch: batch ?? null, mode: queue ? 'queue' : 'batch' }), { flag: 'wx', mode: 0o600 });
    if (!ctx.store.acquireLock(lockName, token, lockTtlMs)) throw new Error('DB leadership lock held');
    locked = true;
    beat = setInterval(() => {
      try { for (const name of [lockName, ...claims]) if (!ctx.store.renewLock(name, token, lockTtlMs)) lost = true; }
      catch { lost = true; }
    }, intervalMs);
    beat.unref();
    const assertOwner = async () => {
      try {
        const owner = await readHolder(ctx.workdir);
        if (lost || owner.token !== token || ![lockName, ...claims].every((name) => ctx.store.ownsLock(name, token)))
          throw new Error('supervisor ownership lost; fail closed, retaining gate');
      } catch (e) {
        lost = true; // any lost lock or unreadable gate invalidates ownership for good, so cleanup never touches the gate
        throw e;
      }
    };
    const claim = (objectiveId: string) => {
      const name = 'supervisor:objective:' + objectiveId;
      if (!ctx.store.acquireLock(name, token, lockTtlMs)) return false;
      claims.add(name);
      return true;
    };
    const unclaim = (objectiveId: string) => {
      const name = 'supervisor:objective:' + objectiveId;
      claims.delete(name);
      ctx.store.releaseLock(name, token);
    };
    let rounds = 0;
    let resultCode = 0;
    let objectivesRun = 0;
    while (queue && !stopping) {
      await assertOwner();
      if (await exists(intent(ctx.workdir, stopName))) break;
      if (await exists(intent(ctx.workdir, pauseName))) { await sleep(poll); continue; }
      // First pinned objective no other supervisor has claimed; one a batch supervisor holds is not this queue's to start.
      // The listing is a snapshot: re-read the phase once the claim is held, since another supervisor may have started it since.
      const next = lifecycle.listByPhase('PINNED').find((row) => {
        if (!claim(row.objectiveId)) return false;
        if (lifecycle.get(row.objectiveId)?.phase === 'PINNED') return true;
        unclaim(row.objectiveId);
        return false;
      });
      if (!next) {
        if (args.includes('--once')) { ctx.out(JSON.stringify({ mode: 'queue', idle: true, objectivesRun })); break; }
        await sleep(poll);
        continue;
      }
      ctx.out(JSON.stringify({ mode: 'queue', starting: next.objectiveId, batch: next.batchId }));
      running = true;
      const exit = await ctx.runLifecycle(next.objectiveId);
      running = false;
      await assertOwner();
      const verified = lifecycle.require(next.objectiveId);
      objectivesRun++;
      ctx.out(JSON.stringify({ mode: 'queue', batch: verified.batchId, objectiveId: verified.objectiveId, phase: verified.phase, exit, objectivesRun }));
      unclaim(next.objectiveId);
      // Fail closed: an objective that needs a human (escalated, awaiting the operator, not accepted) stops the queue.
      if (exit !== 0 || verified.phase !== 'ACCEPTED') { resultCode = 1; break; }
      if (args.includes('--once')) break;
    }
    while (!queue && !stopping) {
      await assertOwner();
      if (await exists(intent(ctx.workdir, stopName))) break;
      if (await exists(intent(ctx.workdir, pauseName))) { await sleep(poll); continue; }
      const current = lifecycle.getByBatch(batch!);
      if (!current || current.objectiveId !== pinned!.objectiveId) throw new Error('lifecycle identity changed');
      if (!states.has(current.phase)) break;
      if (!claim(current.objectiveId)) throw new Error('objective ' + current.objectiveId + ' is claimed by another supervisor');
      if (!states.has(lifecycle.require(current.objectiveId).phase)) { unclaim(current.objectiveId); break; } // moved on since the read above
      running = true;
      const exit = await ctx.runLifecycle(current.objectiveId);
      running = false;
      await assertOwner();
      const verified = lifecycle.require(current.objectiveId);
      rounds++;
      ctx.out(JSON.stringify({ batch, objectiveId: current.objectiveId, phase: verified.phase, exit, rounds }));
      unclaim(current.objectiveId);
      if (exit !== 0 || verified.phase !== 'ACCEPTED') { resultCode = 1; break; }
      if (args.includes('--once')) break;
      // One pinned objective per batch; no alternate backlog iteration.
      break;
    }
    await assertOwner();
    clean = true;
    return resultCode;
  } catch (e) {
    ctx.err('supervisor failed CLOSED: ' + (e as Error).message);
    // A failed/unknown child, lock loss, or failed startup must not result in an unsafe automatic takeover.
    return 1;
  } finally {
    if (beat) clearInterval(beat);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    if (clean && locked && !lost) {
      try {
        if (ctx.store.ownsLock(lockName, token) && (await readHolder(ctx.workdir)).token === token) {
          ctx.store.releaseLock(lockName, token);
          await unlink(join(holderDir(ctx.workdir), 'owner.json'));
          await rmdir(holderDir(ctx.workdir));
        }
      } catch (e) { ctx.err('gate retained for manual reconciliation: ' + (e as Error).message); }
    }
  }
}

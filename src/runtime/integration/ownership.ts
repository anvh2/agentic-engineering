import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SchedulerStore } from '../scheduler/store.ts';
import type { WorktreeManager } from '../worktree/worktree.ts';

/**
 * A lease is not a mutex for asynchronous Git: an already-spawned process can outlive it.
 * The repository-common directory gate has NO expiry and is never stolen, even after a
 * crash. Hold it until every awaited command settles. A crashed holder requires operator
 * reconciliation (including its child processes); PID checks/TTL cannot prove quiescence.
 * Unique durable owner tokens fence DB renewal/release. All cooperating integrators,
 * including those using different scheduler databases, must acquire this gate first.
 */
export async function integrationOwnership(store: SchedulerStore, worktrees: WorktreeManager, repository: string, actor: string, ttlMs: number) {
  if (!Number.isFinite(ttlMs) || ttlMs < 3) throw new Error('integration lock TTL must be at least 3ms');
  const common = await worktrees.git(repository, ['rev-parse', '--git-common-dir']);
  if (!common.success) throw new Error('cannot establish integration repository identity');
  const gate = join(await realpath(resolve(repository, common.stdout.trim())), 'agentic-integration-guard');
  try { await mkdir(gate); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  const owner = `${actor}:${process.pid}:${randomUUID()}`;
  const name = `integrate:${repository}`;
  // Failure writing evidence leaves the gate closed for operator reconciliation.
  await writeFile(join(gate, 'owner'), owner, { flag: 'wx' });
  let timer: ReturnType<typeof setInterval> | undefined;
  let lost = false;
  const releaseGate = async () => {
    if (await readFile(join(gate, 'owner'), 'utf8') !== owner) throw new Error('integration gate ownership lost');
    await unlink(join(gate, 'owner'));
    await rmdir(gate);
  };
  try {
    if (!store.acquireLock(name, owner, ttlMs)) { await releaseGate(); return null; }
    timer = setInterval(() => {
      try { if (!store.renewLock(name, owner, ttlMs)) lost = true; } catch { lost = true; }
    }, Math.max(1, Math.floor(ttlMs / 3)));
    timer.unref();
  } catch (error) { await releaseGate(); throw error; }
  return {
    owner,
    assert() {
      if (lost || !store.ownsLock(name, owner)) {
        lost = true;
        throw new Error('integration ownership lost; refusing further writes or completion');
      }
    },
    async release() {
      clearInterval(timer);
      // Conditional deletion cannot release a successor generation. Release the gate last.
      try { store.releaseLock(name, owner); } finally { await releaseGate(); }
    },
  };
}

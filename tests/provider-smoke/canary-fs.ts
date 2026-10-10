import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Ownership-safe temporary directories for the isolation canaries.
 *
 * The canaries plant SYNTHETIC credentials (random markers this code wrote) in directories under the real home. Nothing here ever
 * copies a real credential. These helpers make sure such a directory (a) is only ever removed by the process that created it (or by a
 * later sweep, once that process is dead), (b) is never removed through a symlink, (c) is removed even when the Codex CLI's background
 * writers are still running inside it (their process group is killed first and the removal retries), and (d) is removed on exit and on
 * SIGINT / SIGTERM as well as in `finally`.
 */

const MARKER = '.agentic-canary-owner.json';
const OWNED = new Map<string, string>(); // path -> nonce, this process only
let hooked = false;

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function hook() {
  if (hooked) return;
  hooked = true;
  const sweepOwn = () => {
    for (const path of [...OWNED.keys()]) removeOwnedSync(path);
  };
  process.on('exit', sweepOwn);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      sweepOwn();
      process.kill(process.pid, sig);
    });
  }
}

/** Creates `<parent>/<prefix><random>` with an owner marker. Fails if it exists. Returns the real path. */
export function createOwnedDir(parent: string, prefix: string): string {
  hook();
  const nonce = randomBytes(8).toString('hex');
  const path = join(realpathSync(parent), `${prefix}${randomBytes(4).toString('hex')}`);
  mkdirSync(path); // not recursive: an existing path is an error, never adopted
  writeFileSync(join(path, MARKER), JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() }));
  OWNED.set(path, nonce);
  return path;
}

const readMarker = (path: string): { pid: number; nonce: string } | undefined => {
  try {
    const m = JSON.parse(readFileSync(join(path, MARKER), 'utf8')) as { pid?: unknown; nonce?: unknown };
    return typeof m.pid === 'number' && typeof m.nonce === 'string' ? { pid: m.pid, nonce: m.nonce } : undefined;
  } catch {
    return undefined;
  }
};

const isRealDir = (path: string) => {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};

/** Removal with retries: a process that is still writing into the tree makes a single `rm -r` fail with ENOTEMPTY. */
function removeTreeSync(path: string): boolean {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* retry */
    }
    if (!existsSync(path)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return !existsSync(path);
}

/** Removes a directory this process created. Refuses a symlink, a path that was not created here and a directory whose marker was replaced. */
export function removeOwnedSync(path: string): { removed: boolean; refused?: string } {
  const nonce = OWNED.get(path);
  if (nonce === undefined) {
    try {
      lstatSync(path);
    } catch {
      return { removed: true }; // nothing there (already removed): idempotent
    }
    return { removed: false, refused: 'not created by this process' };
  }
  if (!existsSync(path) && !isRealDir(path)) {
    OWNED.delete(path);
    return { removed: true };
  }
  if (!isRealDir(path)) return { removed: false, refused: 'not a real directory (symlink or file)' };
  const marker = readMarker(path);
  if (!marker || marker.nonce !== nonce || marker.pid !== process.pid) return { removed: false, refused: 'owner marker missing or replaced' };
  const removed = removeTreeSync(path);
  if (removed) OWNED.delete(path);
  return removed ? { removed } : { removed, refused: 'still not empty after retries' };
}

/**
 * Removes leftovers of dead canary runs: directories directly under `parent` whose name starts with one of `prefixes`, that are real
 * directories carrying an owner marker whose process is gone. A directory without a marker, with a live owner or reached through a symlink is left alone.
 */
export function sweepStaleOwnedDirs(parent: string, prefixes: readonly string[]): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(parent);
  } catch {
    return { removed, kept };
  }
  for (const name of names) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const path = join(parent, name);
    if (!isRealDir(path)) continue;
    const marker = readMarker(path);
    if (!marker || marker.pid === process.pid || pidAlive(marker.pid)) {
      kept.push(path);
      continue;
    }
    (removeTreeSync(path) ? removed : kept).push(path);
  }
  return { removed, kept };
}

/** Sweeps the places the canaries use under the real home. */
export function sweepCanaryLeftovers(): { removed: string[]; kept: string[] } {
  return sweepStaleOwnedDirs(realpathSync(homedir()), ['.agentic-canary-', '.agentic-vcanary-']);
}

/** Kills a process group (the CLI's background writers included) and waits until it is gone. */
export async function killGroup(pid: number | undefined, waitMs = 5_000): Promise<boolean> {
  if (!pid) return true;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    return true; // no such group
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    try {
      process.kill(-pid, 0);
    } catch (err) {
      // ESRCH: gone. EPERM: on macOS a group left with only zombies (killed, not yet reaped) answers EPERM; we just signalled it, so
      // nothing in it can still be running.
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ESRCH' || code === 'EPERM';
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Finds every `auth.json` under `roots` (symlinks are not followed) that is byte-identical to the real Codex login. The login is only hashed
 * in memory; no content is ever returned or printed. A canary leftover must never be on this list.
 */
export function findRealCredentialCopies(roots: readonly string[], env: NodeJS.ProcessEnv = process.env, maxDepth = 6): string[] {
  const realStore = join(env.CODEX_HOME || join(realpathSync(homedir()), '.codex'), 'auth.json');
  if (!existsSync(realStore)) return [];
  const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const real = hash(realStore);
  const copies: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'auth.json' && p !== realStore) {
        try {
          if (hash(p) === real) copies.push(p);
        } catch {
          /* unreadable: not a copy we can prove */
        }
      }
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r, 0);
  return copies;
}

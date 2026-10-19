/**
 * Test-only helpers for the pid files that the fake provider CLIs write.
 *
 * Why this exists: a test that waits for a pid file to EXIST and then reads it can observe the file between its creation and its
 * content (a plain write truncates first). `Number('')` is 0, and `process.kill(0, 0)` signals the caller's own process group, so
 * `alive(0)` is true forever and "wait for the CLI to be dead" times out (seen on macOS CI, gemini-scheduler cancellation test).
 * The fakes now write atomically (write + rename), and consumers must use `readPid`/`isAlive`, which cannot be fooled that way.
 */
import { readFileSync } from 'node:fs';

/** The pid in `file`, or undefined while the file is missing, empty, partial or not a plain positive integer above 1. */
export function readPid(file: string): number | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return undefined; }
  if (!/^[0-9]+$/.test(text.trim())) return undefined;
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

/** Liveness of one specific process. Pids 0 and 1 and non-integers are refused: `kill(0, 0)` and `kill(-1, 0)` address groups. */
export function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new RangeError(`isAlive: refusing pid ${pid} (it would address a process group or init)`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

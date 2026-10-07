import { spawn } from 'node:child_process';

/**
 * Bounded command runner for the runtime CLI. Adapted from the private
 * runControlledCommand in src/workers/tools/execution-tools.ts so the runtime
 * never imports @mastra/core: fixed argv (never a shell string), hard
 * timeout that kills the whole process group, and a hard cap on captured
 * output so a noisy test run cannot exhaust memory.
 */

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  startError: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True if either stream exceeded maxBytes and was cut. */
  overflow: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const start = Date.now();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      resolve({
        exitCode: null,
        timedOut: false,
        startError: (err as Error).message,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - start,
        overflow: false,
      });
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes < maxBytes) {
        out.push(chunk);
        outBytes += chunk.byteLength;
      } else overflow = true;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes < maxBytes) {
        err.push(chunk);
        errBytes += chunk.byteLength;
      } else overflow = true;
    });

    const finish = (result: Omit<RunResult, 'durationMs' | 'overflow' | 'stdout' | 'stderr'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        durationMs: Date.now() - start,
        overflow,
      });
    };

    child.on('error', (e) => finish({ exitCode: null, timedOut: false, startError: e.message }));
    child.on('close', (code) => finish({ exitCode: timedOut ? null : code, timedOut, startError: null }));
  });
}

/** Runs git in `cwd` and returns trimmed stdout, or throws with stderr. */
export async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const result = await run('git', args, { cwd, timeoutMs });
  if (result.exitCode !== 0) {
    const reason = result.startError ?? (result.timedOut ? 'timed out' : result.stderr.trim());
    throw new Error(`git ${args.join(' ')} failed: ${reason}`);
  }
  return result.stdout;
}

/** Like git(), but returns the exit code instead of throwing (for predicates). */
export async function gitExitCode(cwd: string, args: string[]): Promise<number | null> {
  return (await run('git', args, { cwd, timeoutMs: 30_000 })).exitCode;
}

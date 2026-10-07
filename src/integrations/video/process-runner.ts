import { spawn } from 'node:child_process';

/**
 * Fixed-argv subprocess runner for the video pipeline (ffmpeg/ffprobe).
 * Same shape as execution-tools.ts's runControlledCommand - a fixed argv
 * array is spawned directly (never a shell string), with a hard timeout
 * that kills the whole process group. Kept local to this module rather
 * than imported from execution-tools.ts because that module's helper is
 * private and its call sites are tied to a repository-root request
 * context, which doesn't apply here (video/image paths are arbitrary
 * local filesystem paths, not repository-scoped).
 */

const MAX_OUTPUT_BYTES = 8_000;

export interface CommandResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

function truncate(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n\n[output truncated]`;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<CommandResult> {
  const start = Date.now();

  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolvePromise({
        success: false,
        exitCode: null,
        stdout: '',
        stderr: `Failed to start "${command}": ${(err as Error).message}`,
        durationMs: Date.now() - start,
        timedOut: false,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.on('error', (err) => {
      finish({
        success: false,
        exitCode: null,
        stdout: truncate(Buffer.concat(stdoutChunks).toString('utf8'), MAX_OUTPUT_BYTES),
        stderr: `Failed to run "${command}": ${err.message}`,
        durationMs: Date.now() - start,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      const stdout = truncate(Buffer.concat(stdoutChunks).toString('utf8'), MAX_OUTPUT_BYTES);
      let stderr = truncate(Buffer.concat(stderrChunks).toString('utf8'), MAX_OUTPUT_BYTES);
      if (timedOut) {
        stderr += `\n[Command timed out after ${options.timeoutMs}ms and was terminated.]`;
      }
      finish({
        success: !timedOut && code === 0,
        exitCode: timedOut ? null : code,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

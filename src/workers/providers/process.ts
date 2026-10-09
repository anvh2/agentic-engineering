import { spawn } from 'node:child_process';

/**
 * Runs a provider CLI as a child process the runtime fully accounts for. Every guarantee here exists for one reason: a
 * cloud coding CLI is an autonomous agent with its own tools, so cancellation, timeouts and its environment have to be
 * enforced from outside.
 *
 *  - The child leads its OWN process group (`detached`), and only that group (`-pid`) is ever signalled: the CLI, its
 *    helpers and anything they spawned die together, and no process this call did not start can be touched. The user's
 *    interactive Claude/Codex/Gemini sessions are different pids and different groups.
 *  - Timeout and abort end the same way: SIGTERM to the group, then SIGKILL after `termGraceMs`. The outcome says which
 *    one it took (`terminatedBy`). A process that is still not gone `killWaitMs` after SIGKILL is reported
 *    (`stillRunning`, with its pid), never silently abandoned.
 *  - The environment is an allowlist built here, not the parent's: credentials reach the child only if named in
 *    `passEnv`. The env is never logged or returned.
 *  - Output is bounded; the prompt is delivered on stdin when given.
 */

export interface ProviderProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Written to the child's stdin, which is then closed. Without it stdin is closed immediately. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Time between SIGTERM and SIGKILL (default 5 s). */
  termGraceMs?: number;
  /** Time to wait for the exit after SIGKILL before reporting `stillRunning` (default 3 s). */
  killWaitMs?: number;
  /** Extra environment variable NAMES to forward from the parent (values are never read into logs). */
  passEnv?: readonly string[];
  /** Fixed variables for the child (e.g. a model-specific setting). */
  env?: Record<string, string>;
  maxOutputBytes?: number;
  /** Parent environment to build from (tests inject one). */
  parentEnv?: NodeJS.ProcessEnv;
  /**
   * Called once the process exists, with its pid (= its process group id) and a promise that settles when the call is over
   * and the group has been swept. Lets an owner account for exactly the processes it started, and nothing else.
   */
  onProcess?: (info: { pid: number; exited: Promise<void> }) => void;
}

export interface ProviderProcessResult {
  /** Spawn failed (binary missing/not executable): nothing ran. */
  spawnError?: string;
  pid?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** How the process ended: by itself, or which signal the runtime had to use. */
  terminatedBy: 'exit' | 'SIGTERM' | 'SIGKILL';
  /** True only if the process group could not be confirmed gone after SIGKILL. */
  stillRunning: boolean;
  durationMs: number;
}

/** The only variables a provider child inherits by default. Credentials are deliberately not among them. */
export const BASE_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ'] as const;

export function buildChildEnv(parentEnv: NodeJS.ProcessEnv, passEnv: readonly string[] = [], fixed: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV_ALLOWLIST, ...passEnv]) if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  return { ...env, ...fixed, CI: '1', NO_COLOR: '1' };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function runProviderProcess(options: ProviderProcessOptions): Promise<ProviderProcessResult> {
  const started = Date.now();
  const maxBytes = options.maxOutputBytes ?? 2_000_000;
  const empty = (extra: Partial<ProviderProcessResult>): ProviderProcessResult => ({ exitCode: null, signal: null, stdout: '', stderr: '', outputTruncated: false, timedOut: false, aborted: false, terminatedBy: 'exit', stillRunning: false, durationMs: Date.now() - started, ...extra });

  if (options.signal?.aborted) return Promise.resolve(empty({ aborted: true, stderr: 'not started: cancelled before launch' }));

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: buildChildEnv(options.parentEnv ?? process.env, options.passEnv, options.env),
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve(empty({ spawnError: (err as Error).message }));
      return;
    }

    let markExited!: () => void;
    const exited = new Promise<void>((r) => (markExited = r));
    if (child.pid !== undefined) options.onProcess?.({ pid: child.pid, exited });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let terminatedBy: ProviderProcessResult['terminatedBy'] = 'exit';
    let closed = false;
    let spawnError: string | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let finishTimer: NodeJS.Timeout | undefined;

    const take = (sink: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - bytes;
      sink.push(chunk.byteLength > room ? chunk.subarray(0, room) : chunk);
      if (chunk.byteLength > room) truncated = true;
      bytes += Math.min(chunk.byteLength, room);
    };
    child.stdout?.on('data', take(out));
    child.stderr?.on('data', take(err));
    child.stdin?.on('error', () => {
      /* the child exited before reading its prompt: reported through its exit status */
    });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);

    const signalGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig); // the child's own group only
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    const terminate = () => {
      if (closed || terminatedBy !== 'exit') return;
      terminatedBy = 'SIGTERM';
      signalGroup('SIGTERM');
      escalation = setTimeout(() => {
        if (closed) return;
        terminatedBy = 'SIGKILL';
        signalGroup('SIGKILL');
        finishTimer = setTimeout(() => finish(null, null, true), options.killWaitMs ?? 3_000);
      }, options.termGraceMs ?? 5_000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let done = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, stillRunning = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(finishTimer);
      options.signal?.removeEventListener('abort', onAbort);
      markExited();
      resolve({
        spawnError,
        pid: child.pid,
        exitCode,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        outputTruncated: truncated,
        timedOut,
        aborted,
        terminatedBy,
        stillRunning,
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (e) => {
      spawnError = e.message;
      closed = true;
      finish(null, null);
    });
    child.on('close', async (code, signal) => {
      closed = true;
      // The leader exited; a helper it left behind in the group must not outlive the call, whether the leader left by itself
      // or after our SIGTERM (a child that ignores SIGTERM would otherwise survive its parent).
      signalGroup('SIGKILL');
      await sleep(0);
      finish(code, signal);
    });
  });
}

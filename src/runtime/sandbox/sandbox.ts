import { existsSync, realpathSync } from 'node:fs';
import { access, constants, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { runControlledCommand, type ControlledCommandResult } from '../../workers/tools/execution-tools.ts';

/**
 * OS-level isolation for every command that executes model-generated code: the runtime verifier, the worker's own
 * test/format tools, and integration verification. The model's code runs with the user's privileges otherwise, so the
 * repository-relative checks elsewhere (mutation snapshot, change gate) only see what it did AFTER it ran.
 *
 * Inside the sandbox a command can:
 *   - write only inside its task root and a private temp dir created for this one command (fresh build/test caches,
 *     so one run cannot poison another's) - never the root's `.git` or `node_modules`;
 *   - not use the network at all, loopback included (the Mastra API and Ollama listen on loopback);
 *   - not read credential stores or `.env` files outside its root;
 *   - not signal or inspect processes outside its own sandbox (on macOS `ps` exposes other processes' environment);
 *   - see only an allow-listed environment (the runtime's own secrets are never passed down).
 *
 * Fail closed: if the platform has no supported sandbox, or the self-test cannot prove that a write outside the root is
 * blocked, nothing is executed and the command reports `sandboxUnavailable`. There is deliberately no opt-out.
 * Supported: macOS `sandbox-exec`. Anything else is reported unavailable.
 */

export interface SandboxStatus {
  available: boolean;
  mechanism: 'sandbox-exec' | null;
  reason?: string;
}

export interface SandboxedCommandResult extends ControlledCommandResult {
  /** True when the command was refused because isolation is unavailable (it never ran). */
  sandboxUnavailable?: boolean;
}

const PROFILE = `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write*
  (subpath (param "ROOT"))
  (subpath (param "TMP"))
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")
  (regex #"^/dev/fd/[0-9]+$"))
(deny file-write*
  (subpath (string-append (param "ROOT") "/.git"))
  (subpath (string-append (param "ROOT") "/node_modules")))
(deny file-read*
  (subpath (string-append (param "HOME") "/.ssh"))
  (subpath (string-append (param "HOME") "/.aws"))
  (subpath (string-append (param "HOME") "/.gnupg"))
  (subpath (string-append (param "HOME") "/.docker"))
  (subpath (string-append (param "HOME") "/.kube"))
  (subpath (string-append (param "HOME") "/.claude"))
  (subpath (string-append (param "HOME") "/.config/gh"))
  (subpath (string-append (param "HOME") "/Library/Keychains"))
  (literal (string-append (param "HOME") "/.claude.json"))
  (literal (string-append (param "HOME") "/.netrc"))
  (literal (string-append (param "HOME") "/.npmrc"))
  (literal (string-append (param "HOME") "/.git-credentials"))
  (require-all (regex #"/\\.env(\\.[^/]*)?$") (require-not (subpath (param "ROOT")))))
(deny signal)
(allow signal (target same-sandbox))
(deny process-info*)
(allow process-info* (target same-sandbox))
`;

/** Environment passed through to sandboxed commands; everything else (tokens, API keys, NODE_OPTIONS...) is dropped. */
const PASS_THROUGH_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'GOPATH', 'GOROOT', 'GOMODCACHE'];

function sandboxExecutable(): string {
  // Override only for tests that simulate a missing/broken sandbox. A replacement that does not actually isolate
  // cannot pass the self-test below, so this cannot be used to turn isolation off.
  return process.env.AGENTIC_SANDBOX_EXEC ?? '/usr/bin/sandbox-exec';
}

let statusPromise: Promise<SandboxStatus> | undefined;

/** Cached per process: whether model-generated code may be executed at all. */
export function sandboxStatus(): Promise<SandboxStatus> {
  statusPromise ??= probe();
  return statusPromise;
}

/** Tests only: forget the cached probe result (e.g. after changing AGENTIC_SANDBOX_EXEC). */
export function resetSandboxStatusForTests(): void {
  statusPromise = undefined;
}

async function probe(): Promise<SandboxStatus> {
  if (process.platform !== 'darwin') {
    return { available: false, mechanism: null, reason: `no supported OS sandbox on ${process.platform} (only macOS sandbox-exec is supported)` };
  }
  const exe = sandboxExecutable();
  try {
    await access(exe, constants.X_OK);
  } catch {
    return { available: false, mechanism: null, reason: `${exe} is not available` };
  }
  // Functional self-test: the profile must compile, a write inside the root must work and a write outside must not.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agentic-sandbox-probe-')));
  try {
    const root = join(dir, 'root');
    const outside = join(dir, 'outside');
    await mkdir(root);
    await mkdir(outside);
    const r = await runControlledCommand(exe, [...defines(root, root), '-p', PROFILE, '/bin/sh', '-c', 'echo in > "$1/in"; echo leak > "$2/out"', 'probe', root, outside], { cwd: root, timeoutMs: 10_000 });
    if (!existsSync(join(root, 'in'))) return { available: false, mechanism: null, reason: `sandbox self-test could not run a command: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
    if (existsSync(join(outside, 'out'))) return { available: false, mechanism: null, reason: 'sandbox self-test failed: a write outside the root was not blocked' };
    return { available: true, mechanism: 'sandbox-exec' };
  } catch (err) {
    return { available: false, mechanism: null, reason: `sandbox self-test failed: ${(err as Error).message}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function defines(root: string, tmp: string): string[] {
  return ['-D', `ROOT=${root}`, '-D', `TMP=${tmp}`, '-D', `HOME=${homeDir}`];
}

const homeDir = (() => {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
})();

/** Absolute path of `command` on PATH (or the command itself if it is already a path), or undefined if not found. */
function resolveExecutable(command: string, path: string | undefined): string | undefined {
  if (command.includes('/')) return isAbsolute(command) && existsSync(command) ? command : undefined;
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function refused(command: string, reason: string, start: number): SandboxedCommandResult {
  return {
    success: false,
    exitCode: null,
    stdout: '',
    stderr: `Refused to run "${command}": OS sandbox unavailable (${reason}). Model-generated code is never executed without isolation.`,
    durationMs: Date.now() - start,
    timedOut: false,
    sandboxUnavailable: true,
  };
}

/**
 * Runs `command args` (argv, never a shell string) in `cwd` under the sandbox, with write access limited to `root`
 * (which must exist) and a private temp dir that is deleted afterwards. Same result shape and timeout/kill semantics
 * as runControlledCommand. A command that is not on PATH reports a start failure (exitCode null) without spawning.
 */
export async function runSandboxedCommand(
  command: string,
  args: string[],
  options: { cwd: string; root: string; timeoutMs: number },
): Promise<SandboxedCommandResult> {
  const start = Date.now();
  const status = await sandboxStatus();
  if (!status.available) return refused(command, status.reason ?? 'unknown', start);

  const executable = resolveExecutable(command, process.env.PATH);
  if (!executable) {
    return { success: false, exitCode: null, stdout: '', stderr: `Failed to start "${command}": not found on PATH`, durationMs: Date.now() - start, timedOut: false };
  }

  const root = await realpath(options.root);
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'agentic-sbx-')));
  try {
    await writeFile(join(tmp, 'npmrc'), '');
    const env: NodeJS.ProcessEnv = {};
    for (const key of PASS_THROUGH_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, {
      TMPDIR: tmp,
      GOTMPDIR: tmp,
      GOCACHE: join(tmp, 'go-build'),
      GOTOOLCHAIN: 'local',
      GOPROXY: 'off',
      CGO_ENABLED: '0',
      npm_config_cache: join(tmp, 'npm'),
      npm_config_userconfig: join(tmp, 'npmrc'),
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      CI: '1',
    });
    return await runControlledCommand(sandboxExecutable(), [...defines(root, tmp), '-p', PROFILE, executable, ...args], { cwd: options.cwd, timeoutMs: options.timeoutMs, env });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

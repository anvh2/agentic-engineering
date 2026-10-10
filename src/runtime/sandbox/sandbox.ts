import { existsSync, realpathSync } from 'node:fs';
import { access, constants, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { runControlledCommand, type ControlledCommandResult } from '../../workers/tools/execution-tools.ts';
import { SAFE_PATH, TOO_BROAD, canonicalPath, executableAccess, isInside } from './toolchain.ts';

/**
 * OS-level isolation for every command that executes model-generated code: the runtime verifier, the worker's own
 * test/format tools, and integration verification. The model's code runs with the user's privileges otherwise, so the
 * repository-relative checks elsewhere (mutation snapshot, change gate) only see what it did AFTER it ran.
 *
 * Inside the sandbox a command can:
 *   - READ only an allow-list: the system pieces a toolchain needs to start, the toolchain of the executable it runs (its package root,
 *     GOROOT, the Go module cache), its task root, its private temp dir, and paths the trusted caller adds explicitly. Everything else on the
 *     host (the home directory, credentials, other tasks' worktrees and artifacts, the oracle) is unreadable; stat() still answers, so
 *     existence and size of a path are observable, contents and directory listings are not. The credential and `.env` deny rules stay
 *     underneath as a second layer;
 *   - write only inside its task root and a private temp dir created for this one command (fresh build/test caches,
 *     so one run cannot poison another's) - never the root's `.git` or `node_modules`;
 *   - not use the network at all, loopback included (the Mastra API and Ollama listen on loopback), and reach no Mach service but
 *     user-info lookup: pasteboard, Keychain (securityd), preferences and the other daemons are closed (the profile is `deny default`);
 *   - not signal or inspect processes outside its own sandbox (on macOS `ps` exposes other processes' environment);
 *   - see only a built environment: locale, a PATH of the toolchain and system directories, and a HOME that is its private temp dir. The
 *     runtime's secrets, the user name and the real home path are never passed down.
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

/**
 * Kernel queries a toolchain makes at start-up (CPU, page size, OS version, and the host name that `uname` returns, which node's `os`
 * module needs). Not the process table. The host name is therefore observable to sandboxed code; see `scrubForWorker`.
 */
const SYSCTLS = [
  'hw.activecpu', 'hw.byteorder', 'hw.cacheconfig', 'hw.cachelinesize', 'hw.cachelinesize_compat', 'hw.cpufamily', 'hw.cputype', 'hw.l1dcachesize', 'hw.l1icachesize', 'hw.l2cachesize', 'hw.l3cachesize',
  'hw.logicalcpu', 'hw.logicalcpu_max', 'hw.machine', 'hw.memsize', 'hw.ncpu', 'hw.nperflevels', 'hw.packages', 'hw.pagesize', 'hw.pagesize_compat', 'hw.physicalcpu', 'hw.physicalcpu_max', 'hw.cpufrequency', 'hw.tbfrequency', 'hw.vectorunit', 'hw.busfrequency_compat', 'hw.cpufrequency_compat', 'hw.l1dcachesize_compat', 'hw.l1icachesize_compat', 'hw.l2cachesize_compat', 'hw.l3cachesize_compat', 'hw.tbfrequency_compat', 'kern.hostname',
  'machdep.cpu.brand_string', 'kern.argmax', 'kern.maxfilesperproc', 'kern.maxproc', 'kern.osproductversion', 'kern.osrelease', 'kern.ostype', 'kern.osvariant_status', 'kern.osversion', 'kern.secure_kernel', 'kern.usrstack64', 'kern.version',
  'sysctl.proc_cputype', 'vm.loadavg', 'kern.sysv.semmns',
];
const SYSCTL_PREFIXES = ['hw.optional.arm.', 'hw.optional.armv8_', 'hw.perflevel', 'kern.proc.pgrp.', 'kern.proc.pid.', 'net.routetable.'];

/** What every command may read besides its own toolchain, root and temp dir: system binaries and libraries, time zone data, devices. */
const SYSTEM_READ_SUBPATHS = ['/usr/bin', '/usr/lib', '/usr/libexec', '/usr/share', '/bin', '/System', '/dev', '/Library/Apple', '/private/var/db/timezone'];
const SYSTEM_READ_LITERALS = ['/', '/private/etc/localtime'];

const PROFILE_BASE = `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read ${SYSCTLS.map((n) => `(sysctl-name "${n}")`).join(' ')} ${SYSCTL_PREFIXES.map((n) => `(sysctl-name-prefix "${n}")`).join(' ')})
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow file-map-executable)
(allow ipc-posix-sem)
(allow pseudo-tty)
(allow file-ioctl)
(allow file-write*
  (subpath (param "ROOT"))
  (subpath (param "TMP"))
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")
  (regex #"^/dev/fd/[0-9]+$"))
(deny file-write*
  (subpath (string-append (param "ROOT") "/.git"))
  (subpath (string-append (param "ROOT") "/node_modules")))
(allow file-read-metadata)
(allow file-read* (subpath (param "ROOT")) (subpath (param "TMP")))
`;

/** Defense in depth under the allow-list: the credential and `.env` rules of the previous profile, applied after every allow. */
const PROFILE_CREDENTIAL_DENIES = `(deny file-read*
  (subpath (string-append (param "HOME") "/.ssh"))
  (subpath (string-append (param "HOME") "/.aws"))
  (subpath (string-append (param "HOME") "/.gnupg"))
  (subpath (string-append (param "HOME") "/.docker"))
  (subpath (string-append (param "HOME") "/.kube"))
  (subpath (string-append (param "HOME") "/.claude"))
  (subpath (string-append (param "HOME") "/.codex"))
  (subpath (string-append (param "HOME") "/.config/gh"))
  (subpath (string-append (param "HOME") "/.config/gcloud"))
  (subpath (string-append (param "HOME") "/Library/Keychains"))
  (literal (string-append (param "HOME") "/.claude.json"))
  (literal (string-append (param "HOME") "/.netrc"))
  (literal (string-append (param "HOME") "/.npmrc"))
  (literal (string-append (param "HOME") "/.git-credentials"))
  (require-all (regex #"/\\.env(\\.[^/]*)?$") (require-not (subpath (param "ROOT")))))
`;

/** The full profile: deny-default base, the read allow-list, then the deny rules (which win over the allows that come before them). */
function buildProfile(extraReads: readonly string[], extraDenies: string): string {
  const reads = [...SYSTEM_READ_LITERALS.map((p) => `(literal "${p}")`), ...[...SYSTEM_READ_SUBPATHS, ...extraReads].map((p) => `(subpath "${p}")`)];
  return `${PROFILE_BASE}(allow file-read*\n  ${reads.join('\n  ')})\n${PROFILE_CREDENTIAL_DENIES}${extraDenies}(deny signal)
(allow signal (target same-sandbox))
`;
}

/**
 * Extra paths the sandboxed code must not read (an objective oracle, hidden tests): `options.denyRead`, plus `AGENTIC_SANDBOX_DENY_READ`
 * (absolute paths separated by the OS path delimiter) for processes that cannot pass options, such as the Mastra server that runs the
 * verifier. Resolved through symlinks, validated, and refused (the command does not run) if one contains the command's root or is not
 * expressible, so a mistake can only stop work, never silently widen what is readable.
 */
const DENY_PATH = /^\/[^\0-\x1f"\\]+$/;
async function denyReadProfile(explicit: readonly string[] | undefined, root: string, tmp: string): Promise<{ profile: string } | { problem: string }> {
  const env = (process.env.AGENTIC_SANDBOX_DENY_READ ?? '').split(delimiter).filter(Boolean);
  let rules = '';
  for (const raw of [...(explicit ?? []), ...env]) {
    if (!DENY_PATH.test(raw) || raw === '/') return { problem: `deny-read path "${raw}" must be absolute, without quotes, backslashes or control characters` };
    const real = await realpath(raw).catch(() => raw);
    if (root === real || root.startsWith(`${real}/`) || tmp === real || tmp.startsWith(`${real}/`)) return { problem: `deny-read path ${real} contains the command's own root or temp dir` };
    rules += `(deny file-read* (subpath "${real}"))\n`;
  }
  return { profile: rules };
}

/**
 * Extra paths the trusted caller makes READABLE on top of the toolchain: `options.readAllow`, plus `AGENTIC_SANDBOX_READ_ALLOW` (absolute
 * paths separated by the OS path delimiter). Needed when a task's dependencies live outside its worktree (a linked `node_modules`). Never
 * derived from the worktree, whose symlinks a worker controls. Refused (the command does not run) if a path is not expressible, is too
 * broad, or is the home directory or an ancestor of it.
 */
async function readAllowPaths(explicit: readonly string[] | undefined): Promise<{ paths: string[] } | { problem: string }> {
  const env = (process.env.AGENTIC_SANDBOX_READ_ALLOW ?? '').split(delimiter).filter(Boolean);
  const paths: string[] = [];
  const home = canonicalPath(homeDir);
  for (const raw of [...(explicit ?? []), ...env]) {
    if (!SAFE_PATH.test(raw)) return { problem: `read-allow path "${raw}" must be absolute, without quotes, backslashes or control characters` };
    const real = canonicalPath(raw);
    if (TOO_BROAD.has(real) || isInside(home, real)) return { problem: `read-allow path ${real} is too broad (it is, or contains, the home directory or a system root)` };
    paths.push(real);
  }
  return { paths };
}

/** Environment kept from the runtime's own: locale and terminal only. No user name, no home path, no secrets, no tool configuration. */
const PASS_THROUGH_ENV = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ'];

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
    await writeFile(join(outside, 'secret'), 'probe-secret\n');
    // inside the root: write and read work; outside it: neither a write nor a read may. The read of the outside file is captured into a
    // variable and a marker proves the statement RAN: a read that never executed (a redirect the profile refused, a crashed shell) is not
    // evidence that reads are blocked.
    const script = [
      'echo in > "$1/in"',
      'echo leak > "$2/out"',
      'out=$(cat "$2/secret" 2>&1)',
      'echo ran > "$1/read-ran"',
      'printf "%s" "$out" > "$1/read-outside"',
      'cat "$1/in" > "$1/read-inside"',
    ].join('; ');
    const r = await runControlledCommand(exe, [...defines(root, root), '-p', buildProfile([], ''), '/bin/sh', '-c', script, 'probe', root, outside], { cwd: root, timeoutMs: 10_000 });
    if (!existsSync(join(root, 'in'))) return { available: false, mechanism: null, reason: `sandbox self-test could not run a command: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
    if (existsSync(join(outside, 'out'))) return { available: false, mechanism: null, reason: 'sandbox self-test failed: a write outside the root was not blocked' };
    if ((await readFile(join(root, 'read-inside'), 'utf8').catch(() => '')).trim() !== 'in') return { available: false, mechanism: null, reason: 'sandbox self-test failed: a read inside the root did not work' };
    if (!existsSync(join(root, 'read-ran'))) return { available: false, mechanism: null, reason: 'sandbox self-test could not complete: the read probe did not run' };
    if ((await readFile(join(root, 'read-outside'), 'utf8').catch(() => '')).includes('probe-secret')) return { available: false, mechanism: null, reason: 'sandbox self-test failed: a read outside the root and the allow-list was not blocked' };
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
  options: { cwd: string; root: string; timeoutMs: number; signal?: AbortSignal; denyRead?: readonly string[]; readAllow?: readonly string[] },
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
    const deny = await denyReadProfile(options.denyRead, root, tmp);
    if ('problem' in deny) return refused(command, deny.problem, start);
    const extra = await readAllowPaths(options.readAllow);
    if ('problem' in extra) return refused(command, extra.problem, start);
    const toolchain = executableAccess(executable);
    await writeFile(join(tmp, 'npmrc'), '');
    const env: NodeJS.ProcessEnv = {};
    for (const key of PASS_THROUGH_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, {
      // The command's own world: PATH is the toolchain and the system, HOME is its private temp dir (not the user's), no user name.
      PATH: [...new Set([...toolchain.binDirs, '/usr/bin', '/bin'])].join(delimiter),
      HOME: tmp,
      TMPDIR: tmp,
      GOTMPDIR: tmp,
      GOCACHE: join(tmp, 'go-build'),
      GOPATH: join(tmp, 'go'),
      GOTOOLCHAIN: 'local',
      GOPROXY: 'off',
      GOTELEMETRY: 'off',
      // a worktree's git directory is not readable, so Go cannot stamp VCS information
      GOFLAGS: '-buildvcs=false',
      CGO_ENABLED: '0',
      npm_config_cache: join(tmp, 'npm'),
      npm_config_userconfig: join(tmp, 'npmrc'),
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      CI: '1',
      ...toolchain.env,
    });
    if (toolchain.env.GOMODCACHE) {
      // The module cache lives under the user's home directory; its path would put the home path and the user name into the command's
      // environment and error output. The command gets a private alias inside its temp dir; the profile grants the real directory.
      const alias = join(tmp, 'modcache');
      await symlink(toolchain.env.GOMODCACHE, alias);
      env.GOMODCACHE = alias;
    }
    const profile = buildProfile([...toolchain.read, ...extra.paths], deny.profile);
    return await runControlledCommand(sandboxExecutable(), [...defines(root, tmp), '-p', profile, executable, ...args], { cwd: options.cwd, timeoutMs: options.timeoutMs, env, signal: options.signal });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

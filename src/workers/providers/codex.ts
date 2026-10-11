import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runControlledCommand } from '../tools/execution-tools.ts';
import { redact } from '../../runtime/execution/coding-task-trace.ts';
import { executableReadPaths, which } from '../../runtime/sandbox/toolchain.ts';
import type { WorkerLike } from '../../runtime/execution/coding-task-runner.ts';
import type { ProviderAvailability, ProviderDescriptor, ProviderRequest, RawUsage } from '../../runtime/execution/worker-provider.ts';
import { probeCli, type CliProbeResult } from './cli-probe.ts';
import { canonicalPath, effectiveDenyPaths, isInside, isolationArgs, isolationRequested, type CodexIsolationOptions } from './codex-isolation.ts';
import { runProviderProcess, type ProviderProcessResult } from './process.ts';
import type { WorkerProvider } from './provider.ts';
import type { ProviderEntry } from './registry.ts';

/**
 * OpenAI Codex CLI as an OPTIONAL coding worker (`codex exec`, non-interactive). It is a cloud agent that edits the
 * isolated worktree with its own tools, so the safety case rests on four things this file enforces from outside:
 *
 *  1. Containment. The run is launched with the CLI's `workspace-write` sandbox, rooted at the task worktree, and with no
 *     escape hatch: the command builder refuses any bypass flag (`--dangerously-*`, `--yolo`, `danger-full-access`,
 *     `--full-auto`, extra writable dirs), so there is no configuration that weakens it.
 *  2. Fail closed. Before a run the installed binary's own `--help` must advertise every flag the run depends on; if
 *     `--sandbox` or `--cd` is missing, nothing runs. A task type the provider is not cleared for, a missing
 *     `providerRequest`, or a git history change made by the CLI inside the worktree also fail the call.
 *  3. Scope. The CLI sandbox cannot express "only these files", so the runner's filesystem comparison remains the
 *     authority: any change outside `allowedFiles` is a forbidden mutation, the tree is restored and the task fails.
 *  4. Bounded cost. At most 2 coding attempts and NO automatic runtime retry (every call is billed); cancel, timeout and
 *     the per-call deadline terminate the CLI's whole process group (SIGTERM, then SIGKILL).
 *
 * Credentials: the child gets an allowlisted environment. It authenticates through its own login in HOME/CODEX_HOME;
 * an API key is forwarded only if the operator names it in `passEnv`. Probing reports a yes/no, never account details.
 *
 * Nothing here runs a model unless the runtime calls `generate`; `probe` makes no model request.
 */

/**
 * Checked against `codex exec --help` of codex-cli 0.161.0. `--ignore-user-config` is REQUIRED, not optional: without it the
 * operator's ~/.codex/config.toml (approval policy, sandbox permissions, extra writable roots, profiles) would be layered
 * under our flags and could weaken them. Auth still comes from CODEX_HOME, which is not a config file.
 */
export const CODEX_REQUIRED_FLAGS = ['--sandbox', '--cd', '--ignore-user-config'] as const;
const FORBIDDEN_ARG = /dangerously|bypass|yolo|danger-full-access|full-auto|--add-dir|--search|--worktree|--approve-for-me|--oss|--profile|^-p$|^-c$|--config|--enable|--disable/i;

export interface CodexConfig {
  /** Binary to run (default `codex`). */
  command?: string;
  /** Model passed with --model; omitted when unset (the CLI default is then used and reported as UNKNOWN). */
  model?: string;
  /** Parent environment variable NAMES forwarded to the CLI (e.g. CODEX_HOME). Keys such as OPENAI_API_KEY only if chosen. */
  passEnv?: readonly string[];
  /** Fixed variables for the CLI process (tests). */
  env?: Record<string, string>;
  parentEnv?: NodeJS.ProcessEnv;
  termGraceMs?: number;
  /** Receives the pid/process group of every CLI process this provider starts (for owner-side accounting and cleanup). */
  onProcess?: (info: { pid: number; exited: Promise<void> }) => void;
  /**
   * Absolute paths the model's commands must not be able to READ (an objective oracle, runtime state holding hidden tests). Credential
   * locations (SSH, cloud, Codex login, shell history...) are always added. The CLI's `workspace-write` sandbox restricts writes only;
   * with any isolation option set the run uses a filesystem permission profile instead of the `--sandbox` flag (the CLI ignores a
   * profile when `--sandbox` is given), a three-tool surface and a controlled shell environment. See codex-isolation.ts.
   */
  denyReadPaths?: readonly string[];
  /**
   * Allow-list mode (preferred): when set, even empty, the model's commands can read ONLY the system minimum, these toolchain
   * directories (see `discoverToolchainReadPaths`) and the worktree; nothing else on the host, the home directory included.
   */
  readAllowPaths?: readonly string[];
}

export { CODEX_ISOLATION_PROFILE } from './codex-isolation.ts';

/**
 * The exact argv for a run; the prompt is NOT in it (it goes on stdin via the trailing `-`, so it neither appears in the
 * process list nor hits argv limits). Throws if anything in it would weaken containment. No `-c` overrides are accepted at
 * all: every setting that matters is a dedicated flag verified against the installed help.
 */
export function buildCodexArgs(workdir: string, options: { model?: string; json: boolean; ephemeral?: boolean; colorNever?: boolean; isolation?: CodexIsolationOptions }): string[] {
  const isolated = options.isolation !== undefined && isolationRequested(options.isolation);
  const args = [
    'exec',
    // With a profile the flag must be absent: the CLI silently ignores the profile when `--sandbox` is present (observed on 0.161.0).
    ...(isolated ? [] : ['--sandbox', 'workspace-write']),
    '--cd', workdir,
    '--ignore-user-config',
    ...(options.ephemeral ? ['--ephemeral'] : []),
    ...(options.colorNever ? ['--color', 'never'] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.json ? ['--json'] : []),
  ];
  const bad = args.find((a) => FORBIDDEN_ARG.test(a));
  if (bad) throw new Error(`refusing to build a Codex command containing "${bad}": it would weaken the sandbox`);
  // The only overrides this adapter ever emits, all fixed text or validated paths (codex-isolation.ts); nothing a caller supplies reaches
  // the CLI as a free-form setting.
  return isolated ? [...args, ...isolationArgs(options.isolation!), '-'] : [...args, '-'];
}

const PREAMBLE = (r: ProviderRequest) =>
  [
    'You are a coding worker inside a runtime that verifies your result independently.',
    `Work only in the current repository. Modify ONLY these files: ${r.allowedFiles.join(', ')}. Any other change fails the task.`,
    'Do not run git commands that change history or branches (no commit, checkout, reset, stash). Do not install packages. Do not use the network.',
    'Make the change in the files directly, then stop. The runtime formats and runs the tests itself.',
  ].join('\n');

interface Parsed {
  text: string;
  usage?: RawUsage;
  tools: { name: string; ok?: boolean }[];
}

/** Tolerant reader for `--json` event lines. Unknown shapes are ignored; nothing it reads can decide PASS. */
export function parseCodexEvents(stdout: string): Parsed {
  const out: Parsed = { text: '', tools: [] };
  const plain: string[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      plain.push(t);
      continue;
    }
    const item = ev?.item ?? ev?.msg;
    const kind = String(item?.type ?? ev?.type ?? '');
    if (/agent_message|assistant_message/.test(kind) && typeof (item?.text ?? item?.message) === 'string') out.text = item.text ?? item.message;
    if (/command_execution|exec_command/.test(kind)) out.tools.push({ name: 'shell', ok: item?.exit_code === undefined ? undefined : item.exit_code === 0 });
    if (/file_change|patch_apply/.test(kind)) out.tools.push({ name: 'applyPatch', ok: item?.status ? item.status !== 'failed' : undefined });
    const u = ev?.usage ?? item?.usage ?? ev?.msg?.info?.total_token_usage;
    if (u && typeof u === 'object') out.usage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
  }
  if (!out.text && plain.length) out.text = plain.slice(-5).join('\n');
  return out;
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

async function headOf(workdir: string): Promise<string> {
  const r = await runControlledCommand('git', ['rev-parse', 'HEAD'], { cwd: workdir, timeoutMs: 10_000 });
  return r.success ? r.stdout.trim() : `unreadable:${r.exitCode}`;
}

export function codexDescriptor(config: CodexConfig = {}, cliVersion?: string): ProviderDescriptor {
  return {
    identity: { id: 'codex', kind: 'cloud', model: config.model ?? 'UNKNOWN', ...(cliVersion ? { cliVersion } : {}) },
    capabilities: { taskTypes: ['go', 'js'], editsFiles: 'directly', fileScope: 'os-sandbox', cancellation: 'process-group', usage: 'tokens', billing: 'unknown' },
    capacity: { resource: 'codex', defaultPermits: 1 },
    limits: { maxRuntimeRetries: 0, maxCodingAttempts: 2 },
  };
}

export function probeCodex(config: CodexConfig = {}, cwd = process.cwd()): Promise<CliProbeResult> {
  return probeCli({
    command: config.command ?? 'codex',
    cwd,
    versionArgs: ['--version'],
    helpArgs: ['exec', '--help'],
    requiredFlags: CODEX_REQUIRED_FLAGS,
    authArgs: ['login', 'status'],
    parentEnv: config.parentEnv,
    passEnv: config.passEnv,
    env: config.env,
  });
}

export function createCodexProvider(config: CodexConfig = {}): WorkerProvider {
  const configuredCommand = config.command ?? 'codex';
  const locatedCommand = configuredCommand.includes('/') ? configuredCommand : which(configuredCommand, config.parentEnv?.PATH ?? process.env.PATH);
  const command = locatedCommand ? canonicalPath(locatedCommand) : configuredCommand;
  let descriptor = codexDescriptor(config);
  let probed: CliProbeResult | undefined;
  const probe = async (cwd = process.cwd()): Promise<ProviderAvailability> => {
    probed = await probeCodex(config, cwd);
    if (probed.version) descriptor = codexDescriptor(config, probed.version);
    return { state: probed.state, detail: probed.detail, version: probed.version };
  };

  const generate: WorkerLike['generate'] = async (prompt, options) => {
    const request = options.providerRequest as ProviderRequest | undefined;
    if (!request?.workdir) throw new Error('codex provider: no providerRequest; refusing to run without an isolated working directory and file scope');
    if (!descriptor.capabilities.taskTypes.includes(request.taskType)) throw new Error(`codex provider is not cleared for ${request.taskType} tasks`);
    const signal = options.abortSignal as AbortSignal | undefined;

    // Fail closed, against the installed binary (probed once per provider instance, again if the previous probe failed).
    if (probed?.state !== 'available') {
      const a = await probe(request.workdir);
      if (a.state !== 'available') throw new Error(`codex provider unavailable (${a.state}): ${a.detail}`);
    }
    const isolated = isolationRequested(config);
    let scratch: string | undefined;
    let isolation: CodexIsolationOptions | undefined;
    if (isolated) {
      for (const flag of ['--config', '--disable', '--strict-config']) {
        if (!probed!.advertises(flag)) throw new Error(`codex provider: read isolation needs \`${flag}\` in \`codex exec --help\`; this CLI cannot enforce it, so nothing runs`);
      }
      const env = config.parentEnv ?? process.env;
      const deny = (config.denyReadPaths ?? []).map(canonicalPath);
      const workdir = canonicalPath(request.workdir);
      const overlapping = effectiveDenyPaths({ denyReadPaths: deny, env }).find((d) => isInside(workdir, d) || isInside(d, workdir));
      if (overlapping) throw new Error(`codex provider: the worktree ${request.workdir} overlaps the read-denied path ${overlapping}`);
      scratch = mkdtempSync(join(canonicalPath(tmpdir()), 'agentic-codex-'));
      isolation = {
        denyReadPaths: deny,
        ...(config.readAllowPaths ? { readAllowPaths: [...new Set([...config.readAllowPaths.map(canonicalPath), ...executableReadPaths(command, env)])] } : {}),
        scratchDir: scratch,
        env,
      };
    }
    try {
      const args = buildCodexArgs(request.workdir, { model: config.model, json: probed!.advertises('--json'), ephemeral: probed!.advertises('--ephemeral'), colorNever: probed!.advertises('--color'), isolation });

      const headBefore = await headOf(request.workdir);
      const r: ProviderProcessResult = await runProviderProcess({ command, args, stdin: `${PREAMBLE(request)}\n\n${prompt}`, cwd: request.workdir, timeoutMs: request.timeoutMs, signal, passEnv: config.passEnv, env: config.env, parentEnv: config.parentEnv, termGraceMs: config.termGraceMs, onProcess: config.onProcess, faultPoint: 'provider.before-spawn' });

      if (r.stillRunning && r.pid) {
        // The CLI could not be confirmed dead. Do not report the call as over: stay pending until the group is gone, so the
        // runner (which bounds how long it waits for an aborted call) keeps this provider's capacity permit held meanwhile.
        while (groupAlive(r.pid)) await new Promise((res) => setTimeout(res, 500));
      }
      if (r.spawnError) throw new Error(`codex could not be started: ${r.spawnError}`);
      // The call's signal carries the per-call deadline too: tell a deadline from a cancel, they are different events.
      const deadline = r.timedOut || (r.aborted && (signal?.reason as { name?: string } | undefined)?.name === 'TimeoutError');
      if (r.aborted && !deadline) throw new Error(`codex run cancelled (${r.terminatedBy === 'exit' ? 'exited' : `terminated with ${r.terminatedBy}`})`);
      if (deadline) throw new Error(`codex run exceeded ${request.timeoutMs}ms and was terminated with ${r.terminatedBy}`);
      const headAfter = await headOf(request.workdir);
      if (headAfter !== headBefore) throw new Error(`codex changed git history inside the worktree (${headBefore.slice(0, 10)} -> ${headAfter.slice(0, 10)}); the run is rejected`);
      if (r.exitCode !== 0) throw new Error(`codex exited with ${r.exitCode ?? r.signal}: ${redact(r.stderr.trim().split('\n').slice(-5).join(' | ')).slice(0, 400)}`);

      const parsed = parseCodexEvents(r.stdout);
      return { text: parsed.text.slice(0, 2_000), finishReason: 'stop', steps: [{ content: parsed.tools.map((t) => ({ type: 'tool-call', toolName: t.name })) }], usage: parsed.usage };
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  };

  return {
    get provider() {
      return descriptor;
    },
    probe,
    generate,
  } as WorkerProvider;
}

/** Registry entry. Registered by default so it can be surveyed; it runs a task only when that task explicitly names `codex`. */
export function codexEntry(config: CodexConfig = {}): ProviderEntry {
  return {
    id: 'codex',
    describe: () => codexDescriptor(config),
    probe: () => probeCodex(config).then(({ state, detail, version }) => ({ state, detail, version })),
    create: () => createCodexProvider(config),
  };
}

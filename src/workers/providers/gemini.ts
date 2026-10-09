import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runControlledCommand } from '../tools/execution-tools.ts';
import { redact } from '../../runtime/execution/coding-task-trace.ts';
import type { WorkerLike } from '../../runtime/execution/coding-task-runner.ts';
import type { ProviderAvailability, ProviderDescriptor, ProviderRequest, RawUsage } from '../../runtime/execution/worker-provider.ts';
import { probeCli, type CliProbeResult } from './cli-probe.ts';
import { runProviderProcess, type ProviderProcessResult } from './process.ts';
import type { WorkerProvider } from './provider.ts';
import type { ProviderEntry } from './registry.ts';

/**
 * Google Gemini CLI as an OPTIONAL coding worker (`gemini -p`, headless). Like Codex it is a cloud agent that edits the
 * isolated worktree with its own tools, so the safety case is enforced from outside. It does NOT have Codex's controls
 * (`--cd`, `--ignore-user-config`, a prompt marker for stdin), so what replaces them is spelled out here:
 *
 *  1. Containment. `--sandbox` is the macOS Seatbelt profile `permissive-open`: writes are confined to the process working
 *     directory (the task worktree) plus its own temp/cache dirs. That is the only sandbox this adapter accepts: on any other
 *     platform, or if `sandbox-exec` does not run, the provider is unavailable and nothing starts (fail closed).
 *  2. Approvals. `--approval-mode auto_edit` (never `yolo`, never `default`). Headless mode cannot ask, so every tool that would
 *     ask is denied; auto_edit lets the file-edit tools through. But auto_edit ALSO auto-allows `web_fetch` and the default
 *     policy allows `google_web_search`, so the adapter adds a run-private ADMIN policy (the highest tier, which user policy
 *     files cannot override) that denies everything except the file tools.
 *  3. Isolation from the operator's configuration (what Codex's `--ignore-user-config` does). The CLI has no such flag, and its
 *     SYSTEM settings file, the only layer above user settings, is ignored unless its directory is owned by root, which a
 *     per-run file can never be (observed on 0.63.0: "Skipping system settings file ... not owned by root"). So the run gets a
 *     private GEMINI_CLI_HOME: the operator's ~/.gemini (settings, hooks, MCP servers, extensions, user policies, GEMINI.md, cached
 *     sign-in) is never read, and the settings file inside that home is the only user-level configuration there is. It carries
 *     `tools.core` as an allowlist, hooks off, no usage statistics, `advanced.ignoreLocalEnv` (otherwise the CLI walks UP from the
 *     worktree and loads the first `.env` it finds, e.g. the project's own), and a turn limit.
 *  4. Scope. The CLI cannot express "only these files" either, so the runner's filesystem comparison remains the authority:
 *     any change outside `allowedFiles` is a forbidden mutation, the tree is restored and the task fails.
 *  5. Bounded cost. At most 2 coding attempts and NO automatic runtime retry (every call is billed); cancel, timeout and the
 *     per-call deadline terminate the CLI's whole process group (SIGTERM, then SIGKILL). There is no fallback to any other provider.
 *
 * Credentials: the child gets an allowlisted environment (process.ts) plus only the credential variables the operator names
 * in `passEnv`, and only names from GEMINI_PASSABLE_ENV are accepted. Authentication is therefore an API key (or Vertex
 * variables) in the environment: with the private home there is no cached OAuth sign-in to find, and the Seatbelt profile would
 * deny reading it anyway. Probing makes no request and says sign-in is unchecked: the CLI has no status command.
 *
 * Nothing here runs a model unless the runtime calls `generate`; `probe` makes no model request (it runs `--version`,
 * `--help` and a no-op `sandbox-exec`).
 */

/** Checked against `gemini --help` of gemini-cli 0.63.0. Each is a control this adapter relies on; a missing one means no run. */
export const GEMINI_REQUIRED_FLAGS = ['--prompt', '--sandbox', '--approval-mode', '--output-format', '--admin-policy', '--allowed-mcp-server-names', '--skip-trust'] as const;

/** Only these parent variables may be forwarded. No variable that selects the sandbox, a settings file, a home or a base URL is on the list. */
export const GEMINI_PASSABLE_ENV = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'] as const;

/** The only built-in tools a run may use. Everything else (shell, web fetch/search, MCP, skills, sub-agents) is denied twice. */
export const GEMINI_ALLOWED_TOOLS = ['read_file', 'read_many_files', 'glob', 'grep_search', 'list_directory', 'write_file', 'replace'] as const;
const READ_TOOLS = ['read_file', 'read_many_files', 'glob', 'grep_search', 'list_directory'];
const EDIT_TOOLS = ['write_file', 'replace'];

/** Upper bound on model/tool turns in one invocation (the CLI exits 53 beyond it). */
export const GEMINI_MAX_TURNS = 25;
/**
 * Inside the sandbox the CLI relaunches itself and moves the stdin prompt onto the child's ARGV, so the prompt is visible in the
 * process list and bounded by the OS argument limits. A prompt larger than this is refused rather than risk a truncated task.
 */
export const GEMINI_MAX_PROMPT_BYTES = 100_000;

/** The only switches a run may carry. Anything else (--yolo, --worktree, --include-directories, --extensions, --policy, ...) is refused. */
const ALLOWED_FLAGS = new Set(['--prompt', '--sandbox', '--approval-mode', '--admin-policy', '--allowed-mcp-server-names', '--output-format', '--skip-trust', '--model']);
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** An MCP server name nothing is configured under: `--allowed-mcp-server-names` then admits no server at all. */
const NO_MCP_SERVER = 'agentic-no-mcp-servers';
const PROMPT_STUB = 'Complete the task described above by editing the allowed files, then stop.';

export interface GeminiConfig {
  /** Binary to run (default `gemini`). */
  command?: string;
  /** Model passed with --model; omitted when unset (the CLI default is then used; the model it reports is recorded, else UNKNOWN). */
  model?: string;
  /** Parent environment variable NAMES forwarded to the CLI, from GEMINI_PASSABLE_ENV only (e.g. GEMINI_API_KEY). */
  passEnv?: readonly string[];
  /** Fixed variables for the CLI process (tests). */
  env?: Record<string, string>;
  parentEnv?: NodeJS.ProcessEnv;
  termGraceMs?: number;
  /** Platform whose sandbox is required (default: this one). Only `darwin` (Seatbelt) is supported. */
  platform?: NodeJS.Platform;
  /** Directory for the run-private settings/policy files (default: the OS temp dir). Never inside the worktree. */
  configRoot?: string;
  /** Receives the pid/process group of every CLI process this provider starts (for owner-side accounting and cleanup). */
  onProcess?: (info: { pid: number; exited: Promise<void> }) => void;
}

function checkPassEnv(passEnv: readonly string[] = []): void {
  const bad = passEnv.filter((n) => !(GEMINI_PASSABLE_ENV as readonly string[]).includes(n));
  if (bad.length > 0) throw new Error(`gemini provider: refusing to forward ${bad.join(', ')}; only ${GEMINI_PASSABLE_ENV.join(', ')} may be passed (anything that selects the sandbox, settings, home or endpoint would weaken the run)`);
}

/**
 * The exact argv for a run; the prompt is NOT in it except for a fixed one-line stub (the task goes on stdin). Throws if
 * anything in it would weaken containment. The working directory is the process cwd (the CLI has no `--cd`), set by the caller.
 */
export function buildGeminiArgs(options: { policyDir: string; model?: string }): string[] {
  if (options.model !== undefined && !MODEL_NAME.test(options.model)) throw new Error(`refusing to build a Gemini command with model "${options.model}": not a plain model name`);
  const args = [
    '--prompt', PROMPT_STUB,
    '--sandbox',
    // Trusts THIS working directory for the session. A headless run cannot answer the trust dialog, and an untrusted workspace
    // loses auto-approval of edits. Safe here because the directory is a runtime-made worktree vetted by `vetWorkspace`, and the
    // home it runs with is private (no trusted-folder list, no user settings to be unlocked by the trust).
    '--skip-trust',
    '--approval-mode', 'auto_edit',
    '--admin-policy', options.policyDir,
    '--allowed-mcp-server-names', NO_MCP_SERVER,
    '--output-format', 'stream-json',
    ...(options.model ? ['--model', options.model] : []),
  ];
  assertSafeGeminiArgs(args);
  return args;
}

/** Allowlist, not denylist: every switch must be one of ALLOWED_FLAGS and the approval mode must be exactly auto_edit. Values (paths) are not judged. */
export function assertSafeGeminiArgs(args: readonly string[]): void {
  const bad = args.find((a) => a.startsWith('-') && !ALLOWED_FLAGS.has(a));
  if (bad) throw new Error(`refusing to build a Gemini command containing "${bad}": it would weaken the sandbox`);
  const mode = args[args.indexOf('--approval-mode') + 1];
  if (!args.includes('--sandbox') || mode !== 'auto_edit') throw new Error(`refusing to build a Gemini command with approval mode "${mode}" or without --sandbox: it would weaken the sandbox`);
}

/**
 * The run-private USER settings file, `<GEMINI_CLI_HOME>/.gemini/settings.json`. It is the only user-level configuration the run
 * sees (the operator's own is never loaded: different home). The one layer above it that could loosen it is the worktree's
 * `.gemini/settings.json`, and `vetWorkspace` refuses a worktree that has one.
 */
export function buildGeminiRunSettings(): Record<string, unknown> {
  return {
    general: { defaultApprovalMode: 'auto_edit' },
    tools: { core: [...GEMINI_ALLOWED_TOOLS], sandbox: true },
    security: { disableYoloMode: true, disableAlwaysAllow: true, enablePermanentToolApproval: false },
    // Without this the CLI loads the first `.env` found walking UP from the worktree, with credentials and endpoints in it.
    advanced: { ignoreLocalEnv: true },
    model: { maxSessionTurns: GEMINI_MAX_TURNS },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    hooksConfig: { enabled: false },
    skills: { enabled: false },
  };
}

/** Run-private ADMIN policy: deny every tool, then allow only the file tools. Admin outranks user, extension and default rules. */
export function buildGeminiAdminPolicy(): string {
  return [
    '# Generated per run by the agentic-engineering Gemini adapter. Do not edit.',
    '[[rule]]',
    'toolName = "*"',
    'decision = "deny"',
    'priority = 100',
    'denyMessage = "This runtime only permits the file read and edit tools."',
    '',
    '[[rule]]',
    `toolName = [${READ_TOOLS.map((t) => `"${t}"`).join(', ')}]`,
    'decision = "allow"',
    'priority = 200',
    '',
    '[[rule]]',
    `toolName = [${EDIT_TOOLS.map((t) => `"${t}"`).join(', ')}]`,
    'decision = "allow"',
    'priority = 200',
    'modes = ["autoEdit"]',
    '',
  ].join('\n');
}

/**
 * Project-level Gemini configuration is loaded from the working directory (`.gemini/` settings, hooks, MCP servers, commands, skills,
 * policies, sandbox profiles; `.env` variables). With folder trust off, a worktree carrying any of it would be trusted. Refuse instead.
 */
export function vetWorkspace(workdir: string): string | undefined {
  for (const name of ['.gemini', '.env']) {
    try {
      lstatSync(join(workdir, name)); // lstat: a dangling symlink counts too
    } catch {
      continue;
    }
    return `the worktree contains ${name}, which the Gemini CLI would load as project configuration; refusing to run`;
  }
  return undefined;
}

const PREAMBLE = (r: ProviderRequest) =>
  [
    'You are a coding worker inside a runtime that verifies your result independently.',
    `Work only in the current directory. Modify ONLY these files: ${r.allowedFiles.join(', ')}. Any other change fails the task.`,
    'Use only the file tools (read_file, read_many_files, glob, grep_search, list_directory, write_file, replace). Shell commands and network access are not available.',
    'Make the change in the files directly, then stop. The runtime formats and runs the tests itself.',
  ].join('\n');

interface Parsed {
  text: string;
  usage?: RawUsage;
  model?: string;
  tools: { name: string; ok?: boolean }[];
  /** A `result` event with status "error": the CLI itself reported the run as failed. */
  error?: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const toolLabel = (name: string) => (name === 'run_shell_command' ? 'shell' : name === 'write_file' || name === 'replace' ? 'applyPatch' : name);

/** Tolerant reader for `--output-format stream-json` lines. Unknown shapes are ignored; nothing it reads can decide PASS. */
export function parseGeminiEvents(stdout: string): Parsed {
  const out: Parsed = { text: '', tools: [] };
  const plain: string[] = [];
  const names = new Map<string, number>();
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
    switch (ev?.type) {
      case 'init':
        if (typeof ev.model === 'string' && MODEL_NAME.test(ev.model)) out.model = ev.model;
        break;
      case 'message':
        if (ev.role === 'assistant' && typeof ev.content === 'string') out.text = ev.delta ? out.text + ev.content : ev.content;
        break;
      case 'tool_use':
        if (typeof ev.tool_name === 'string') {
          names.set(String(ev.tool_id), out.tools.length);
          out.tools.push({ name: toolLabel(ev.tool_name) });
        }
        break;
      case 'tool_result': {
        const i = names.get(String(ev.tool_id));
        if (i !== undefined) out.tools[i].ok = ev.status === 'success';
        break;
      }
      case 'result':
        if (ev.stats && typeof ev.stats === 'object') out.usage = { inputTokens: num(ev.stats.input_tokens), outputTokens: num(ev.stats.output_tokens) };
        if (ev.status === 'error') out.error = typeof ev.error?.message === 'string' ? ev.error.message : 'the CLI reported an error';
        break;
    }
  }
  if (!out.text && plain.length) out.text = plain.slice(-5).join('\n');
  return out;
}

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

/** Exit statuses the CLI documents (headless.md) or defines, by name, for error messages. */
const EXIT_MEANING: Record<number, string> = { 1: 'general error or API failure', 41: 'authentication failed', 42: 'input error', 52: 'configuration error', 53: 'turn limit exceeded', 54: 'tool execution failed', 55: 'untrusted workspace' };

export function geminiDescriptor(config: GeminiConfig = {}, cliVersion?: string): ProviderDescriptor {
  return {
    identity: { id: 'gemini', kind: 'cloud', model: config.model ?? 'UNKNOWN', ...(cliVersion ? { cliVersion } : {}) },
    capabilities: { taskTypes: ['go', 'js'], editsFiles: 'directly', fileScope: 'os-sandbox', cancellation: 'process-group', usage: 'tokens', billing: 'unknown' },
    capacity: { resource: 'gemini', defaultPermits: 1 },
    limits: { maxRuntimeRetries: 0, maxCodingAttempts: 2 },
  };
}

/** The sandbox the adapter requires must actually run here: macOS Seatbelt, checked with a no-op profile (local, free, no model). */
async function probeSandbox(config: GeminiConfig, cwd: string): Promise<{ ok: boolean; detail: string }> {
  const platform = config.platform ?? process.platform;
  if (platform !== 'darwin') return { ok: false, detail: `the Gemini adapter only accepts macOS Seatbelt as its sandbox; on ${platform} it refuses to run rather than run unconfined` };
  const r = await runProviderProcess({ command: 'sandbox-exec', args: ['-p', '(version 1)(allow default)', 'true'], cwd, timeoutMs: 10_000, termGraceMs: 500, killWaitMs: 1_000, parentEnv: config.parentEnv });
  if (r.spawnError || r.exitCode !== 0) return { ok: false, detail: 'macOS sandbox-exec is not usable here; the Gemini adapter refuses to run without its sandbox' };
  return { ok: true, detail: 'Seatbelt sandbox-exec works' };
}

export async function probeGemini(config: GeminiConfig = {}, cwd = process.cwd()): Promise<CliProbeResult> {
  try {
    checkPassEnv(config.passEnv);
  } catch (err) {
    return { state: 'unavailable', detail: (err as Error).message, missingFlags: [], advertises: () => false };
  }
  const base = await probeCli({
    command: config.command ?? 'gemini',
    cwd,
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    requiredFlags: GEMINI_REQUIRED_FLAGS,
    // `gemini` has no sign-in status command: auth cannot be checked without a model request, so it is reported as unchecked.
    parentEnv: config.parentEnv,
    passEnv: config.passEnv,
    env: config.env,
  });
  if (base.state !== 'available') return base;
  const sandbox = await probeSandbox(config, cwd);
  if (!sandbox.ok) return { ...base, state: 'unavailable', detail: sandbox.detail };
  return { ...base, detail: `${base.detail}; ${sandbox.detail}` };
}

export function createGeminiProvider(config: GeminiConfig = {}): WorkerProvider {
  checkPassEnv(config.passEnv);
  const command = config.command ?? 'gemini';
  const descriptor = geminiDescriptor(config);
  let probed: CliProbeResult | undefined;
  const probe = async (cwd = process.cwd()): Promise<ProviderAvailability> => {
    probed = await probeGemini(config, cwd);
    // Updated in place: the runner holds this very object and reads the model/version from it after the call.
    if (probed.version) descriptor.identity.cliVersion = probed.version;
    return { state: probed.state, detail: probed.detail, version: probed.version };
  };

  const generate: WorkerLike['generate'] = async (prompt, options) => {
    const request = options.providerRequest as ProviderRequest | undefined;
    if (!request?.workdir) throw new Error('gemini provider: no providerRequest; refusing to run without an isolated working directory and file scope');
    if (!descriptor.capabilities.taskTypes.includes(request.taskType)) throw new Error(`gemini provider is not cleared for ${request.taskType} tasks`);
    const signal = options.abortSignal as AbortSignal | undefined;

    const stdin = `${PREAMBLE(request)}\n\n${prompt}`;
    if (Buffer.byteLength(stdin) > GEMINI_MAX_PROMPT_BYTES) throw new Error(`gemini provider: the prompt is ${Buffer.byteLength(stdin)} bytes; the sandboxed CLI carries it on its argv, so more than ${GEMINI_MAX_PROMPT_BYTES} is refused`);
    const unsafe = vetWorkspace(request.workdir);
    if (unsafe) throw new Error(`gemini provider: ${unsafe}`);

    // Fail closed, against the installed binary and the sandbox (probed once per provider instance, again if the previous probe failed).
    if (probed?.state !== 'available') {
      const a = await probe(request.workdir);
      if (a.state !== 'available') throw new Error(`gemini provider unavailable (${a.state}): ${a.detail}`);
    }

    // Run-private home and policy, outside the worktree, removed when the call is over (and the CLI confirmed gone).
    const configDir = mkdtempSync(join(config.configRoot ?? tmpdir(), 'agentic-gemini-'));
    try {
      const policyDir = join(configDir, 'policy');
      mkdirSync(policyDir, { mode: 0o700 });
      writeFileSync(join(policyDir, 'agentic.toml'), buildGeminiAdminPolicy(), { mode: 0o600 });
      const geminiHome = join(configDir, 'home');
      mkdirSync(join(geminiHome, '.gemini'), { recursive: true, mode: 0o700 });
      writeFileSync(join(geminiHome, '.gemini', 'settings.json'), JSON.stringify(buildGeminiRunSettings(), null, 2), { mode: 0o600 });
      const args = buildGeminiArgs({ policyDir, model: config.model });

      const headBefore = await headOf(request.workdir);
      const r: ProviderProcessResult = await runProviderProcess({
        command,
        args,
        stdin,
        cwd: request.workdir, // the CLI has no --cd: its working directory IS the sandbox's writable root
        timeoutMs: request.timeoutMs,
        signal,
        passEnv: config.passEnv,
        // Fixed last, so nothing in `config.env` can displace them. NO_BROWSER: a headless run must never open an OAuth browser flow.
        env: { ...config.env, GEMINI_CLI_HOME: geminiHome, SEATBELT_PROFILE: 'permissive-open', NO_BROWSER: '1', GEMINI_TELEMETRY_ENABLED: 'false' },
        parentEnv: config.parentEnv,
        termGraceMs: config.termGraceMs,
        onProcess: config.onProcess,
      });

      if (r.stillRunning && r.pid) {
        // The CLI could not be confirmed dead. Do not report the call as over: stay pending until the group is gone, so the
        // runner (which bounds how long it waits for an aborted call) keeps this provider's capacity permit held meanwhile.
        while (groupAlive(r.pid)) await new Promise((res) => setTimeout(res, 500));
      }
      if (r.spawnError) throw new Error(`gemini could not be started: ${r.spawnError}`);
      // The call's signal carries the per-call deadline too: tell a deadline from a cancel, they are different events.
      const deadline = r.timedOut || (r.aborted && (signal?.reason as { name?: string } | undefined)?.name === 'TimeoutError');
      if (r.aborted && !deadline) throw new Error(`gemini run cancelled (${r.terminatedBy === 'exit' ? 'exited' : `terminated with ${r.terminatedBy}`})`);
      if (deadline) throw new Error(`gemini run exceeded ${request.timeoutMs}ms and was terminated with ${r.terminatedBy}`);
      const headAfter = await headOf(request.workdir);
      if (headAfter !== headBefore) throw new Error(`gemini changed git history inside the worktree (${headBefore.slice(0, 10)} -> ${headAfter.slice(0, 10)}); the run is rejected`);
      const parsed = parseGeminiEvents(r.stdout);
      if (r.exitCode !== 0) {
        const meaning = r.exitCode !== null && EXIT_MEANING[r.exitCode] ? ` (${EXIT_MEANING[r.exitCode]})` : '';
        throw new Error(`gemini exited with ${r.exitCode ?? r.signal}${meaning}: ${redact((parsed.error ?? r.stderr).trim().split('\n').slice(-5).join(' | ')).slice(0, 400)}`);
      }
      if (parsed.error) throw new Error(`gemini reported an error: ${redact(parsed.error).slice(0, 400)}`);

      if (parsed.model && !config.model) descriptor.identity.model = parsed.model;
      return { text: parsed.text.slice(0, 2_000), finishReason: 'stop', steps: [{ content: parsed.tools.map((t) => ({ type: 'tool-call', toolName: t.name })) }], usage: parsed.usage };
    } finally {
      rmSync(configDir, { recursive: true, force: true });
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

/** Registry entry. Registered by default so it can be surveyed; it runs a task only when that task explicitly names `gemini`. */
export function geminiEntry(config: GeminiConfig = {}): ProviderEntry {
  return {
    id: 'gemini',
    describe: () => geminiDescriptor(config),
    probe: () => probeGemini(config).then(({ state, detail, version }) => ({ state, detail, version })),
    create: () => createGeminiProvider(config),
  };
}

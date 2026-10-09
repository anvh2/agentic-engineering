import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ModelCapacity } from '../../runtime/capacity/model-capacity.ts';
import { runCodingTask } from '../../runtime/execution/coding-task-runner.ts';
import { UNKNOWN } from '../../runtime/execution/worker-provider.ts';
import { makeRepo, tempDir } from '../../runtime/scheduler/test-helpers.ts';
import { defaultProviderRegistry } from './default.ts';
import {
  GEMINI_ALLOWED_TOOLS,
  GEMINI_MAX_PROMPT_BYTES,
  GEMINI_MAX_TURNS,
  GEMINI_REQUIRED_FLAGS,
  assertSafeGeminiArgs,
  buildGeminiAdminPolicy,
  buildGeminiArgs,
  buildGeminiRunSettings,
  createGeminiProvider,
  parseGeminiEvents,
  probeGemini,
  vetWorkspace,
  type GeminiConfig,
} from './gemini.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '__testing__', 'fake-gemini.mjs');
const files = { 'src/x.js': 'module.exports = 0;\n' };
const task = { taskId: 'x', objective: 'make x return 1', allowedFiles: ['src/x.js'], contextFiles: [], verificationCommands: [['true']] };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Rec = { args?: string[]; cwd?: string; envKeys?: string[]; stdinBytes?: number; stdinHead?: string; geminiHome?: string; settings?: any; settingsPath?: string; homeInsideCwd?: boolean; systemSettingsEnvSet?: boolean; policy?: Record<string, string> | null; fixedEnv?: Record<string, string | null> };

function fake(env: Record<string, string> = {}, extra: Partial<GeminiConfig> = {}) {
  const dir = tempDir('gemini-fake-');
  const log = join(dir, 'calls.jsonl');
  const config: GeminiConfig = { command: FAKE, env: { FAKE_LOG: log, ...env }, termGraceMs: 200, ...extra };
  const records = () => (existsSync(log) ? (readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) as Rec[]) : []);
  /** Every invocation that carried `--prompt`, i.e. every billed run (probes only ever see --version / --help). */
  const runs = () => records().filter((r) => r.args?.includes('--prompt'));
  const bodies = () => records().filter((r) => r.stdinBytes !== undefined);
  return { config, records, runs, bodies, dir };
}
const runOnce = (config: GeminiConfig, opts: { signal?: AbortSignal; timeoutMs?: number; repo?: string; task?: typeof task } = {}) => {
  const repo = opts.repo ?? makeRepo(files);
  const provider = createGeminiProvider(config);
  const result = runCodingTask(opts.task ?? task, { repoRoot: repo, worker: provider, capacity: new ModelCapacity(':memory:', { permits: 1 }), signal: opts.signal, modelTimeoutMs: opts.timeoutMs, abortGraceMs: 500, runtimeRetryDelayMs: 1, maxAttempts: 3 });
  return { repo, provider, result };
};

describe('availability probe (no model call)', () => {
  it('available when installed, every required flag is advertised and the sandbox works; sign-in is reported as unchecked', async () => {
    const f = fake();
    const p = await probeGemini(f.config);
    assert.equal(p.state, 'available', p.detail);
    assert.match(p.version ?? '', /0\.0\.0-fake/);
    assert.match(p.detail, /Seatbelt/);
    assert.match(p.detail, /sign-in state could not be checked/);
    assert.deepEqual(f.records().map((r) => r.args?.[0]), ['--version', '--help']);
    assert.equal(f.runs().length, 0, 'the probe never starts a run');
  });

  it('not installed', async () => {
    assert.equal((await probeGemini({ command: '/no/such/gemini' })).state, 'not_installed');
  });

  it('fails closed when the installed version does not advertise a required flag, for each of them', async () => {
    for (const flag of GEMINI_REQUIRED_FLAGS) {
      const p = await probeGemini(fake({ FAKE_HELP_OMIT: flag }).config);
      assert.equal(p.state, 'unsupported_version', flag);
      assert.deepEqual(p.missingFlags, [flag]);
    }
  });

  it('fails closed where the Seatbelt sandbox is not the platform sandbox', async () => {
    const f = fake({}, { platform: 'linux' });
    const p = await probeGemini(f.config);
    assert.equal(p.state, 'unavailable');
    assert.match(p.detail, /only accepts macOS Seatbelt/);
  });

  it('refuses a credential variable that is not on the list, at probe time and at construction', async () => {
    for (const name of ['SANDBOX', 'GEMINI_SANDBOX', 'SEATBELT_PROFILE', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'GEMINI_CLI_HOME', 'GEMINI_CLI_TRUST_WORKSPACE', 'GEMINI_SYSTEM_MD', 'GOOGLE_GEMINI_BASE_URL', 'OPENAI_API_KEY']) {
      const p = await probeGemini(fake({}, { passEnv: [name] }).config);
      assert.equal(p.state, 'unavailable', name);
      assert.match(p.detail, new RegExp(`refusing to forward ${name}`));
      assert.throws(() => createGeminiProvider({ command: FAKE, passEnv: [name] }), /refusing to forward/, name);
    }
  });

  it('the default registry lists gemini as an optional cloud provider; the default stays the local model', () => {
    const r = defaultProviderRegistry();
    assert.deepEqual(r.ids(), ['codex', 'gemini', 'ollama']);
    assert.equal(r.get().id, 'ollama');
    const d = r.get('gemini').describe();
    assert.equal(d.identity.kind, 'cloud');
    assert.deepEqual(d.limits, { maxRuntimeRetries: 0, maxCodingAttempts: 2 });
    assert.deepEqual([d.capabilities.fileScope, d.capabilities.cancellation, d.capabilities.billing, d.identity.model], ['os-sandbox', 'process-group', 'unknown', UNKNOWN]);
  });
});

describe('command and configuration construction', () => {
  it('always uses the Seatbelt sandbox, auto_edit approvals, the admin policy and no MCP server', () => {
    const args = buildGeminiArgs({ policyDir: '/p/dir', model: 'gemini-x-1.5' });
    assert.deepEqual(args, ['--prompt', 'Complete the task described above by editing the allowed files, then stop.', '--sandbox', '--skip-trust', '--approval-mode', 'auto_edit', '--admin-policy', '/p/dir', '--allowed-mcp-server-names', 'agentic-no-mcp-servers', '--output-format', 'stream-json', '--model', 'gemini-x-1.5']);
    assert.ok(!args.some((a) => /yolo|bypass|worktree|include-directories/.test(a)));
  });

  it('flags are an allowlist: any other switch, another approval mode, or a missing --sandbox is refused', () => {
    const good = buildGeminiArgs({ policyDir: '/p' });
    for (const extra of ['--yolo', '-y', '--approval-mode=yolo', '--worktree', '--include-directories', '--extensions', '--policy', '--allowed-tools', '--resume', '--debug', '--acp', '--dangerously-skip-permissions', '--ignore-env']) {
      assert.throws(() => assertSafeGeminiArgs([...good, extra]), /weaken the sandbox/, extra);
    }
    assert.throws(() => assertSafeGeminiArgs(good.map((a) => (a === 'auto_edit' ? 'yolo' : a))), /approval mode "yolo"/);
    assert.throws(() => assertSafeGeminiArgs(good.map((a) => (a === 'auto_edit' ? 'default' : a))), /approval mode "default"/);
    assert.throws(() => assertSafeGeminiArgs(good.filter((a) => a !== '--sandbox')), /without --sandbox/);
  });

  it('refuses a model value that is not a plain name (it could smuggle a flag)', () => {
    for (const bad of ['--yolo', '-y', 'a b', '', 'x;rm', '--skip-trust', 'yolo --x']) assert.throws(() => buildGeminiArgs({ policyDir: '/p', model: bad }), /not a plain model name/, JSON.stringify(bad));
  });

  it('the run settings (the private home\'s user-level file) pin the tool allowlist and switch off what could reach outside', () => {
    const s = buildGeminiRunSettings() as any;
    assert.equal(s.advanced.ignoreLocalEnv, true, 'no .env is loaded from any directory above the worktree');
    assert.deepEqual(s.tools.core, [...GEMINI_ALLOWED_TOOLS]);
    assert.ok(!GEMINI_ALLOWED_TOOLS.some((t) => /shell|web|mcp|skill|agent/.test(t)));
    assert.equal(s.tools.sandbox, true);
    assert.equal(s.general.defaultApprovalMode, 'auto_edit');
    assert.equal(s.security.disableYoloMode, true);
    assert.equal(s.security.disableAlwaysAllow, true);
    assert.equal(s.hooksConfig.enabled, false);
    assert.equal(s.privacy.usageStatisticsEnabled, false);
    assert.equal(s.model.maxSessionTurns, GEMINI_MAX_TURNS);
    assert.equal(s.security.folderTrust, undefined, 'trust is handled by --skip-trust, not by weakening the setting');
  });

  it('switches off, explicitly, every default-off hidden model call and dynamic model chains', () => {
    const s = buildGeminiRunSettings() as any;
    assert.equal(s.tools.disableLLMCorrection, true, 'edit correction would call a flash-lite alias of the CLI\'s choosing');
    assert.equal(s.model.skipNextSpeakerCheck, true, 'the next-speaker check would call a 3.x flash');
    assert.equal(s.experimental.dynamicModelConfiguration, false, 'no settings-defined model chains or fallbacks');
    assert.equal(s.security.auth, undefined, 'no auth type is forced unless a local request guard is used');
  });

  it('a request-guard base URL selects api-key auth in the private settings and reaches the child as the endpoint', async () => {
    const s = buildGeminiRunSettings({ apiBaseUrl: 'http://127.0.0.1:4555' }) as any;
    assert.equal(s.security.auth.selectedType, 'gemini-api-key');
    assert.equal(s.security.disableYoloMode, true, 'the other security settings survive the merge');
    const f = fake({}, { apiBaseUrl: 'http://127.0.0.1:4555' });
    await runOnce(f.config).result;
    const body = f.bodies()[0];
    assert.equal(body.fixedEnv!.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:4555');
    assert.equal(body.settings.security.auth.selectedType, 'gemini-api-key');
  });

  it('the base URL can only be a loopback guard, and cannot be set from config.env or passEnv', async () => {
    for (const bad of ['https://generativelanguage.googleapis.com', 'http://localhost:4555', 'http://127.0.0.1', 'http://127.0.0.1:4555/v1beta', 'http://10.0.0.1:4555', 'http://127.0.0.1.evil.example:4555']) {
      assert.throws(() => createGeminiProvider({ command: FAKE, apiBaseUrl: bad }), /apiBaseUrl must be http:\/\/127\.0\.0\.1/, bad);
      assert.equal((await probeGemini(fake({}, { apiBaseUrl: bad }).config)).state, 'unavailable', bad);
    }
    assert.throws(() => createGeminiProvider({ command: FAKE, passEnv: ['GOOGLE_GEMINI_BASE_URL'] }), /refusing to forward/);
  });

  it('the exact model id is passed through unchanged, with no alias in the command', () => {
    const args = buildGeminiArgs({ policyDir: '/p', model: 'gemini-2.5-flash-lite' });
    assert.equal(args[args.indexOf('--model') + 1], 'gemini-2.5-flash-lite');
    assert.equal(args.filter((a) => a === '--model').length, 1);
  });

  it('turn and per-request output-token ceilings reach the private settings, attached to the exact model', () => {
    const s = buildGeminiRunSettings({ maxTurns: 8, maxOutputTokens: 16_384, model: 'gemini-3.8-flash' }) as any;
    assert.equal(s.model.maxSessionTurns, 8);
    assert.deepEqual(s.modelConfigs, { overrides: [{ match: { model: 'gemini-3.8-flash' }, modelConfig: { generateContentConfig: { maxOutputTokens: 16_384 } } }] });
    assert.equal((buildGeminiRunSettings() as any).modelConfigs, undefined, 'no ceiling is invented when none is configured');
    assert.equal((buildGeminiRunSettings() as any).model.maxSessionTurns, GEMINI_MAX_TURNS);
  });

  it('invalid ceilings are refused at construction and make the provider unavailable', async () => {
    for (const bad of [{ maxTurns: 0 }, { maxTurns: GEMINI_MAX_TURNS + 1 }, { maxTurns: 1.5 }, { maxOutputTokens: 100, model: 'm' }, { maxOutputTokens: 4096 }]) {
      assert.throws(() => createGeminiProvider({ command: FAKE, ...bad }), /gemini provider:/, JSON.stringify(bad));
      assert.equal((await probeGemini(fake({}, bad).config)).state, 'unavailable', JSON.stringify(bad));
    }
  });

  it('the admin policy denies everything first and then allows only the file tools', () => {
    const toml = buildGeminiAdminPolicy();
    const rules = toml.split('[[rule]]').slice(1);
    assert.equal(rules.length, 3);
    assert.match(rules[0], /toolName = "\*"[\s\S]*decision = "deny"[\s\S]*priority = 100/);
    assert.ok(rules.slice(1).every((r) => /decision = "allow"/.test(r) && /priority = 200/.test(r)));
    assert.ok(!/run_shell_command|web_fetch|google_web_search|mcp/.test(toml.replace(/"mcp"/g, '')), 'no rule names a dangerous tool');
    assert.match(rules[2], /write_file/);
    assert.match(rules[2], /modes = \["autoEdit"\]/);
  });

  it('a worktree carrying project-level Gemini configuration is refused', () => {
    assert.equal(vetWorkspace(makeRepo(files)), undefined);
    assert.match(vetWorkspace(makeRepo({ ...files, '.gemini/settings.json': '{}' })) ?? '', /\.gemini/);
    assert.match(vetWorkspace(makeRepo({ ...files, '.env': 'GOOGLE_GEMINI_BASE_URL=https://evil.example\n' })) ?? '', /\.env/);
    const dangling = makeRepo(files);
    symlinkSync('/no/such/target', join(dangling, '.gemini'));
    assert.match(vetWorkspace(dangling) ?? '', /\.gemini/, 'a dangling symlink counts');
  });
});

describe('end to end through the runner (mock CLI)', () => {
  it('edits inside the worktree, the RUNTIME verifies, usage and the reported model are recorded, cost and quota stay UNKNOWN', async () => {
    const f = fake();
    const { repo, result } = runOnce(f.config);
    const r = await result;
    assert.equal(r.verdict, 'PASS');
    assert.equal(readFileSync(join(repo, 'src/x.js'), 'utf8'), 'module.exports = 1;\n');
    const t = r.records[0].telemetry!;
    assert.deepEqual([t.provider, t.model], ['gemini', 'gemini-fake-pro'], 'the model the CLI itself reported');
    assert.deepEqual(t.usage, { inputTokens: 120, outputTokens: 34, costUsd: UNKNOWN, quota: UNKNOWN });
    assert.deepEqual(r.records[0].toolCalls.map((c) => c.name), ['applyPatch', 'shell']);

    const run = f.runs()[0];
    assert.equal(realpathSync(run.cwd!), realpathSync(repo), 'the CLI has no --cd: the worktree is its working directory');
    assert.ok(run.args!.includes('--sandbox') && run.args!.includes('auto_edit') && run.args!.includes('--admin-policy'));
    assert.ok(run.args!.includes('--skip-trust'), 'a headless run cannot answer the trust dialog; the worktree was vetted instead');
    assert.ok(!run.args!.some((a) => /dangerous|yolo|bypass|full-auto|worktree|include-directories|extensions/.test(a)));
    assert.ok(!run.args!.some((a) => a.includes('PREAMBLE') || a.length > 120), 'the task is on stdin, not argv');
    const body = f.bodies()[0];
    assert.ok(body.stdinBytes! > 100 && /coding worker inside a runtime/.test(body.stdinHead!), 'the prompt arrived on stdin');
    assert.deepEqual(body.fixedEnv, { SEATBELT_PROFILE: 'permissive-open', NO_BROWSER: '1', GEMINI_TELEMETRY_ENABLED: 'false', GOOGLE_GEMINI_BASE_URL: null });
  });

  it('hands the CLI a run-private home (its only settings) and policy outside the worktree, and removes them afterwards', async () => {
    const f = fake();
    const { repo, result } = runOnce(f.config);
    await result;
    const body = f.bodies()[0];
    assert.equal(body.homeInsideCwd, false);
    assert.equal(body.systemSettingsEnvSet, false, 'the system-settings path is not used: the CLI ignores it unless root owns its directory');
    assert.equal(body.settingsPath, join(body.geminiHome!, '.gemini', 'settings.json'));
    assert.deepEqual(body.settings, JSON.parse(JSON.stringify(buildGeminiRunSettings())));
    assert.deepEqual(Object.keys(body.policy!), ['agentic.toml']);
    assert.equal(body.policy!['agentic.toml'], buildGeminiAdminPolicy());
    assert.notEqual(body.geminiHome, process.env.HOME, "never the operator's home");
    assert.equal(existsSync(body.settingsPath!), false, 'the settings file is gone');
    assert.equal(existsSync(body.geminiHome!), false, 'and so is the private home');
    assert.equal(existsSync(join(repo, '.gemini')), false, 'nothing was written into the worktree');
  });

  it('configured ceilings arrive in the private settings the CLI is handed', async () => {
    const f = fake({}, { model: 'gemini-pinned', maxTurns: 6, maxOutputTokens: 8_192 });
    await runOnce(f.config).result;
    const body = f.bodies()[0];
    assert.equal(body.settings.model.maxSessionTurns, 6);
    assert.equal(body.settings.modelConfigs.overrides[0].match.model, 'gemini-pinned');
    assert.equal(body.settings.modelConfigs.overrides[0].modelConfig.generateContentConfig.maxOutputTokens, 8_192);
  });

  it('a configured model is passed and used as the label; the CLI-reported one does not override it', async () => {
    const f = fake({}, { model: 'gemini-pinned' });
    const r = await runOnce(f.config).result;
    assert.equal(r.records[0].telemetry!.model, 'gemini-pinned');
    const args = f.runs()[0].args!;
    assert.equal(args[args.indexOf('--model') + 1], 'gemini-pinned');
  });

  it('a change outside the allowed files is a forbidden mutation, whatever the sandbox allowed', async () => {
    const f = fake({ FAKE_MODE: 'edit-and-forbid' });
    const r = await runOnce(f.config).result;
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.failureCategory, 'D_forbidden_mutation');
    assert.deepEqual(r.forbiddenFilesChanged, ['README.md']);
  });

  it('a CLI that rewrites git history is rejected', async () => {
    const f = fake({ FAKE_MODE: 'commit' });
    const r = await runOnce(f.config).result;
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.runtimeFailed, true);
    assert.match(r.records[0].runtimeError ?? '', /changed git history/);
  });

  it('no automatic runtime retry: a failing paid call is made once, and its secrets are redacted', async () => {
    const f = fake({ FAKE_MODE: 'fail' });
    const r = await runOnce(f.config).result;
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.runtimeRetries, 0);
    assert.equal(f.runs().length, 1, 'exactly one billed invocation');
    assert.match(r.records[0].runtimeError ?? '', /exited with 1/);
    assert.doesNotMatch(r.records[0].runtimeError ?? '', /sk-abcdefghijklmnop1234/);
  });

  it('names the CLI exit status (authentication) and does not retry it', async () => {
    const f = fake({ FAKE_MODE: 'auth' });
    const r = await runOnce(f.config).result;
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.records[0].runtimeError ?? '', /exited with 41 \(authentication failed\)/);
    assert.equal(f.runs().length, 1);
  });

  it('a result event with status "error" fails the call even with exit 0, and is redacted', async () => {
    const f = fake({ FAKE_MODE: 'error-result' });
    const r = await runOnce(f.config).result;
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.runtimeFailed, true);
    assert.match(r.records[0].runtimeError ?? '', /gemini reported an error/);
    assert.doesNotMatch(r.records[0].runtimeError ?? '', /sk-abcdefghijklmnop1234/);
  });

  it('a verifier failure retries at most once more (2 attempts total), never 3, and never on another provider', async () => {
    const f = fake();
    const repo = makeRepo(files);
    const r = await runCodingTask({ ...task, verificationCommands: [['false']] }, { repoRoot: repo, worker: createGeminiProvider(f.config), capacity: new ModelCapacity(':memory:', { permits: 1 }), maxAttempts: 3 });
    assert.equal(r.attempts, 2);
    assert.equal(f.runs().length, 2);
  });

  it('is unusable (and runs nothing) when a safety flag is missing, the sandbox is unavailable or a worktree has project config', async () => {
    const cases: [GeminiConfig, Record<string, string>, string?][] = [
      [{}, { FAKE_HELP_OMIT: '--admin-policy' }],
      [{}, { FAKE_HELP_OMIT: '--sandbox' }],
      [{ platform: 'linux' }, {}],
    ];
    for (const [extra, env] of cases) {
      const f = fake(env, extra);
      const r = await runOnce(f.config).result;
      assert.equal(r.verdict, 'FAIL');
      assert.match(r.records[0].runtimeError ?? '', /unavailable/);
      assert.equal(f.runs().length, 0, 'no run was started');
    }
    const f = fake();
    const r = await runOnce(f.config, { repo: makeRepo({ ...files, '.gemini/settings.json': '{"mcpServers":{}}' }) }).result;
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.records[0].runtimeError ?? '', /\.gemini/);
    assert.equal(f.runs().length, 0);
  });

  it('refuses a prompt too large to carry safely on the sandboxed CLI argv', async () => {
    const f = fake();
    const r = await runOnce(f.config, { task: { ...task, objective: 'x'.repeat(GEMINI_MAX_PROMPT_BYTES + 1_000) } }).result;
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.records[0].runtimeError ?? '', /bytes; the sandboxed CLI carries it on its argv/);
    assert.equal(f.runs().length, 0);
  });

  it('garbage output with a clean exit yields UNKNOWN usage and model, not a fabricated one', async () => {
    const f = fake({ FAKE_MODE: 'garbage' });
    const r = await runOnce(f.config).result;
    assert.deepEqual(r.records[0].telemetry!.usage.inputTokens, UNKNOWN);
    assert.equal(r.records[0].telemetry!.model, UNKNOWN);
  });

  it('the child sees an allowlisted environment: no ambient credentials, no sandbox-selecting variable; only named keys pass', async () => {
    const saved = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_API_KEY: process.env.GOOGLE_API_KEY, SANDBOX: process.env.SANDBOX, GEMINI_SANDBOX: process.env.GEMINI_SANDBOX, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
    Object.assign(process.env, { GEMINI_API_KEY: 'k-should-not-reach-child-unless-named', GOOGLE_API_KEY: 'k2', SANDBOX: 'sandbox-exec', GEMINI_SANDBOX: 'false', OPENAI_API_KEY: 'k3' });
    try {
      const closed = fake();
      await runOnce(closed.config).result;
      const keys = closed.runs()[0].envKeys!;
      for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'SANDBOX', 'GEMINI_SANDBOX', 'OPENAI_API_KEY']) assert.ok(!keys.includes(k), `${k} must not reach the CLI`);
      assert.ok(keys.includes('HOME') && keys.includes('PATH') && keys.includes('GEMINI_CLI_HOME'));
      assert.ok(!keys.includes('GEMINI_CLI_SYSTEM_SETTINGS_PATH'));

      const named = fake({}, { passEnv: ['GEMINI_API_KEY'] });
      await runOnce(named.config).result;
      const withKey = named.runs()[0].envKeys!;
      assert.ok(withKey.includes('GEMINI_API_KEY') && !withKey.includes('GOOGLE_API_KEY'));
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });

  it('nothing in the provider config can displace the fixed variables (private home, sandbox profile, no browser)', async () => {
    const f = fake({ GEMINI_CLI_HOME: '/Users/someone', SEATBELT_PROFILE: 'custom', NO_BROWSER: '' });
    await runOnce(f.config).result;
    const body = f.bodies()[0];
    assert.notEqual(body.geminiHome, '/Users/someone');
    assert.match(body.geminiHome!, /agentic-gemini-/);
    assert.deepEqual(body.fixedEnv, { SEATBELT_PROFILE: 'permissive-open', NO_BROWSER: '1', GEMINI_TELEMETRY_ENABLED: 'false', GOOGLE_GEMINI_BASE_URL: null });
  });
});

describe('cancellation and timeout kill the CLI', () => {
  it('abort terminates a CLI that ignores SIGTERM, with SIGKILL, and nothing is left running or on disk', async () => {
    const pidfile = join(tempDir('gemini-pid-'), 'pid');
    const f = fake({ FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile });
    const c = new AbortController();
    const { result } = runOnce(f.config, { signal: c.signal });
    const end = Date.now() + 10_000;
    while (!existsSync(pidfile) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(readFileSync(pidfile, 'utf8'));
    assert.ok(alive(pid), 'the CLI is running');
    c.abort(new Error('cancelled'));
    const r = await result;
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.runtimeFailed, true);
    assert.match(r.records[0].runtimeError ?? '', /cancelled/);
    const dead = Date.now() + 3_000;
    while (alive(pid) && Date.now() < dead) await new Promise((res) => setTimeout(res, 20));
    assert.equal(alive(pid), false, 'the process group was killed');
    assert.equal(f.runs().length, 1, 'a cancelled call is not retried');
    const home = f.records().find((x) => x.geminiHome)?.geminiHome;
    assert.ok(home && !existsSync(home), 'the run-private home is removed after a cancel too');
  });

  it('the per-call deadline terminates the CLI and is reported as a timeout, without a retry', async () => {
    const pidfile = join(tempDir('gemini-pid-'), 'pid');
    const f = fake({ FAKE_MODE: 'term-ok-hang', FAKE_PIDFILE: pidfile });
    const repo = makeRepo(files);
    const provider = createGeminiProvider(f.config);
    await provider.probe(); // availability checks are not part of the deadline under test
    const r = await runCodingTask(task, { repoRoot: repo, worker: provider, capacity: new ModelCapacity(':memory:', { permits: 1 }), modelTimeoutMs: 1_500, abortGraceMs: 500, runtimeRetryDelayMs: 1 });
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.records[0].runtimeError ?? '', /exceeded 1500ms/);
    assert.equal(f.runs().length, 1);
    const pid = Number(readFileSync(pidfile, 'utf8'));
    const dead = Date.now() + 3_000;
    while (alive(pid) && Date.now() < dead) await new Promise((res) => setTimeout(res, 20));
    assert.equal(alive(pid), false);
  });
});

describe('event parsing', () => {
  it('reads text, usage, model and tool evidence tolerantly and ignores unknown shapes', () => {
    const p = parseGeminiEvents(
      [
        '{"type":"weird"}',
        '{"type":"init","model":"gemini-2.5-pro"}',
        '{"type":"message","role":"user","content":"ignored"}',
        '{"type":"tool_use","tool_name":"replace","tool_id":"a"}',
        '{"type":"tool_result","tool_id":"a","status":"error"}',
        '{"type":"message","role":"assistant","content":"hi ","delta":true}',
        '{"type":"message","role":"assistant","content":"there","delta":true}',
        '{"type":"result","status":"success","stats":{"input_tokens":5,"output_tokens":6}}',
        'noise',
      ].join('\n'),
    );
    assert.equal(p.text, 'hi there');
    assert.equal(p.model, 'gemini-2.5-pro');
    assert.deepEqual(p.usage, { inputTokens: 5, outputTokens: 6 });
    assert.deepEqual(p.tools, [{ name: 'applyPatch', ok: false }]);
    assert.equal(p.error, undefined);
  });

  it('does not trust a model string that is not a plain name', () => {
    assert.equal(parseGeminiEvents('{"type":"init","model":"--yolo"}').model, undefined);
  });
});

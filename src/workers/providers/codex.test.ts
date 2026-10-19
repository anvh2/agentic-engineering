import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ModelCapacity } from '../../runtime/capacity/model-capacity.ts';
import { runCodingTask } from '../../runtime/execution/coding-task-runner.ts';
import { UNKNOWN } from '../../runtime/execution/worker-provider.ts';
import { makeRepo, tempDir } from '../../runtime/scheduler/test-helpers.ts';
import { CODEX_AUDITED_TOOLS } from './codex-isolation.ts';
import { buildCodexArgs, createCodexProvider, parseCodexEvents, probeCodex, type CodexConfig } from './codex.ts';
import { defaultProviderRegistry } from './default.ts';
import { readPid } from './__testing__/pidfile.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '__testing__', 'fake-codex.mjs');
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

function fake(env: Record<string, string> = {}, extra: Partial<CodexConfig> = {}) {
  const dir = tempDir('codex-fake-');
  const log = join(dir, 'calls.jsonl');
  const config: CodexConfig = { command: FAKE, model: 'gpt-fake', env: { FAKE_LOG: log, ...env }, termGraceMs: 200, ...extra };
  const records = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const calls = () => records().filter((r) => r.args) as { args: string[]; envKeys: string[] }[];
  const stdins = () => records().filter((r) => 'stdinBytes' in r) as { stdinBytes: number; stdinHead: string }[];
  return { config, calls, stdins, dir };
}
const runOnce = (config: CodexConfig, opts: { signal?: AbortSignal; timeoutMs?: number } = {}) => {
  const repo = makeRepo(files);
  const provider = createCodexProvider(config);
  const result = runCodingTask(task, { repoRoot: repo, worker: provider, capacity: new ModelCapacity(':memory:', { permits: 1 }), signal: opts.signal, modelTimeoutMs: opts.timeoutMs, abortGraceMs: 500, runtimeRetryDelayMs: 1, maxAttempts: 3 });
  return { repo, provider, result };
};

describe('availability probe (no model call)', () => {
  it('available when installed, the required flags are advertised and a session exists', async () => {
    const f = fake();
    const p = await probeCodex(f.config);
    assert.equal(p.state, 'available');
    assert.match(p.version ?? '', /0\.0\.0-fake/);
    assert.deepEqual(f.calls().map((c) => c.args[0]), ['--version', 'exec', 'login']);
    assert.ok(!f.calls().some((c) => c.args[0] === 'exec' && !c.args.includes('--help')), 'the probe never starts a run');
  });

  it('not installed', async () => {
    const p = await probeCodex({ command: '/no/such/codex' });
    assert.equal(p.state, 'not_installed');
  });

  it('not authenticated is reported without echoing the CLI output', async () => {
    const f = fake({ FAKE_AUTH: 'none' });
    const p = await probeCodex(f.config);
    assert.equal(p.state, 'not_authenticated');
    assert.doesNotMatch(p.detail, /Not logged in/);
  });

  it('fails closed when the installed version does not advertise a required flag', async () => {
    const f = fake({ FAKE_HELP_OMIT: '--sandbox' });
    const p = await probeCodex(f.config);
    assert.equal(p.state, 'unsupported_version');
    assert.deepEqual(p.missingFlags, ['--sandbox']);
    const g = await probeCodex(fake({ FAKE_HELP_OMIT: '--ignore-user-config' }).config);
    assert.deepEqual(g.missingFlags, ['--ignore-user-config'], 'without it the operator config could weaken the sandbox');
  });

  it('the default registry lists codex (and gemini) as optional cloud providers next to the default, without running anything', () => {
    const r = defaultProviderRegistry();
    assert.deepEqual(r.ids(), ['codex', 'gemini', 'ollama']);
    assert.equal(r.get('codex').describe().identity.kind, 'cloud');
    assert.equal(r.get().id, 'ollama', 'the default stays the local model');
    assert.deepEqual(r.get('codex').describe().limits, { maxRuntimeRetries: 0, maxCodingAttempts: 2 });
  });
});

describe('read isolation', () => {
  const env = { HOME: '/h', CODEX_HOME: '/h/codex-login' };
  const configs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));
  const table = (args: string[]) => configs(args).find((c) => c.startsWith('permissions.agentic-isolated.filesystem='))!;

  it('deny-list mode: no --sandbox, a profile with the writes of workspace-write, credentials and listed paths denied', () => {
    const args = buildCodexArgs('/w/tree', { json: true, isolation: { denyReadPaths: ['/o/oracle'], scratchDir: '/s', env } });
    assert.ok(!args.includes('--sandbox'), 'the CLI ignores the profile when --sandbox is present');
    assert.deepEqual(args.slice(0, 4), ['exec', '--cd', '/w/tree', '--ignore-user-config']);
    const t = table(args);
    for (const entry of ['":root"="read"', '":project_roots"={"."="write", ".git"="read", ".codex"="read"}', '":tmpdir"="write"', '":slash_tmp"="write"', '"/s"="write"', '"/o/oracle"="none"', '"/h/.ssh"="none"', '"/h/.aws"="none"', '"/h/codex-login"="none"', '"/h/.codex"="none"']) assert.ok(t.includes(entry), `${entry} in ${t}`);
    assert.ok(!t.includes(':minimal'));
    assert.equal(args.at(-1), '-');
  });

  it('allow-list mode: only the system minimum, the toolchain and the worktree are readable', () => {
    const args = buildCodexArgs('/w/tree', { json: true, isolation: { readAllowPaths: ['/opt/homebrew/Cellar/go@1.25/1.25.10'], scratchDir: '/s', env } });
    const t = table(args);
    assert.ok(t.includes('":minimal"="read"'));
    assert.ok(!t.includes('":root"'), 'nothing grants the whole filesystem');
    assert.ok(t.includes('"/opt/homebrew/Cellar/go@1.25/1.25.10"="read"'));
    assert.ok(t.includes('"/h/.ssh"="none"'), 'credentials are denied on top, as a second layer');
    assert.ok(!args.includes('--sandbox'));
  });

  it('pins the tool surface, refuses unknown settings, and controls the shell environment', () => {
    const args = buildCodexArgs('/w/tree', { json: true, isolation: { readAllowPaths: [], scratchDir: '/s', env } });
    assert.ok(args.includes('--strict-config'));
    for (const f of ['apps', 'multi_agent', 'goals', 'plugins', 'remote_plugin', 'browser_use', 'computer_use', 'image_generation']) assert.ok(args.some((a, i) => a === f && args[i - 1] === '--disable'), `--disable ${f}`);
    const c = configs(args);
    assert.ok(c.includes('web_search="disabled"'));
    assert.ok(c.includes('features.view_image=false'));
    assert.ok(c.includes('shell_environment_policy.inherit="core"'), 'secrets in the launcher environment are not handed to the model');
    const set = c.find((x) => x.startsWith('shell_environment_policy.set='))!;
    for (const kv of ['HOME="/s"', 'GOCACHE="/s/go-build"', 'GIT_CONFIG_GLOBAL="/dev/null"', 'GOPROXY="off"', 'GOTOOLCHAIN="local"', 'GIT_TERMINAL_PROMPT="0"']) assert.ok(set.includes(kv), kv);
    assert.deepEqual(CODEX_AUDITED_TOOLS, ['exec_command', 'write_stdin', 'request_user_input']);
  });

  it('without isolation the command is exactly what it was (no -c, no --disable)', () => {
    for (const none of [undefined, {}, { denyReadPaths: [] }]) {
      const args = buildCodexArgs('/w', { json: false, isolation: none });
      assert.deepEqual(args, ['exec', '--sandbox', 'workspace-write', '--cd', '/w', '--ignore-user-config', '-']);
    }
  });

  it('refuses paths that are relative, not normalized or could break out of the quoting', () => {
    for (const bad of ['rel/path', '/', '/a/../b', '/a/./b', '/a/b/', '/a"b', '/a\\b', "/a'b", '/a=b', '/a\nb', '']) {
      assert.throws(() => buildCodexArgs('/w', { json: false, isolation: { denyReadPaths: [bad], scratchDir: '/s', env } }), /denyReadPaths/, JSON.stringify(bad));
      assert.throws(() => buildCodexArgs('/w', { json: false, isolation: { readAllowPaths: [bad], scratchDir: '/s', env } }), /readAllowPaths/, JSON.stringify(bad));
    }
    assert.throws(() => buildCodexArgs('/w', { json: false, isolation: { readAllowPaths: [], scratchDir: '/s"x', env } }), /scratchDir/);
  });

  it('refuses an allow-list that is too broad or would contain a protected path', () => {
    for (const broad of ['/usr', '/opt/homebrew', '/Users', '/private', '/h']) assert.throws(() => buildCodexArgs('/w', { json: false, isolation: { readAllowPaths: [broad], scratchDir: '/s', env } }), /too broad|would contain the protected path/, broad);
    assert.throws(() => buildCodexArgs('/w', { json: false, isolation: { readAllowPaths: ['/h/work'], denyReadPaths: ['/h/work/secret'], scratchDir: '/s', env } }), /would contain the protected path \/h\/work\/secret/);
  });

  it('fails closed when the CLI cannot enforce it, or the worktree overlaps a denied path', async () => {
    const wd = tempDir('iso-');
    const req = { providerRequest: { workdir: wd, allowedFiles: ['a'], contextFiles: [], taskType: 'go', timeoutMs: 5_000 } } as never;
    for (const missing of ['--config', '--disable', '--strict-config']) {
      const p = createCodexProvider({ command: FAKE, env: { FAKE_HELP_OMIT: missing }, denyReadPaths: ['/nonexistent/oracle'] });
      await assert.rejects(() => p.generate('p', req), /cannot enforce it, so nothing runs/, missing);
    }
    const overlap = createCodexProvider({ command: FAKE, denyReadPaths: [dirname(wd)] });
    await assert.rejects(() => overlap.generate('p', req), /overlaps the read-denied path/);
    const unsafe = createCodexProvider({ command: FAKE, readAllowPaths: ['/usr'] });
    await assert.rejects(() => unsafe.generate('p', req), /too broad/);
  });

  it('gives each call its own scratch directory and removes it afterwards', async () => {
    const log = join(tempDir('iso-log-'), 'fake.log');
    const wd = tempDir('iso-');
    const p = createCodexProvider({ command: FAKE, env: { FAKE_LOG: log }, readAllowPaths: [], denyReadPaths: ['/nonexistent/oracle'] });
    await p.generate('p', { providerRequest: { workdir: wd, allowedFiles: ['a'], contextFiles: [], taskType: 'go', timeoutMs: 20_000 } } as never).catch(() => undefined);
    const exec = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args?: string[] }).find((e) => e.args?.[0] === 'exec' && !e.args.includes('--help'));
    const home = /HOME="(\/[^"]+)"/.exec(exec?.args?.join(' ') ?? '')?.[1];
    assert.ok(home?.includes('agentic-codex-'), `scratch dir in the arguments: ${home}`);
    assert.equal(existsSync(home!), false, 'removed after the call');
  });
});

describe('command construction', () => {
  it('always uses the workspace-write sandbox rooted at the worktree', () => {
    const args = buildCodexArgs('/w/tree', { model: 'm', json: true, ephemeral: true, colorNever: true });
    assert.deepEqual(args, ['exec', '--sandbox', 'workspace-write', '--cd', '/w/tree', '--ignore-user-config', '--ephemeral', '--color', 'never', '--model', 'm', '--json', '-']);
    assert.ok(!args.includes('PROMPT'), 'the prompt is read from stdin, not argv');
  });

  it('refuses any argument that would weaken containment', () => {
    for (const bad of ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--yolo', 'danger-full-access', '--full-auto', '--add-dir', '--worktree', '--approve-for-me', '--oss', '-c', '--config', '--profile']) {
      assert.throws(() => buildCodexArgs('/w', { model: bad, json: false }), /weaken the sandbox/, bad);
    }
  });
});

describe('end to end through the runner (mock CLI)', () => {
  it('edits inside the worktree, the RUNTIME verifies, usage is reported, cost and quota stay UNKNOWN', async () => {
    const f = fake();
    const { repo, result } = runOnce(f.config);
    const r = await result;
    assert.equal(r.verdict, 'PASS');
    assert.equal(readFileSync(join(repo, 'src/x.js'), 'utf8'), 'module.exports = 1;\n');
    const t = r.records[0].telemetry!;
    assert.deepEqual([t.provider, t.model], ['codex', 'gpt-fake']);
    assert.deepEqual(t.usage, { inputTokens: 120, outputTokens: 34, costUsd: UNKNOWN, quota: UNKNOWN });
    const run = f.calls().find((c) => c.args[0] === 'exec' && c.args.includes('--sandbox'))!;
    assert.ok(run.args.includes('workspace-write') && run.args.includes(repo) && run.args.includes('--ignore-user-config'));
    const stdin = f.stdins()[0];
    assert.ok(stdin.stdinBytes > 100 && /coding worker inside a runtime/.test(stdin.stdinHead), 'the prompt arrived on stdin');
    assert.ok(!run.args.some((a) => /dangerous|yolo|bypass|full-auto/.test(a)));
    assert.deepEqual(r.records[0].toolCalls.map((c) => c.name), ['shell', 'applyPatch']);
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

  it('no automatic runtime retry and at most 2 coding attempts: a failing paid call is not repeated', async () => {
    const f = fake({ FAKE_MODE: 'fail' });
    const r = await runOnce(f.config).result;
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.runtimeRetries, 0);
    assert.equal(f.calls().filter((c) => c.args[0] === 'exec' && c.args.includes('--sandbox')).length, 1, 'exactly one billed invocation');
    assert.match(r.records[0].runtimeError ?? '', /exited with 2/);
    assert.doesNotMatch(r.records[0].runtimeError ?? '', /sk-abcdefghijklmnop1234/, 'secrets in CLI stderr are redacted');
  });

  it('a verifier failure retries at most once more (2 attempts total), never 3', async () => {
    const f = fake();
    const repo = makeRepo(files);
    const r = await runCodingTask({ ...task, verificationCommands: [['false']] }, { repoRoot: repo, worker: createCodexProvider(f.config), capacity: new ModelCapacity(':memory:', { permits: 1 }), maxAttempts: 3 });
    assert.equal(r.attempts, 2);
    assert.equal(f.calls().filter((c) => c.args[0] === 'exec' && c.args.includes('--sandbox')).length, 2);
  });

  it('is unusable (and runs nothing) when the safety flags are missing or the user is signed out', async () => {
    const cases: Record<string, string>[] = [{ FAKE_HELP_OMIT: '--cd' }, { FAKE_HELP_OMIT: '--ignore-user-config' }, { FAKE_AUTH: 'none' }];
    for (const env of cases) {
      const f = fake(env);
      const r = await runOnce(f.config).result;
      assert.equal(r.verdict, 'FAIL');
      assert.match(r.records[0].runtimeError ?? '', /unavailable/);
      assert.equal(f.calls().filter((c) => c.args[0] === 'exec' && c.args.includes('--sandbox')).length, 0, 'no run was started');
    }
  });

  it('garbage output with a clean exit yields UNKNOWN usage, not a fabricated one', async () => {
    const f = fake({ FAKE_MODE: 'garbage' });
    const r = await runOnce(f.config).result;
    assert.deepEqual(r.records[0].telemetry!.usage.inputTokens, UNKNOWN);
  });

  it('the child sees an allowlisted environment: no ambient credentials', async () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-reach-child';
    try {
      const f = fake();
      await runOnce(f.config).result;
      const run = f.calls().find((c) => c.args.includes('--sandbox'))!;
      assert.ok(!run.envKeys.includes('OPENAI_API_KEY'));
      assert.ok(run.envKeys.includes('HOME') && run.envKeys.includes('PATH'));
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe('cancellation and timeout kill the CLI', () => {
  it('abort terminates a CLI that ignores SIGTERM, with SIGKILL, and nothing is left running', async () => {
    const pidfile = join(tempDir('codex-pid-'), 'pid');
    const f = fake({ FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile });
    const c = new AbortController();
    const { result } = runOnce(f.config, { signal: c.signal });
    const end = Date.now() + 10_000;
    while (readPid(pidfile) === undefined && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const pid = readPid(pidfile)!;
    assert.ok(alive(pid), 'the CLI is running');
    c.abort(new Error('cancelled'));
    const r = await result;
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.runtimeFailed, true);
    const dead = Date.now() + 3_000;
    while (alive(pid) && Date.now() < dead) await new Promise((res) => setTimeout(res, 20));
    assert.equal(alive(pid), false, 'the process group was killed');
  });

  it('the per-call deadline terminates the CLI and is reported as a timeout', async () => {
    const pidfile = join(tempDir('codex-pid-'), 'pid');
    const f = fake({ FAKE_MODE: 'term-ok-hang', FAKE_PIDFILE: pidfile });
    const repo = makeRepo(files);
    const provider = createCodexProvider(f.config);
    await provider.probe(); // availability checks are not part of the deadline under test
    const r = await runCodingTask(task, { repoRoot: repo, worker: provider, capacity: new ModelCapacity(':memory:', { permits: 1 }), modelTimeoutMs: 1_500, abortGraceMs: 500, runtimeRetryDelayMs: 1 });
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.records[0].runtimeError ?? '', /exceeded 1500ms/);
    const pid = readPid(pidfile);
    assert.ok(pid, 'the CLI published a complete pid before it was cancelled');
    const dead = Date.now() + 3_000;
    while (alive(pid) && Date.now() < dead) await new Promise((res) => setTimeout(res, 20));
    assert.equal(alive(pid), false);
  });
});

describe('event parsing', () => {
  it('reads text, usage and tool evidence tolerantly and ignores unknown shapes', () => {
    const p = parseCodexEvents('{"type":"weird"}\n{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":6}}\nnoise');
    assert.equal(p.text, 'hi');
    assert.deepEqual(p.usage, { inputTokens: 5, outputTokens: 6 });
  });
});

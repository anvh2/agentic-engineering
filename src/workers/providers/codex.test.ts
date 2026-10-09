import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ModelCapacity } from '../../runtime/capacity/model-capacity.ts';
import { runCodingTask } from '../../runtime/execution/coding-task-runner.ts';
import { UNKNOWN } from '../../runtime/execution/worker-provider.ts';
import { makeRepo, tempDir } from '../../runtime/scheduler/test-helpers.ts';
import { buildCodexArgs, createCodexProvider, parseCodexEvents, probeCodex, type CodexConfig } from './codex.ts';
import { defaultProviderRegistry } from './default.ts';

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
    while (!existsSync(pidfile) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(readFileSync(pidfile, 'utf8'));
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
    const pid = Number(readFileSync(pidfile, 'utf8'));
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

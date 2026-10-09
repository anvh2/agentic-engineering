#!/usr/bin/env node
// A stand-in for the Gemini CLI used by tests. It never touches the network or any account. Behavior comes from FAKE_* env
// vars (the adapter forwards only what its config's `env` names). It records its argv, working directory, environment keys and
// the run-private settings/policy files it was handed (they are deleted after the call, so the test reads them from here).
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
const omit = (process.env.FAKE_HELP_OMIT ?? '').split(',').filter(Boolean);
const record = (r) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(r)}\n`);
const flagValue = (name) => args[args.indexOf(name) + 1];

record({ args: args.map((a) => (a.length > 200 ? `${a.slice(0, 40)}...<${a.length} chars>` : a)), cwd: process.cwd(), envKeys: Object.keys(process.env).sort() });

const event = (e) => console.log(JSON.stringify(e));

if (args[0] === '--version') {
  console.log('0.0.0-fake');
} else if (args.includes('--help')) {
  const flags = ['-m, --model', '-p, --prompt', '-s, --sandbox', '--skip-trust', '-y, --yolo', '--approval-mode', '--admin-policy', '--allowed-mcp-server-names', '-o, --output-format'].filter((f) => !omit.some((o) => f.split(', ').pop() === o));
  console.log(`Gemini CLI\n\nOptions:\n${flags.map((f) => `  ${f}   described`).join('\n')}`);
} else if (args.includes('--prompt')) {
  const mode = process.env.FAKE_MODE ?? 'edit';
  const cd = process.cwd();
  const geminiHome = process.env.GEMINI_CLI_HOME;
  const settingsPath = geminiHome ? join(geminiHome, '.gemini', 'settings.json') : undefined;
  const policyDir = flagValue('--admin-policy');
  const stdin = mode === 'hang' || mode === 'term-ok-hang' ? '' : readFileSync(0, 'utf8');
  record({
    stdinBytes: stdin.length,
    stdinHead: stdin.slice(0, 80),
    geminiHome: geminiHome ?? null,
    settingsPath: settingsPath ?? null,
    settings: settingsPath && existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null,
    homeInsideCwd: geminiHome ? geminiHome.startsWith(cd) : null,
    systemSettingsEnvSet: 'GEMINI_CLI_SYSTEM_SETTINGS_PATH' in process.env,
    policy: policyDir && existsSync(policyDir) ? Object.fromEntries(readdirSync(policyDir).map((f) => [f, readFileSync(join(policyDir, f), 'utf8')])) : null,
    fixedEnv: Object.fromEntries(['SEATBELT_PROFILE', 'NO_BROWSER', 'GEMINI_TELEMETRY_ENABLED', 'GOOGLE_GEMINI_BASE_URL'].map((k) => [k, process.env[k] ?? null])),
  });
  // FAKE_API_PATHS: JSON list of request paths this "CLI" POSTs to GOOGLE_GEMINI_BASE_URL (a local guard) before it edits; statuses are logged.
  if (process.env.FAKE_API_PATHS && process.env.GOOGLE_GEMINI_BASE_URL) {
    const statuses = [];
    for (const path of JSON.parse(process.env.FAKE_API_PATHS)) {
      try {
        const r = await fetch(process.env.GOOGLE_GEMINI_BASE_URL + path, { method: 'POST', headers: { 'x-goog-api-key': 'FAKE-DUMMY-KEY', 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'FAKE-PROMPT-BODY' }] }] }) });
        statuses.push(r.status);
        await r.text();
      } catch (e) {
        statuses.push(String(e.cause?.code ?? e.message));
      }
    }
    record({ apiStatuses: statuses });
  }
  if (mode === 'hang') {
    process.on('SIGTERM', () => {}); // ignores the polite request
    if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));
    setInterval(() => {}, 1000);
  } else if (mode === 'term-ok-hang') {
    if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));
    setInterval(() => {}, 1000);
  } else if (mode === 'fail') {
    console.error('Error: unauthorized token sk-abcdefghijklmnop1234');
    process.exit(1);
  } else if (mode === 'auth') {
    console.error('Please set an Auth method');
    process.exit(41);
  } else if (mode === 'garbage') {
    console.log('not json at all');
    console.log('the work is done');
  } else {
    event({ type: 'init', timestamp: 't', session_id: 's', model: process.env.FAKE_REPORTED_MODEL ?? 'gemini-fake-pro' });
    if (mode === 'edit' || mode === 'edit-and-forbid' || mode === 'commit' || mode === 'error-result') writeFileSync(join(cd, process.env.FAKE_FILE ?? 'src/x.js'), process.env.FAKE_CONTENT ? JSON.parse(process.env.FAKE_CONTENT) : 'module.exports = 1;\n');
    if (mode === 'edit-and-forbid') writeFileSync(join(cd, 'README.md'), 'tampered\n');
    if (mode === 'commit') {
      execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '-qam', 'cheat'], { cwd: cd });
    }
    event({ type: 'message', role: 'user', content: 'x' });
    event({ type: 'tool_use', tool_name: 'write_file', tool_id: 't1', parameters: {} });
    event({ type: 'tool_result', tool_id: 't1', status: 'success' });
    event({ type: 'tool_use', tool_name: 'run_shell_command', tool_id: 't2', parameters: {} });
    event({ type: 'tool_result', tool_id: 't2', status: 'error' });
    event({ type: 'message', role: 'assistant', content: 'Updated ', delta: true });
    event({ type: 'message', role: 'assistant', content: 'src/x.js', delta: true });
    if (mode === 'error-result') event({ type: 'result', status: 'error', error: { type: 'Error', message: 'quota exceeded for key sk-abcdefghijklmnop1234' }, stats: { input_tokens: 1, output_tokens: 1 } });
    else if (mode !== 'no-usage') event({ type: 'result', status: 'success', stats: { total_tokens: 154, input_tokens: 120, output_tokens: 34, cached: 0, input: 120, duration_ms: 5, tool_calls: 2, models: {} } });
  }
} else {
  console.error(`unknown invocation: ${args.join(' ')}`);
  process.exit(64);
}

#!/usr/bin/env node
// A stand-in for the Codex CLI used by tests. It never touches the network or any account. Behavior comes from FAKE_* env
// vars (the adapter forwards only what its config's `env` names). It records its argv and environment keys for assertions.
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
// Publish the pid atomically (write + rename): a reader that polls for the file's EXISTENCE must never see it empty, because
// Number('') is 0 and process.kill(0, 0) succeeds (it addresses the caller's own process group).
const publishPid = (file) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, String(process.pid)); renameSync(tmp, file); };
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
const omit = (process.env.FAKE_HELP_OMIT ?? '').split(',').filter(Boolean);
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args: args.map((a) => (a.length > 200 && !a.startsWith('shell_environment_policy.set=') ? `${a.slice(0, 40)}...<${a.length} chars>` : a)), envKeys: Object.keys(process.env).sort() })}\n`);

if (args[0] === '--version') {
  console.log('codex-cli 0.0.0-fake');
} else if (args[0] === 'exec' && args.includes('--help')) {
  const flags = ['--config <KEY=VALUE>', '--disable <FEATURE>', '--strict-config', '--sandbox <MODE>', '--cd <DIR>', '--ignore-user-config', '--ephemeral', '--color <COLOR>', '--model <MODEL>', '--json'].filter((f) => !omit.some((o) => f.startsWith(o)));
  console.log(`Run Codex non-interactively\n\nOptions:\n${flags.map((f) => `      ${f}`).join('\n')}`);
} else if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FAKE_AUTH === 'none') {
    console.error('Not logged in');
    process.exit(1);
  }
  console.log('Logged in');
} else if (args[0] === 'exec') {
  const cd = args[args.indexOf('--cd') + 1];
  const mode = process.env.FAKE_MODE ?? 'edit';
  if (args.at(-1) === '-' && process.env.FAKE_LOG && mode !== 'hang' && mode !== 'term-ok-hang') {
    const stdin = readFileSync(0, 'utf8');
    appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ stdinBytes: stdin.length, stdinHead: stdin.slice(0, 80) })}\n`);
  }
  const event = (e) => console.log(JSON.stringify(e));
  if (mode === 'hang') {
    process.on('SIGTERM', () => {}); // ignores the polite request
    if (process.env.FAKE_PIDFILE) publishPid(process.env.FAKE_PIDFILE);
    setInterval(() => {}, 1000);
  } else if (mode === 'term-ok-hang') {
    if (process.env.FAKE_PIDFILE) publishPid(process.env.FAKE_PIDFILE);
    setInterval(() => {}, 1000);
  } else if (mode === 'fail') {
    console.error('Error: unauthorized token sk-abcdefghijklmnop1234');
    process.exit(2);
  } else if (mode === 'garbage') {
    console.log('not json at all');
    console.log('the work is done');
  } else {
    event({ type: 'thread.started' });
    if (mode === 'edit' || mode === 'edit-and-forbid' || mode === 'commit') writeFileSync(join(cd, process.env.FAKE_FILE ?? 'src/x.js'), process.env.FAKE_CONTENT ? JSON.parse(process.env.FAKE_CONTENT) : 'module.exports = 1;\n');
    if (mode === 'edit-and-forbid') writeFileSync(join(cd, 'README.md'), 'tampered\n');
    if (mode === 'commit') {
      execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '-qam', 'cheat'], { cwd: cd });
    }
    event({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } });
    event({ type: 'item.completed', item: { type: 'file_change', status: 'completed' } });
    event({ type: 'item.completed', item: { type: 'agent_message', text: 'Updated src/x.js' } });
    if (mode !== 'no-usage') event({ type: 'turn.completed', usage: { input_tokens: 120, output_tokens: 34 } });
  }
} else {
  console.error(`unknown invocation: ${args.join(' ')}`);
  process.exit(64);
}

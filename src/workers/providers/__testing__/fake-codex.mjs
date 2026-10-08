#!/usr/bin/env node
// A stand-in for the Codex CLI used by tests. It never touches the network or any account. Behavior comes from FAKE_* env
// vars (the adapter forwards only what its config's `env` names). It records its argv and environment keys for assertions.
import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
const omit = (process.env.FAKE_HELP_OMIT ?? '').split(',').filter(Boolean);
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args: args.map((a) => (a.length > 200 ? `${a.slice(0, 40)}...<${a.length} chars>` : a)), envKeys: Object.keys(process.env).sort() })}\n`);

if (args[0] === '--version') {
  console.log('codex-cli 0.0.0-fake');
} else if (args[0] === 'exec' && args.includes('--help')) {
  const flags = ['--sandbox <MODE>', '--cd <DIR>', '--model <MODEL>', '--json'].filter((f) => !omit.some((o) => f.startsWith(o)));
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
  const event = (e) => console.log(JSON.stringify(e));
  if (mode === 'hang') {
    process.on('SIGTERM', () => {}); // ignores the polite request
    if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));
    setInterval(() => {}, 1000);
  } else if (mode === 'term-ok-hang') {
    if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));
    setInterval(() => {}, 1000);
  } else if (mode === 'fail') {
    console.error('Error: unauthorized token sk-abcdefghijklmnop1234');
    process.exit(2);
  } else if (mode === 'garbage') {
    console.log('not json at all');
    console.log('the work is done');
  } else {
    event({ type: 'thread.started' });
    if (mode === 'edit' || mode === 'edit-and-forbid' || mode === 'commit') writeFileSync(join(cd, 'src/x.js'), 'module.exports = 1;\n');
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

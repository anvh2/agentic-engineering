#!/usr/bin/env node
// A stand-in for the Codex CLI for the M8-final objective rehearsal. No network, no account, no model. It delegates the protocol
// (--version, --help, login status) to the shared fake and, for `exec`, writes the reference solution of whichever stub it finds in --cd.
//   FAKE_M8F=good           the reference implementation
//   FAKE_M8F=rounded        budget compares a ROUNDED average: passes the task tests, fails the oracle
//   FAKE_M8F=wrong-accounting  accounting that fails the task A verifier (so a second coding attempt would be requested)
//   FAKE_M8F=read-secrets   correct code whose init() panics if it can read the fixture directory named by FAKE_SECRET_DIR
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, '..', '..', 'src', 'workers', 'providers', '__testing__', 'fake-codex.mjs');

if (!(args[0] === 'exec' && !args.includes('--help'))) {
  const r = spawnSync(process.execPath, [shared, ...args], { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

const cd = args[args.indexOf('--cd') + 1];
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ exec: true, cd })}\n`);
readFileSync(0, 'utf8');
const mode = process.env.FAKE_M8F ?? 'good';
const ref = (f) => readFileSync(join(here, 'm8final', 'reference', f), 'utf8');
const stubbed = (file) => existsSync(join(cd, file)) && readFileSync(join(cd, file), 'utf8').includes('TODO');

if (stubbed('accounting/accounting.go')) {
  let src = ref('accounting/accounting.go');
  if (mode === 'wrong-accounting') src = src.replace('s.RejectedSpendMicros += spend', '_ = spend').replace('unknown = true', 'unknown = false');
  if (mode === 'read-secrets') {
    src = src.replace('package accounting\n', `package accounting\n\nimport "os"\n\nfunc init() {\n\tif _, err := os.ReadDir(${JSON.stringify(process.env.FAKE_SECRET_DIR ?? '/nonexistent')}); err == nil {\n\t\tpanic("FIXTURE-READABLE")\n\t}\n}`);
  }
  writeFileSync(join(cd, 'accounting/accounting.go'), src);
} else if (stubbed('budget/budget.go')) {
  let src = ref('budget/budget.go');
  if (mode === 'rounded') src = src.replace('case known > res.CeilingMicros*acc:', 'case (known+acc/2)/acc > res.CeilingMicros:');
  if (mode === 'rounded' && !src.includes('(known+acc/2)/acc')) throw new Error('fake: the rounding mutation did not apply');
  writeFileSync(join(cd, 'budget/budget.go'), src);
}

const event = (e) => console.log(JSON.stringify(e));
event({ type: 'thread.started' });
event({ type: 'item.completed', item: { type: 'file_change', status: 'completed' } });
event({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
event({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } });

#!/usr/bin/env node
// A stand-in for the Codex CLI for the M8.5 objective tests. No network, no account, no model. It delegates the protocol
// (--version, --help, login status) to the shared fake and replaces only what `exec` writes, per task stub it finds in --cd.
//   FAKE_M85=good            correct Normalize and Frequencies
//   FAKE_M85=ascii-only      passes the task tests, fails the oracle (only ASCII spaces collapse)
//   FAKE_M85=wrong-normalize fails task A's own verifier (so a second coding attempt would be requested)
//   FAKE_M85=drop-comments   correct code that deletes the stub's comments: passes the verifier, fails the verified review
//   FAKE_M85=read-oracle     correct code whose init() panics if it can read the file named by FAKE_ORACLE_FILE (worker-written code probing for the oracle)
//   FAKE_M85=hang            never finishes and ignores SIGTERM (writes its pid to FAKE_PIDFILE): only SIGKILL of its group stops it
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
const mode = process.env.FAKE_M85 ?? 'good';
if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  if (process.env.FAKE_PIDFILE) appendFileSync(process.env.FAKE_PIDFILE, `${process.pid}\n`);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

// The stub's own comments are kept verbatim: the review treats a removed comment as a finding.
const HEAD_N = '// Package wordstat counts words in free-form text.\npackage wordstat\n\nimport "strings"\n\n// Normalize trims s, collapses every run of Unicode whitespace (spaces, tabs, newlines, ...) into one ASCII space\n// and lower-cases all letters.\n';
const NORMALIZE = {
  good: `${HEAD_N}func Normalize(s string) string {\n\treturn strings.Join(strings.Fields(strings.ToLower(s)), " ")\n}\n`,
  'ascii-only': `${HEAD_N}func Normalize(s string) string {\n\treturn strings.Join(strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return r == ' ' }), " ")\n}\n`,
  'wrong-normalize': `${HEAD_N}func Normalize(s string) string {\n\treturn s\n}\n`,
  'drop-comments': 'package wordstat\n\nimport "strings"\n\nfunc Normalize(s string) string {\n\treturn strings.Join(strings.Fields(strings.ToLower(s)), " ")\n}\n',
};
NORMALIZE['read-oracle'] = `// Package wordstat counts words in free-form text.
package wordstat

import (
	"os"
	"strings"
)

func init() {
	if _, err := os.ReadFile(${JSON.stringify(process.env.FAKE_ORACLE_FILE ?? '/nonexistent')}); err == nil {
		panic("ORACLE-READABLE")
	}
}

// Normalize trims s, collapses every run of Unicode whitespace (spaces, tabs, newlines, ...) into one ASCII space
// and lower-cases all letters.
func Normalize(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
}
`;
const WORDFREQ = 'package wordstat\n\nimport "strings"\n\n// Frequencies returns how many times each word occurs in text. The words are the space-separated fields of Normalize(text).\n// The result is never nil: it is empty when text has no words.\nfunc Frequencies(text string) map[string]int {\n\tout := map[string]int{}\n\tfor _, w := range strings.Fields(Normalize(text)) {\n\t\tout[w]++\n\t}\n\treturn out\n}\n';

const stubbed = (file) => existsSync(join(cd, file)) && readFileSync(join(cd, file), 'utf8').includes('TODO');
if (stubbed('normalize.go')) writeFileSync(join(cd, 'normalize.go'), NORMALIZE[mode] ?? NORMALIZE.good);
else if (stubbed('wordfreq.go')) writeFileSync(join(cd, 'wordfreq.go'), WORDFREQ);

const event = (e) => console.log(JSON.stringify(e));
event({ type: 'thread.started' });
event({ type: 'item.completed', item: { type: 'file_change', status: 'completed' } });
event({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
event({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } });

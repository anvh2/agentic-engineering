// M10.1 oracle runner. Runs the PINNED acceptance oracle against any commit, in a throwaway detached worktree, and writes a
// machine-readable verdict. The oracle file is copied in from this directory after its sha256 is checked against oracle.json,
// so the target cannot bring its own (edited) oracle.
//
//   node tests/reliability/oracle/run-oracle.ts --target <ref> --expect candidate|baseline|mutant [--mutant <id>] --out <dir>
//
//   candidate  every oracle test passes.
//   baseline   the negative control: every test in oracle.json `baselineMustFail` fails (the oracle detects the missing
//              feature or defect) and every test in `baselineMustPass` passes (the oracle does not over-fail).
//   mutant     a known-bad implementation named in oracle.json `mutants`: its patch (mutants/<file>) is applied on top of --target,
//              then its `mustFail` tests fail and its `mustPass` pass. This shows the oracle rejects a specific wrong fix
//              (for example the resource-scoped fix M10 reverted, or a run-scoped fix that fails open).
//
// Exit 0 iff the expectation holds.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const ORACLE_REL = 'tests/reliability/oracle/m10_1-oracle.test.ts';

interface OracleSpec {
  schema: 'agentic.m10_1-oracle/1';
  version: number;
  sha256: string;
  baselineRef: string;
  baselineMustFail: string[];
  baselineMustPass: string[];
  mutants: { id: string; description: string; patch: string; appliesTo: 'baseline' | 'candidate'; mustFail: string[]; mustPass: string[] }[];
}

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const target = arg('--target');
const expect = arg('--expect') as 'candidate' | 'baseline' | 'mutant' | undefined;
const mutantId = arg('--mutant');
const out = arg('--out');
if (!target || !expect || !out || !['candidate', 'baseline', 'mutant'].includes(expect) || (expect === 'mutant' && !mutantId)) {
  console.error('usage: run-oracle.ts --target <ref> --expect candidate|baseline|mutant [--mutant <id>] --out <dir>');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(join(HERE, 'oracle.json'), 'utf8')) as OracleSpec;
const oracleBytes = readFileSync(join(REPO, ORACLE_REL));
const sha = createHash('sha256').update(oracleBytes).digest('hex');
if (sha !== spec.sha256) {
  console.error(`oracle hash mismatch: ${ORACLE_REL} is ${sha}, oracle.json pins ${spec.sha256}. The oracle was edited after it was pinned.`);
  process.exit(3);
}
const mutant = expect === 'mutant' ? spec.mutants.find((m) => m.id === mutantId) : undefined;
if (expect === 'mutant' && !mutant) {
  console.error(`unknown mutant "${mutantId}" (known: ${spec.mutants.map((m) => m.id).join(', ')})`);
  process.exit(2);
}

const git = (...a: string[]) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--verify', `${target}^{commit}`);
mkdirSync(out, { recursive: true });
const wt = join(out, `target-${commit.slice(0, 10)}`);
if (existsSync(wt)) execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: REPO });
git('worktree', 'add', '--detach', wt, commit);
try {
  symlinkSync(join(REPO, 'node_modules'), join(wt, 'node_modules'));
  if (mutant) execFileSync('git', ['apply', '--whitespace=nowarn', join(HERE, 'mutants', mutant.patch)], { cwd: wt });
  mkdirSync(join(wt, dirname(ORACLE_REL)), { recursive: true });
  copyFileSync(join(REPO, ORACLE_REL), join(wt, ORACLE_REL));
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', '--test-timeout=1500000', ORACLE_REL], { cwd: wt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 1_500_000 });
  const tap = `${r.stdout ?? ''}`;
  const label = expect === 'mutant' ? `mutant-${mutantId}` : expect;
  writeFileSync(join(out, `oracle-${label}-${commit.slice(0, 10)}.tap`), tap + (r.stderr ? `\n# STDERR\n${r.stderr}` : ''));
  // node:test TAP: "    ok 1 - name" / "    not ok 2 - name" for leaf tests (indented), suites at lower indentation.
  const results: { name: string; ok: boolean; error?: string }[] = [];
  const lines = tap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {4}(not ok|ok) \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    let error: string | undefined;
    if (m[1] === 'not ok') {
      for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
        const e = /^\s+error: (.*)$/.exec(lines[j]);
        if (e) {
          // YAML block scalars ("|-") carry the message on the following, more indented lines
          const block = /^\|-?$/.test(e[1].trim()) ? lines.slice(j + 1, j + 8).filter((l) => /^\s{8,}\S/.test(l)).map((l) => l.trim()).join(' ') : e[1];
          error = block.replace(/^['"]|['"]$/g, '').slice(0, 400);
          break;
        }
      }
    }
    results.push({ name: m[2].trim(), ok: m[1] === 'ok', error });
  }
  const failed = results.filter((t) => !t.ok).map((t) => t.name);
  const passedNames = results.filter((t) => t.ok).map((t) => t.name);
  const mustFail = expect === 'baseline' ? spec.baselineMustFail : mutant?.mustFail ?? [];
  const mustPass = expect === 'baseline' ? spec.baselineMustPass : mutant?.mustPass ?? [];
  const missingFailures = mustFail.filter((n) => !results.some((t) => t.name === n && !t.ok));
  const missingPasses = mustPass.filter((n) => !results.some((t) => t.name === n && t.ok));
  const holds = expect === 'candidate' ? results.length > 0 && failed.length === 0 && r.status === 0 : results.length > 0 && missingFailures.length === 0 && missingPasses.length === 0;
  const verdict = {
    schema: 'agentic.m10_1-oracle-verdict/1',
    expect,
    ...(mutant ? { mutant: { id: mutant.id, description: mutant.description } } : {}),
    target,
    commit,
    oracleVersion: spec.version,
    oracleSha256: sha,
    exitCode: r.status,
    durationMs: Date.now() - started,
    tests: results,
    passed: passedNames.length,
    failed: failed.length,
    ...(expect === 'candidate' ? {} : { mustFail, mustPass, missingFailures, missingPasses }),
    holds,
  };
  writeFileSync(join(out, `oracle-${label}-${commit.slice(0, 10)}.json`), JSON.stringify(verdict, null, 2) + '\n');
  console.log(JSON.stringify({ expect, ...(mutantId ? { mutant: mutantId } : {}), commit, passed: verdict.passed, failed: verdict.failed, ...(expect === 'candidate' ? {} : { missingFailures, missingPasses }), holds }, null, 2));
  process.exitCode = holds ? 0 : 1;
} finally {
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: REPO });
  rmSync(wt, { recursive: true, force: true });
}

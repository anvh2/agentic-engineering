import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { resolveCapacity, type DelegationCapacity } from '../execution/delegation-capacity.ts';
import { runControlledCommand } from '../../workers/tools/execution-tools.ts';
import { EvidenceError, inspectChange, parseNumstatZ, readGitEvidence } from './change-review.ts';

/**
 * M9.0 P0: the review gate judged git output that runControlledCommand had cut at 4,000 bytes. Every case here puts the
 * deciding evidence beyond that old cut-off and checks that the gate sees it, or refuses to judge (evidence_incomplete).
 */

const OLD_CUTOFF = 4_000;
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const FILE = 'pkg/code.go';
const WIDE: DelegationCapacity = { warnChangedLinesPerFile: 2_000, maxChangedLinesPerTask: 2_000 };

function repoWith(files: Record<string, string>): { repo: string; git: (...args: string[]) => string } {
  const repo = mkdtempSync(join(tmpdir(), 'review-evidence-'));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { repo, git };
}

const inspect = (repo: string, allowedFiles = [FILE], capacity?: DelegationCapacity) => inspectChange({ repoRoot: repo, allowedFiles, statusBefore: [], capacity: resolveCapacity(capacity) });
const codes = (i: Awaited<ReturnType<typeof inspect>>) => i.findings.map((f) => `${f.severity}:${f.code}`);

/** A Go file of `n` numbered functions; each line is distinct so diffs stay line-exact. */
const goFile = (n: number) => `package p\n\n${Array.from({ length: n }, (_, i) => `// F${i} returns ${i}.\nfunc F${i}() int { return ${i} }\n`).join('\n')}`;

describe('M9.0 review evidence: files and diffs larger than the old 4,000-byte cut-off', () => {
  it('a >4 KB file keeping its final newline is NOT a false eof_newline block (the M8-final rehearsal defect)', async () => {
    const before = goFile(200);
    assert.ok(Buffer.byteLength(before) > 2 * OLD_CUTOFF);
    const { repo } = repoWith({ [FILE]: before });
    writeFileSync(join(repo, FILE), before.replace('return 100 }', 'return 1000 }'));
    const i = await inspect(repo);
    assert.deepEqual(codes(i).filter((c) => c.startsWith('block:')), [], codes(i).join());
    assert.deepEqual(i.changedAllowedFiles, [FILE]);
    assert.equal(i.changedLines[FILE], 2);
  });

  it('a >4 KB file whose final newline was removed IS blocked, judged from the complete file at HEAD', async () => {
    const before = goFile(200);
    const { repo } = repoWith({ [FILE]: before });
    writeFileSync(join(repo, FILE), before.trimEnd());
    assert.ok(codes(await inspect(repo)).includes('block:eof_newline'));
  });

  it('a >4 KB file that never had a final newline and still has none is not blocked', async () => {
    const before = goFile(200).trimEnd();
    const { repo } = repoWith({ [FILE]: before });
    writeFileSync(join(repo, FILE), before.replace('return 7 }', 'return 70 }'));
    assert.equal(codes(await inspect(repo)).includes('block:eof_newline'), false);
  });

  it('a malicious line at the END of a >4 KB diff on a tracked file is blocked', async () => {
    const before = goFile(150);
    const { repo } = repoWith({ [FILE]: before });
    const filler = Array.from({ length: 120 }, (_, i) => `// added note ${i}: nothing to see here, just padding the diff`).join('\n');
    writeFileSync(join(repo, FILE), `${before}\n${filler}\nvar _ = "child_process"\n`);
    const i = await inspect(repo, [FILE], WIDE);
    assert.ok(Buffer.byteLength(i.diff) > OLD_CUTOFF, `diff is ${Buffer.byteLength(i.diff)} bytes`);
    assert.ok(i.diff.indexOf('child_process') > OLD_CUTOFF, 'the malicious line sits beyond the old cut-off');
    assert.ok(i.findings.some((f) => f.code === 'security_block' && /child_process/.test(f.detail)), codes(i).join());
  });

  it('a malicious line at the end of a large NEW file is blocked and its whole diff is returned for review', async () => {
    const { repo } = repoWith({ 'README.md': 'x\n' });
    const NEW = 'pkg/new.go';
    mkdirSync(join(repo, 'pkg'));
    writeFileSync(join(repo, NEW), `${goFile(120)}\nfunc init() { eval("payload") }\n`);
    const i = await inspect(repo, [NEW], WIDE);
    assert.ok(i.diff.endsWith('+func init() { eval("payload") }\n'), 'the diff is complete, not cut');
    assert.ok(codes(i).includes('block:security_block'));
    assert.equal(i.changedLines[NEW], 120 * 3 + 2 + 1, 'line count comes from git numstat');
  });

  it('a removed doc comment beyond the old cut-off is still reported', async () => {
    const before = goFile(150);
    const { repo } = repoWith({ [FILE]: before });
    const filler = Array.from({ length: 120 }, (_, k) => `var v${k} = ${k} // padding line for the diff`).join('\n');
    writeFileSync(join(repo, FILE), before.replace('package p\n\n', `package p\n\n${filler}\n\n`).replace('// F149 returns 149.\n', ''));
    const i = await inspect(repo, [FILE], WIDE);
    assert.ok(Buffer.byteLength(i.diff) > OLD_CUTOFF);
    assert.ok(i.diff.indexOf('-// F149 returns 149.') > OLD_CUTOFF, 'the removed comment sits beyond the old cut-off');
    assert.ok(i.findings.some((f) => f.code === 'comment_removed'), codes(i).join());
  });

  it('every out-of-scope path is reported even when the status listing is far larger than 4 KB', async () => {
    const { repo } = repoWith({ [FILE]: 'package p\n' });
    writeFileSync(join(repo, FILE), 'package p\n\nvar X = 1\n');
    const N = 120;
    mkdirSync(join(repo, 'stray'));
    for (let k = 0; k < N; k++) writeFileSync(join(repo, 'stray', `out_of_scope_file_with_a_rather_long_name_${String(k).padStart(3, '0')}.txt`), 'x\n');
    const i = await inspect(repo);
    assert.equal(i.findings.filter((f) => f.code === 'out_of_scope_file').length, N);
    assert.ok(i.findings.some((f) => f.detail.includes(`_${String(N - 1).padStart(3, '0')}.txt`)), 'the last listed path is seen');
  });
});

describe('M9.0 review evidence: fail closed when the evidence is incomplete or unreadable', () => {
  it('git output above the evidence limit is refused, never cut', async () => {
    const { repo } = repoWith({ [FILE]: goFile(50) });
    await assert.rejects(readGitEvidence(repo, ['cat-file', 'blob', `HEAD:${FILE}`], { maxBytes: 100 }), (err: unknown) => err instanceof EvidenceError && /more than 100 bytes/.test(err.message));
    const full = await readGitEvidence(repo, ['cat-file', 'blob', `HEAD:${FILE}`]);
    assert.equal(full.stdout, goFile(50));
  });

  it('a failing git command is refused, and an exit code is accepted only when the caller says so', async () => {
    const { repo } = repoWith({ [FILE]: 'package p\n' });
    await assert.rejects(readGitEvidence(repo, ['cat-file', 'blob', 'HEAD:missing.go']), EvidenceError);
    await assert.rejects(readGitEvidence(repo, ['diff', '--no-index', '--', '/dev/null', FILE]), EvidenceError);
    assert.equal((await readGitEvidence(repo, ['diff', '--no-index', '--', '/dev/null', FILE], { okExitCodes: [0, 1] })).exitCode, 1);
  });

  it('outside a git repository the inspection blocks as evidence_incomplete and does not pretend there was "no change"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-norepo-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'pkg'));
    writeFileSync(join(dir, FILE), 'package p\n');
    const i = await inspect(dir);
    assert.ok(codes(i).includes('block:evidence_incomplete'), codes(i).join());
    assert.equal(codes(i).includes('block:no_change'), false);
  });

  it('a binary change to an allowed file cannot be reviewed as text: blocked', async () => {
    const { repo } = repoWith({ [FILE]: 'package p\n' });
    writeFileSync(join(repo, FILE), Buffer.from([0x70, 0x00, 0x01, 0x02, 0x0a]));
    const i = await inspect(repo);
    assert.ok(i.findings.some((f) => f.code === 'evidence_incomplete' && /binary/.test(f.detail)), codes(i).join());
  });

  it('a deleted tracked allowed file is blocked instead of silently skipped', async () => {
    const { repo } = repoWith({ [FILE]: 'package p\n', 'pkg/other.go': 'package p\n' });
    unlinkSync(join(repo, FILE));
    writeFileSync(join(repo, 'pkg/other.go'), 'package p\n\nvar Y = 2\n');
    const i = await inspect(repo, [FILE, 'pkg/other.go']);
    assert.ok(codes(i).includes('block:allowed_file_deleted'), codes(i).join());
    assert.deepEqual(i.changedAllowedFiles.sort(), [FILE, 'pkg/other.go'].sort());
  });

  it('an allowed file replaced by a symbolic link is blocked', async () => {
    const { repo } = repoWith({ [FILE]: 'package p\n', 'pkg/target.go': 'package p\n\nvar Z = 3\n' });
    unlinkSync(join(repo, FILE));
    symlinkSync('target.go', join(repo, FILE));
    const i = await inspect(repo);
    assert.ok(i.findings.some((f) => f.code === 'evidence_incomplete' && /symbolic link/.test(f.detail)), codes(i).join());
  });
});

describe('M9.0 evidence plumbing (units)', () => {
  it('runControlledCommand reports truncation explicitly; the 4,000-byte default for model-facing tools is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-runner-'));
    dirs.push(dir);
    const big = await runControlledCommand('sh', ['-c', 'head -c 10000 /dev/zero | tr "\\0" a'], { cwd: dir, timeoutMs: 10_000 });
    assert.equal(big.truncated, true);
    assert.match(big.stdout, /output truncated/);
    const whole = await runControlledCommand('sh', ['-c', 'head -c 10000 /dev/zero | tr "\\0" a'], { cwd: dir, timeoutMs: 10_000, maxOutputBytes: 20_000 });
    assert.equal(whole.truncated, undefined);
    assert.equal(whole.stdout.length, 10_000);
    const exact = await runControlledCommand('sh', ['-c', 'head -c 4000 /dev/zero | tr "\\0" a'], { cwd: dir, timeoutMs: 10_000 });
    assert.equal(exact.truncated, undefined, 'exactly at the limit is complete');
  });

  it('parseNumstatZ reads -z records, refuses binary changes and unreadable records', () => {
    assert.deepEqual([...parseNumstatZ('3\t1\ta.go\x0010\t0\tdir/b c.go\x00')], [['a.go', 4], ['dir/b c.go', 10]]);
    assert.throws(() => parseNumstatZ('-\t-\tbin.dat\x00'), /binary/);
    assert.throws(() => parseNumstatZ('garbage\x00'), EvidenceError);
  });
});

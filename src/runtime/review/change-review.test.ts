import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { inspectChange } from './change-review.ts';
import { classifyWhitespaceChanges } from './whitespace-changes.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const FILE = 'pkg/code.go';

/** Commits `before`, writes `after` over it, and returns the gate's findings for the working-tree change. */
async function review(before: string, after: string, file = FILE) {
  const repo = mkdtempSync(join(tmpdir(), 'review-'));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  execFileSync('mkdir', ['-p', join(repo, 'pkg')]);
  writeFileSync(join(repo, file), before);
  git('add', '-A');
  git('commit', '-qm', 'init');
  writeFileSync(join(repo, file), after);
  const inspection = await inspectChange({ repoRoot: repo, allowedFiles: [file], statusBefore: [] });
  return { findings: inspection.findings, codes: inspection.findings.map((f) => `${f.severity}:${f.code}`) };
}
const blocks = (codes: string[]) => codes.filter((c) => c.startsWith('block:'));

// A function whose body gets nested by the real change.
const STUB = `package slug

// Make returns the slug of s.
func Make(s string) string {
\treturn ""
}
`;

describe('whitespace gate: harmless reformatting accompanying a real change', () => {
  it('accepts code that moved into a new block and was re-indented with it (the false positive found in the M7.5 run)', async () => {
    const after = `package slug

import (
\t"regexp"
\t"strings"
)

// Make returns the slug of s.
func Make(s string) string {
\ts = strings.ToLower(s)
\ts = regexp.MustCompile("[^a-z0-9]+").ReplaceAllString(s, "-")
\tif s == "" {
\t\treturn ""
\t}
\treturn s
}
`;
    const { codes } = await review(STUB, after);
    assert.deepEqual(blocks(codes), []);
  });

  it('accepts a long block nested under a new condition, and reports the re-indentation for the Lead', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `\tstep${i}()`).join('\n');
    const before = `package p\n\nfunc Run() {\n${body}\n}\n`;
    const after = `package p\n\nfunc Run() {\n\tif ready() {\n${body.replace(/^\t/gm, '\t\t')}\n\t}\n}\n`;
    const { codes, findings } = await review(before, after);
    assert.deepEqual(blocks(codes), []);
    assert.ok(codes.includes('warn:whitespace_reindent'));
    assert.match(findings.find((f) => f.code === 'whitespace_reindent')!.detail, /30 line\(s\) re-indented with the change/);
  });

  it('accepts un-nesting (guard clause) and one stray trailing space next to the change', async () => {
    const before = `package p\n\nfunc F(x int) int {\n\tif x > 0 {\n\t\ta := x * 2\n\t\treturn a\n\t}\n\treturn 0\n}\n`;
    const after = `package p\n\nfunc F(x int) int {\n\tif x <= 0 {\n\t\treturn 0\n\t}\n\ta := x * 2 \n\treturn a\n}\n`;
    const { codes } = await review(before, after);
    assert.deepEqual(blocks(codes), []);
  });
});

describe('whitespace gate: suspicious whitespace-only changes stay blocked', () => {
  const SOURCE = `package p\n\nfunc A() int {\n\treturn 1\n}\n\nfunc B() int {\n\tx := 2\n\treturn x\n}\n\nfunc C() int {\n\ty := 3\n\treturn y\n}\n`;

  it('blocks a file whose only change is whitespace', async () => {
    const { codes, findings } = await review(SOURCE, SOURCE.replace(/^\t/gm, '    '));
    assert.ok(codes.includes('block:whitespace_only_change'));
    assert.match(findings.find((f) => f.code === 'whitespace_only_change')!.detail, /away from any real change|re-indented away/);
  });

  it('blocks re-indenting an unrelated function while making a real change elsewhere', async () => {
    const after = SOURCE.replace('return 1', 'return 100').replace('\tx := 2\n\treturn x', '\t\tx := 2\n\t\treturn x');
    const { codes } = await review(SOURCE, after);
    assert.ok(codes.includes('block:whitespace_only_change'), codes.join());
  });

  it('blocks a whole-file reformat (tabs to spaces) that contains one real change', async () => {
    const reformatted = SOURCE.replace('return 1', 'return 100').replace(/^\t/gm, '    ');
    const { codes } = await review(SOURCE, reformatted);
    assert.ok(codes.includes('block:whitespace_only_change'), codes.join());
  });

  it('blocks a line-ending rewrite hiding behind a real change', async () => {
    const { codes } = await review(SOURCE, SOURCE.replace('return 1', 'return 100').replace(/\n/g, '\r\n'));
    assert.ok(codes.includes('block:whitespace_only_change'), codes.join());
  });

  it('blocks trailing-space noise beyond the small tolerance, even next to the change', async () => {
    const noisy = SOURCE.replace('return 1', 'return 100').replace(/^(\t.*)$/gm, '$1 ');
    const { codes } = await review(SOURCE, noisy);
    assert.ok(codes.includes('block:whitespace_only_change'), codes.join());
  });

  it('blocks spacing noise sprinkled far from the real change', async () => {
    const after = SOURCE.replace('return 1', 'return 100').replace('y := 3', 'y  :=  3');
    const { codes } = await review(SOURCE, after);
    assert.ok(codes.includes('block:whitespace_only_change'), codes.join());
  });
});

describe('the other gates are unchanged', () => {
  it('still blocks an identical (no-op) result, a removed final newline and an out-of-scope file', async () => {
    assert.ok((await review(STUB, STUB)).codes.includes('block:no_change'));
    assert.ok((await review(STUB, STUB.replace('""', '"x"').trimEnd())).codes.includes('block:eof_newline'));
    const repo = mkdtempSync(join(tmpdir(), 'review-scope-'));
    dirs.push(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    execFileSync('mkdir', ['-p', join(repo, 'pkg')]);
    writeFileSync(join(repo, FILE), STUB);
    writeFileSync(join(repo, 'pkg/other.go'), 'package slug\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    writeFileSync(join(repo, FILE), STUB.replace('""', '"x"'));
    writeFileSync(join(repo, 'pkg/other.go'), 'package slug\n// edited\n');
    const inspection = await inspectChange({ repoRoot: repo, allowedFiles: [FILE], statusBefore: [] });
    assert.ok(inspection.findings.some((f) => f.code === 'out_of_scope_file' && f.severity === 'block'));
  });

  it('still reports removed comments and security patterns', async () => {
    const withComment = `package p\n\n// Doc.\nfunc F() {}\n`;
    const { codes } = await review(withComment, `package p\n\nfunc F() { println("hi") }\n`);
    assert.ok(codes.includes('warn:comment_removed'));
    const sec = await review(withComment, `package p\n\n// Doc.\nfunc F() { eval("x") }\n`);
    assert.ok(sec.codes.includes('block:security_block'));
  });
});

describe('classifyWhitespaceChanges (unit)', () => {
  it('has no findings for a diff with no whitespace-only lines', () => {
    const diff = '@@ -1,1 +1,1 @@\n-a\n+b\n';
    const r = classifyWhitespaceChanges(diff, diff);
    assert.equal(r.whitespaceOnly, 0);
    assert.deepEqual(r.unrelated, []);
  });
});

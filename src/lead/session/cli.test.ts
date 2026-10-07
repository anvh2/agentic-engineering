import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { checkpoint, createFixture, jestOutput, VALID_NOTES, type Fixture } from './__testing__/fixture.ts';
import { estimateTokens, TOKEN_BUDGET } from './packet.ts';
import type { Checkpoint } from './types.ts';

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});
afterEach(() => f.cleanup());

const checkpointsDir = () => join(f.harnessRoot, 'projects', 'demo', 'checkpoints');

async function latestCheckpoint(): Promise<Checkpoint> {
  const files = (await readdir(checkpointsDir())).filter((x) => x.endsWith('.json')).sort();
  return JSON.parse(await readFile(join(checkpointsDir(), files.at(-1)!), 'utf8'));
}

const resume = (...extra: string[]) => f.cli(['resume', 'demo', ...extra]);
const findingCodes = (out: string) => [...out.matchAll(/^- (CRITICAL|WARN|INFO) \[([\w-]+)\]/gm)].map((m) => `${m[1]}:${m[2]}`);

describe('checkpoint', () => {
  it('captures objective state and parsed notes, resolving repo relative to the harness root', async () => {
    await f.write('src/widget.js', 'export const w = 1;\n');
    await f.write('config/default.json', '{"db":"local-secret"}\n');
    const out = await checkpoint(f);
    assert.match(out, /Checkpoint .* written/);

    const cp = await latestCheckpoint();
    assert.equal(cp.schema, 'harness.checkpoint/1');
    assert.equal(cp.engine, 'engine-a');
    assert.equal(cp.repo.path, f.repo);
    assert.equal(cp.repo.head, f.git('rev-parse', 'HEAD').trim());
    assert.equal(cp.repo.branch, 'main');
    assert.deepEqual(cp.repo.entries.map((e) => `${e.code}|${e.path}|${e.expected}`).sort(), [
      ' M|config/default.json|true',
      '??|src/widget.js|false',
    ]);
    assert.ok(!('skipped' in cp.test));
    assert.equal(cp.test.exitCode, 0);
    assert.equal(cp.test.runner, 'jest');
    assert.equal(cp.notes.goal, 'Add the widget module.');
    assert.deepEqual(cp.referencedPaths.sort(), ['src/app.js', 'src/widget.js']);
    assert.doesNotMatch(JSON.stringify(cp), /local-secret/);
  });

  it('rejects bad notes without writing anything or running tests', async () => {
    const result = await f.cli(['checkpoint', 'demo', '--engine', 'x', '--notes', '-'], VALID_NOTES.replace(/## Next[\s\S]*$/, ''));
    assert.equal(result.code, 2);
    assert.match(result.err, /Missing section "## Next"/);
    assert.deepEqual(await readdir(checkpointsDir()).catch(() => []), []);
  });

  it('records but does not refuse dirty trees, red tests and emptied files', async () => {
    await f.write('src/app.js', '');
    await f.setTest({ exit: 1, out: jestOutput(['src/app.test.js'], []) });
    const out = await checkpoint(f);
    assert.match(out, /WARNING emptied files recorded: src\/app.js/);
    const cp = await latestCheckpoint();
    assert.deepEqual(cp.emptiedAtCapture, ['src/app.js']);
    assert.ok(!('skipped' in cp.test) && cp.test.exitCode === 1);
  });

  it('supports --no-test and a per-checkpoint test argv after "--"', async () => {
    await checkpoint(f, ['--no-test']);
    assert.deepEqual((await latestCheckpoint()).test, { skipped: true });
    await checkpoint(f, ['--', 'node', '-e', 'process.exit(3)']);
    const cp = await latestCheckpoint();
    assert.ok(!('skipped' in cp.test));
    assert.deepEqual(cp.test.command, ['node', '-e', 'process.exit(3)']);
    assert.equal(cp.test.exitCode, 3);
  });

  it('prints the notes template', async () => {
    const result = await f.cli(['checkpoint', 'demo', '--template']);
    assert.match(result.out, /## Goal[\s\S]*## Next/);
  });
});

describe('resume', () => {
  it('is CLEAN when nothing changed, includes principles/STATE/notes, and stays within budget', async () => {
    await checkpoint(f);
    const { code, out } = await resume();
    assert.equal(code, 0);
    assert.match(out, /## Verdict: CLEAN/);
    assert.match(out, /Repository evidence wins/);
    assert.match(out, /Goal: ship widgets/);
    assert.match(out, /\*\*Next:\*\* Write tests for src\/widget.js/);
    assert.match(out, /Do not commit, revert or modify: config\/default.json, docs\//);
    assert.ok(estimateTokens(out) < TOKEN_BUDGET, `packet is ${estimateTokens(out)} tokens`);
  });

  it('reports intentional local state as info, never drift', async () => {
    await f.write('config/default.json', '{"db":"local"}\n');
    await checkpoint(f);
    const { out } = await resume();
    assert.match(out, /## Verdict: CLEAN/);
    assert.deepEqual(findingCodes(out), ['INFO:expected-local']);
  });

  it('flags a branch change as critical', async () => {
    await checkpoint(f);
    f.git('checkout', '-q', '-b', 'other');
    assert.ok(findingCodes((await resume('--no-test')).out).includes('CRITICAL:branch-changed'));
  });

  it('flags HEAD advance as a warning with the commit log, and committed files as info', async () => {
    await f.write('src/widget.js', 'x\n');
    await checkpoint(f);
    f.git('add', '.');
    f.git('commit', '-q', '-m', 'add widget');
    const { out } = await resume('--no-test');
    assert.deepEqual(findingCodes(out).sort(), ['INFO:no-longer-dirty', 'INFO:tests-not-reverified', 'WARN:head-advanced']);
    assert.match(out, /\+1 commits.*add widget/);
    assert.match(out, /likely committed/);
  });

  it('flags a rewritten history as critical', async () => {
    f.git('commit', '-q', '--allow-empty', '-m', 'second');
    await checkpoint(f);
    f.git('reset', '-q', '--hard', 'HEAD~1');
    assert.ok(findingCodes((await resume('--no-test')).out).includes('CRITICAL:head-rewritten'));
  });

  it('flags files modified after checkpoint, newly dirty files, and reverted files', async () => {
    await f.write('src/widget.js', 'v1\n');
    await f.write('src/app.js', 'changed\n');
    await checkpoint(f);
    await f.write('src/widget.js', 'v2\n');
    await f.write('src/other.js', 'new\n');
    f.git('checkout', '--', 'src/app.js');
    const codes = findingCodes((await resume('--no-test')).out);
    assert.ok(codes.includes('WARN:modified-after-checkpoint'));
    assert.ok(codes.includes('WARN:newly-dirty'));
    assert.ok(codes.includes('WARN:no-longer-dirty'));
  });

  it('fingerprints files inside a new untracked directory, but folds expected-local dirs', async () => {
    await mkdir(join(f.repo, 'tools', 'pkg', 'src'), { recursive: true });
    await f.write('tools/pkg/src/index.ts', 'v1\n');
    await mkdir(join(f.repo, 'docs', 'photos'), { recursive: true });
    await f.write('docs/photos/a.jpg', 'x');
    await checkpoint(f);
    const paths = (await latestCheckpoint()).repo.entries.map((e) => e.path);
    assert.ok(paths.includes('tools/pkg/src/index.ts'));
    assert.ok(paths.includes('docs/') && !paths.includes('docs/photos/a.jpg'));

    await f.write('tools/pkg/src/index.ts', 'v2\n');
    await f.write('docs/photos/b.jpg', 'y');
    const codes = findingCodes((await resume('--no-test')).out);
    assert.deepEqual(codes.sort(), ['INFO:expected-local', 'INFO:tests-not-reverified', 'WARN:modified-after-checkpoint']);
  });

  it('warns when a protected local file changes after checkpoint', async () => {
    await f.write('config/default.json', '{"db":"a"}\n');
    await checkpoint(f);
    await f.write('config/default.json', '{"db":"b"}\n');
    assert.ok(findingCodes((await resume('--no-test')).out).includes('WARN:expected-local-modified'));
  });

  it('flags truncation of a non-empty file but not files that are empty in HEAD', async () => {
    await checkpoint(f);
    await f.write('src/app.js', '');
    const { out } = await resume('--no-test');
    assert.ok(findingCodes(out).includes('CRITICAL:file-emptied'));
    assert.match(out, /src\/app.js is 0 bytes/);
    assert.doesNotMatch(out, /src\/empty.js is 0 bytes/);
  });

  it('flags an untracked file that was non-empty at checkpoint and is now empty', async () => {
    await f.write('src/widget.js', 'content\n');
    await checkpoint(f);
    await f.write('src/widget.js', '');
    assert.match((await resume('--no-test')).out, /CRITICAL \[file-emptied\] src\/widget.js/);
  });

  it('warns when a path referenced in the notes disappears', async () => {
    await f.write('src/widget.js', 'x\n');
    await checkpoint(f);
    await rm(join(f.repo, 'src/widget.js'));
    assert.match((await resume('--no-test')).out, /WARN \[referenced-missing\] src\/widget.js/);
  });

  it('detects a jest regression on an already-red baseline (red -> red, new failing suite)', async () => {
    await f.setTest({ exit: 1, out: jestOutput(['src/a.test.js'], ['src/b.test.js']) });
    await checkpoint(f);
    await f.setTest({ exit: 1, out: jestOutput(['src/a.test.js', 'src/b.test.js'], []) });
    const { out } = await resume();
    assert.match(out, /CRITICAL \[test-regression\] New failing suites since checkpoint: src\/b.test.js/);

    await f.setTest({ exit: 1, out: jestOutput(['src/a.test.js'], ['src/b.test.js']) });
    assert.match((await resume()).out, /## Verdict: CLEAN/);
  });

  it('reruns the checkpoint\'s recorded test command, and treats a timeout as UNKNOWN', async () => {
    await checkpoint(f);
    await f.setProject({ test: { command: ['node', '-e', 'process.exit(9)'], timeoutMs: 300 } });
    await f.setTest({ exit: 0, out: jestOutput([], ['src/app.test.js']), sleepMs: 5_000 });
    const { out } = await resume();
    assert.match(out, /WARN \[tests-unknown\].*TIMED OUT/);
  });

  it('never modifies the checkpoint it reads', async () => {
    await checkpoint(f);
    const file = join(checkpointsDir(), (await readdir(checkpointsDir()))[0]);
    const hash = async () => createHash('sha256').update(await readFile(file)).digest('hex');
    const before = await hash();
    await f.write('src/app.js', '');
    await resume();
    await f.cli(['status', 'demo', '--test']);
    assert.equal(await hash(), before);
  });

  it('uses the latest checkpoint by default and an explicit one with --checkpoint', async () => {
    await checkpoint(f);
    const first = (await latestCheckpoint()).id;
    await f.write('src/widget.js', 'x\n');
    await checkpoint(f);
    const second = (await latestCheckpoint()).id;
    assert.notEqual(first, second);
    assert.match((await resume('--no-test')).out, new RegExp(`checkpoint ${second}`));
    assert.match((await resume('--no-test', '--checkpoint', first)).out, new RegExp(`checkpoint ${first}`));
  });

  it('warns about an oversized packet without truncating STATE.md', async () => {
    await checkpoint(f);
    const big = `# demo\n${'decision line that matters. '.repeat(400)}END-OF-STATE\n`;
    await writeFile(join(f.harnessRoot, 'projects', 'demo', 'STATE.md'), big);
    const { out } = await resume('--no-test');
    assert.match(out, /END-OF-STATE/);
    assert.match(out, /WARNING: packet is ~\d+ tokens/);
  });
});

describe('status', () => {
  it('works before any checkpoint and exits 0', async () => {
    const { code, out } = await f.cli(['status', 'demo']);
    assert.equal(code, 0);
    assert.match(out, /no checkpoint yet/);
    assert.match((await f.cli(['status', 'demo', '--test'])).out, /tests now: exit 0; Test Suites: 1 passed/);
  });

  it('exits 1 on critical drift', async () => {
    await checkpoint(f);
    f.git('checkout', '-q', '-b', 'other');
    assert.equal((await f.cli(['status', 'demo'])).code, 1);
  });
});

describe('errors', () => {
  it('refuses with exit 3 when the repository identity does not match', async () => {
    await f.setProject({ identity: { rootCommit: 'f'.repeat(40) } });
    const { code, err } = await f.cli(['status', 'demo']);
    assert.equal(code, 3);
    assert.match(err, /identity mismatch/);
  });

  it('gives clear errors for unknown project, non-git repo, missing checkpoint, malformed checkpoint and bad args', async () => {
    assert.match((await f.cli(['status', 'nope'])).err, /Unknown project "nope"/);
    assert.match((await f.cli(['status', '../x'])).err, /Invalid project name/);
    assert.match((await f.cli(['resume', 'demo'])).err, /No checkpoint for "demo"/);
    assert.match((await f.cli(['status', 'demo', '--bogus'])).err, /Unknown argument "--bogus"/);
    assert.match((await f.cli(['checkpoint', 'demo', '--notes', '-'])).err, /requires --engine and --notes/);

    await checkpoint(f);
    const file = join(checkpointsDir(), (await readdir(checkpointsDir()))[0]);
    await writeFile(file, '{not json');
    assert.match((await resume()).err, /not valid JSON/);

    await f.setProject({ repo: '../tools' });
    const result = await f.cli(['status', 'demo']);
    assert.equal(result.code, 2);
    assert.match(result.err, /Cannot read repository/);
  });
});

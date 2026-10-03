import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, type Fixture } from './__testing__/fixture.ts';
import { emptiedFiles, isExpectedLocal, parsePorcelainZ, parseShortStat, relateHeads, takeSnapshot } from './snapshot.ts';

describe('snapshot parsing', () => {
  it('parses porcelain -z including renames', () => {
    assert.deepEqual(parsePorcelainZ(' M a.js\0R  new.js\0old.js\0?? docs/\0'), [
      { code: ' M', path: 'a.js' },
      { code: 'R ', path: 'new.js' },
      { code: '??', path: 'docs/' },
    ]);
  });

  it('parses shortstat', () => {
    assert.deepEqual(parseShortStat(' 2 files changed, 4 insertions(+), 1 deletion(-)\n'), { files: 2, insertions: 4, deletions: 1 });
    assert.deepEqual(parseShortStat(''), { files: 0, insertions: 0, deletions: 0 });
  });

  it('matches expected-local files exactly and directories by prefix', () => {
    const expected = ['config/default.json', 'docs/'];
    assert.equal(isExpectedLocal('config/default.json', expected), true);
    assert.equal(isExpectedLocal('config/default.json.bak', expected), false);
    assert.equal(isExpectedLocal('docs/a/b.png', expected), true);
    assert.equal(isExpectedLocal('docsx', expected), false);
  });
});

describe('takeSnapshot', () => {
  let f: Fixture;
  before(async () => {
    f = await createFixture();
  });
  after(() => f.cleanup());

  it('records identity, branch, dirty entries with hashes and HEAD sizes, and never diff content', async () => {
    await f.write('config/default.json', '{"db":"local-secret"}\n');
    await f.write('src/app.js', '');
    await mkdir(join(f.repo, 'docs'));
    await f.write('docs/photo.txt', 'x');
    await f.write('src/new.js', 'new\n');

    const snap = await takeSnapshot(f.repo, ['config/default.json', 'docs/']);
    assert.equal(snap.branch, 'main');
    assert.equal(snap.rootCommit, f.git('rev-list', '--max-parents=0', 'HEAD').trim());
    const byPath = Object.fromEntries(snap.entries.map((e) => [e.path, e]));
    assert.equal(byPath['config/default.json'].expected, true);
    assert.equal(byPath['config/default.json'].sha, f.git('hash-object', 'config/default.json').trim());
    assert.equal(byPath['docs/'].kind, 'dir');
    assert.equal(byPath['docs/'].expected, true);
    assert.equal(byPath['src/new.js'].code, '??');
    assert.equal(byPath['src/app.js'].headSize, 'export const registry = {};\n'.length);
    assert.doesNotMatch(JSON.stringify(snap), /local-secret/);

    // Truncated non-empty file is flagged; src/empty.js (empty in HEAD) is not.
    await f.write('src/empty.js', '');
    assert.deepEqual(emptiedFiles(snap), ['src/app.js']);
    f.git('checkout', '--', '.');
  });

  it('reports detached HEAD as branch null', async () => {
    f.git('checkout', '-q', '--detach');
    const snap = await takeSnapshot(f.repo, []);
    assert.equal(snap.branch, null);
    f.git('checkout', '-q', 'main');
  });

  it('relates heads: same, advanced, rewritten, unknown', async () => {
    const base = f.git('rev-parse', 'HEAD').trim();
    assert.equal((await relateHeads(f.repo, base, base)).relation, 'same');
    f.git('commit', '-q', '--allow-empty', '-m', 'next');
    const next = f.git('rev-parse', 'HEAD').trim();
    const advanced = await relateHeads(f.repo, base, next);
    assert.equal(advanced.relation, 'advanced');
    assert.equal(advanced.commitCount, 1);
    assert.match(advanced.log[0], /next/);
    assert.equal((await relateHeads(f.repo, next, base)).relation, 'rewritten');
    assert.equal((await relateHeads(f.repo, 'f'.repeat(40), base)).relation, 'unknown');
    f.git('reset', '-q', '--hard', base);
  });
});

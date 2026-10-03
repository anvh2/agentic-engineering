import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFile, searchFiles } from './repository-tools.ts';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';
import { callTool } from './__testing__/call-tool.ts';
import { contextFor } from './__testing__/context-for.ts';

// Mirrors MAX_READ_FILE_BYTES in repository-tools.ts. Kept independent
// (not imported) so the test also catches an accidental change to that
// constant that isn't reflected here.
const MAX_READ_FILE_BYTES = 3_000;
const MAX_SEARCH_MATCHES = 20;
const MAX_SEARCH_FILES = 2000;

describe('readFile size limits', () => {
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await createFixtureRepo();
    await writeFile(join(fixture.root, 'small.txt'), 'a small file\n');
    await writeFile(join(fixture.root, 'large.txt'), `${'x'.repeat(MAX_READ_FILE_BYTES + 5_000)}\n`);
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('returns complete content for a file under the limit', async () => {
    const result = await callTool(readFile.execute!({ path: 'small.txt' }, contextFor(fixture.root)));
    assert.equal(result.content, 'a small file\n');
    assert.equal(result.truncated, false);
    assert.equal(result.totalBytes, Buffer.byteLength('a small file\n'));
  });

  it('caps output and clearly marks it as truncated for a file over the limit', async () => {
    const result = await callTool(readFile.execute!({ path: 'large.txt' }, contextFor(fixture.root)));

    assert.equal(result.truncated, true);
    assert.ok(result.totalBytes > MAX_READ_FILE_BYTES);
    // The full file is never loaded past what's needed to report a size -
    // returned content must stay close to the cap, not the file's real size.
    assert.ok(Buffer.byteLength(result.content) < MAX_READ_FILE_BYTES + 500);
    // A model reading only `content` (not the separate `truncated` boolean)
    // must still be able to tell the file was cut off, with real numbers.
    assert.match(result.content, /truncated/i);
    assert.match(result.content, new RegExp(String(MAX_READ_FILE_BYTES)));
    assert.match(result.content, new RegExp(String(result.totalBytes)));
  });
});

describe('searchFiles result limits', () => {
  describe('MAX_SEARCH_MATCHES', () => {
    let fixture: FixtureRepo;

    before(async () => {
      fixture = await createFixtureRepo();
      const lines = Array.from({ length: MAX_SEARCH_MATCHES + 10 }, (_, i) => `MATCH_PROBE line ${i}`).join('\n');
      await writeFile(join(fixture.root, 'many-matches.txt'), `${lines}\n`);
    });

    after(async () => {
      await fixture.cleanup();
    });

    it('never returns more matches than the configured maximum, and says so', async () => {
      const result = await callTool(
        searchFiles.execute!({ query: 'MATCH_PROBE' }, contextFor(fixture.root)),
      );
      assert.equal(result.matches.length, MAX_SEARCH_MATCHES);
      assert.equal(result.truncated, true);
      assert.ok(result.notice, 'expected a notice explaining the results are incomplete');
      assert.match(result.notice!, /matches/i);
    });
  });

  describe('MAX_SEARCH_FILES', () => {
    let fixture: FixtureRepo;

    before(async () => {
      fixture = await createFixtureRepo();
      const bulkDir = join(fixture.root, 'bulk');
      await mkdir(bulkDir, { recursive: true });
      const batchSize = 200;
      const total = MAX_SEARCH_FILES + 1;
      for (let start = 0; start < total; start += batchSize) {
        const batch: Promise<void>[] = [];
        for (let i = start; i < Math.min(start + batchSize, total); i += 1) {
          batch.push(writeFile(join(bulkDir, `file-${i}.txt`), 'unrelated content\n'));
        }
        await Promise.all(batch);
      }
    });

    after(async () => {
      await fixture.cleanup();
    });

    it('stops scanning after the configured file-count limit and says so', async () => {
      // Query matches nothing, isolating this from the MAX_SEARCH_MATCHES path -
      // truncation here can only be explained by the file-scan limit.
      const result = await callTool(
        searchFiles.execute!({ query: 'ZZZ_FILE_LIMIT_PROBE_NOT_PRESENT' }, contextFor(fixture.root)),
      );
      assert.deepEqual(result.matches, []);
      assert.equal(result.truncated, true);
      assert.ok(result.notice, 'expected a notice explaining the results are incomplete');
      assert.match(result.notice!, /scan/i);
    });
  });
});

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile as readFileFromDisk } from 'node:fs/promises';
import { join } from 'node:path';
import { applyPatch } from './repository-tools.ts';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';
import { contextFor } from './__testing__/context-for.ts';

/**
 * Narrow regression test, kept in its own file rather than folded into
 * repository-tools-write.test.ts: the `diff` package's parsePatch('') does
 * not return an empty array as applyPatch's "is this patch empty" guard
 * assumed - it returns a single file entry with an empty hunks array. That
 * made the guard dead code, so an empty patch string silently "succeeded"
 * (success: true) without changing anything, instead of being rejected.
 */
describe('applyPatch: empty patch handling', () => {
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await createFixtureRepo();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('rejects an empty patch string instead of silently reporting success', async () => {
    const before = await readFileFromDisk(join(fixture.root, 'README.md'), 'utf8');

    await assert.rejects(
      () => applyPatch.execute!({ path: 'README.md', patch: '' }, contextFor(fixture.root)),
      /empty/,
    );

    const after = await readFileFromDisk(join(fixture.root, 'README.md'), 'utf8');
    assert.equal(after, before);
  });
});

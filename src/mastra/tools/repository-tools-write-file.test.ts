import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile as readRaw, stat, symlink, writeFile as writeRaw } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFile } from './repository-tools.ts';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';
import { callTool } from './__testing__/call-tool.ts';
import { contextFor } from './__testing__/context-for.ts';

describe('writeFile', () => {
  let fixture: FixtureRepo;
  before(async () => {
    fixture = await createFixtureRepo();
  });
  after(() => fixture.cleanup());

  it('replaces an existing file with the full content', async () => {
    const result = await callTool(writeFile.execute!({ path: 'README.md', content: 'new\n' }, contextFor(fixture.root)));
    assert.equal(result.success, true);
    assert.equal(result.created, false);
    assert.equal(await readRaw(join(fixture.root, 'README.md'), 'utf8'), 'new\n');
  });

  it('creates a new file when the parent exists, and rejects a missing parent', async () => {
    const ok = await callTool(writeFile.execute!({ path: 'internal/new.go', content: 'package internal\n' }, contextFor(fixture.root)));
    assert.equal(ok.created, true);
    await assert.rejects(callTool(writeFile.execute!({ path: 'nope/new.go', content: 'x' }, contextFor(fixture.root))), /parent directory/);
  });

  it('rejects empty content, oversize content, and paths outside the repository', async () => {
    await assert.rejects(callTool(writeFile.execute!({ path: 'README.md', content: '  \n' }, contextFor(fixture.root))), /empty/);
    await assert.rejects(callTool(writeFile.execute!({ path: 'README.md', content: 'x'.repeat(20_001) }, contextFor(fixture.root))), /exceeds/);
    await assert.rejects(callTool(writeFile.execute!({ path: '../escape.txt', content: 'x' }, contextFor(fixture.root))));
  });

  it('refuses to write through a symlink', async () => {
    await writeRaw(join(fixture.root, 'real.txt'), 'real');
    await symlink(join(fixture.root, 'real.txt'), join(fixture.root, 'link.txt'));
    await assert.rejects(callTool(writeFile.execute!({ path: 'link.txt', content: 'x' }, contextFor(fixture.root))));
    assert.equal(await readRaw(join(fixture.root, 'real.txt'), 'utf8'), 'real');
  });
});

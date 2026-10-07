import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile as readRaw, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoFmt } from './execution-tools.ts';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';
import { callTool } from './__testing__/call-tool.ts';
import { contextFor } from './__testing__/context-for.ts';

const FORMATTED = 'package internal\n\nfunc Foo() int {\n\treturn 1\n}\n';
const UNFORMATTED = 'package internal\n\nfunc Foo() int {\nreturn 1\n}\n';
const INVALID_SYNTAX = 'package internal\n\nfunc Foo( int {\n';

describe('runGoFmt', () => {
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await createFixtureRepo();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('reports no change for an already-formatted file, and leaves it byte-identical', async () => {
    await writeFile(join(fixture.root, 'internal', 'already.go'), FORMATTED);
    const result = await callTool(runGoFmt.execute!({ path: 'internal/already.go' }, contextFor(fixture.root)));

    assert.equal(result.success, true);
    assert.equal(result.changed, false);
    const onDisk = await readRaw(join(fixture.root, 'internal', 'already.go'), 'utf8');
    assert.equal(onDisk, FORMATTED);
  });

  it('formats an unformatted file in place and reports that it changed', async () => {
    await writeFile(join(fixture.root, 'internal', 'messy.go'), UNFORMATTED);
    const result = await callTool(runGoFmt.execute!({ path: 'internal/messy.go' }, contextFor(fixture.root)));

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    const onDisk = await readRaw(join(fixture.root, 'internal', 'messy.go'), 'utf8');
    assert.equal(onDisk, FORMATTED);
  });

  it('handles invalid Go source cleanly, without modifying the file', async () => {
    await writeFile(join(fixture.root, 'internal', 'invalid.go'), INVALID_SYNTAX);
    const result = await callTool(runGoFmt.execute!({ path: 'internal/invalid.go' }, contextFor(fixture.root)));

    assert.equal(result.success, false);
    assert.equal(result.changed, false);
    assert.notEqual(result.stderr, '');
    const onDisk = await readRaw(join(fixture.root, 'internal', 'invalid.go'), 'utf8');
    assert.equal(onDisk, INVALID_SYNTAX);
  });

  it('rejects a path outside the repository', async () => {
    await assert.rejects(
      () => runGoFmt.execute!({ path: '../outside.go' }, contextFor(fixture.root)),
      /outside the repository root/,
    );
  });

  it('rejects a symlink-mediated path, even one whose real target is inside the repository', async () => {
    const aliasPath = join(fixture.root, 'go-fmt-alias.go');
    await symlink(join(fixture.root, 'internal', 'service.go'), aliasPath, 'file');
    try {
      await assert.rejects(
        () => runGoFmt.execute!({ path: 'go-fmt-alias.go' }, contextFor(fixture.root)),
        /reached through a symlink/,
      );
    } finally {
      await rm(aliasPath, { force: true });
    }
  });

  it('rejects a symlink escaping the repository', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'go-fmt-outside-'));
    const outsideFile = join(outsideDir, 'outside.go');
    await writeFile(outsideFile, UNFORMATTED);
    const escapeLink = join(fixture.root, 'outside-fmt-link.go');
    await symlink(outsideFile, escapeLink, 'file');

    try {
      await assert.rejects(
        () => runGoFmt.execute!({ path: 'outside-fmt-link.go' }, contextFor(fixture.root)),
        /outside the repository root/,
      );
      const outsideContent = await readRaw(outsideFile, 'utf8');
      assert.equal(outsideContent, UNFORMATTED, 'the file outside the repository must be untouched');
    } finally {
      await rm(escapeLink, { force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

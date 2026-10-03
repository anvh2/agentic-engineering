import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles, readFile, searchFiles } from './repository-tools.ts';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';
import { callTool } from './__testing__/call-tool.ts';
import { contextFor } from './__testing__/context-for.ts';

/**
 * Symlink escape policy: any path that *resolves* outside the repository
 * root is rejected, including paths reached through a symlink anywhere in
 * the chain (see resolveWithinRepository's realpath-based check). Symlinks
 * that stay inside the repository are unaffected.
 */
describe('repository tools: symlink boundary enforcement', () => {
  let fixture: FixtureRepo;
  let outsideDir: string;

  before(async () => {
    fixture = await createFixtureRepo();
    outsideDir = await mkdtemp(join(tmpdir(), 'repo-tools-outside-'));
    await writeFile(join(outsideDir, 'secret.txt'), 'OUTSIDE_SECRET_MARKER\n');

    await symlink(outsideDir, join(fixture.root, 'outside-link'), 'dir');
    await symlink(join(outsideDir, 'secret.txt'), join(fixture.root, 'secret-link'), 'file');
    await mkdir(join(fixture.root, 'internal', 'nested'), { recursive: true });
    await symlink(outsideDir, join(fixture.root, 'internal', 'external'), 'dir');
    await symlink(join(outsideDir, 'does-not-exist.txt'), join(fixture.root, 'broken-link'), 'file');
    // A symlink that stays inside the repository - the policy must not
    // reject symlinks outright, only ones that escape.
    await symlink(join(fixture.root, 'internal', 'service.go'), join(fixture.root, 'internal-alias.go'), 'file');
  });

  after(async () => {
    await fixture.cleanup();
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('rejects readFile through a directory symlink to outside the repository', async () => {
    await assert.rejects(
      () => readFile.execute!({ path: 'outside-link/secret.txt' }, contextFor(fixture.root)),
      /outside the repository root/,
    );
  });

  it('rejects readFile of a file symlink pointing outside the repository', async () => {
    await assert.rejects(
      () => readFile.execute!({ path: 'secret-link' }, contextFor(fixture.root)),
      /outside the repository root/,
    );
  });

  it('rejects readFile through a nested directory symlink to outside the repository', async () => {
    await assert.rejects(
      () => readFile.execute!({ path: 'internal/external/secret.txt' }, contextFor(fixture.root)),
      /outside the repository root/,
    );
  });

  it('rejects listFiles on a directory symlink target that resolves outside the repository', async () => {
    await assert.rejects(
      () => listFiles.execute!({ path: 'outside-link' }, contextFor(fixture.root)),
      /outside the repository root/,
    );
    await assert.rejects(
      () => listFiles.execute!({ path: 'internal/external' }, contextFor(fixture.root)),
      /outside the repository root/,
    );
  });

  it('rejects searchFiles scoped to a directory symlink target outside the repository', async () => {
    await assert.rejects(
      () => searchFiles.execute!({ query: 'OUTSIDE_SECRET_MARKER', path: 'outside-link' }, contextFor(fixture.root)),
      /outside the repository root/,
    );
  });

  it('does not follow a directory symlink during a recursive, unscoped search', async () => {
    const result = await callTool(
      searchFiles.execute!({ query: 'OUTSIDE_SECRET_MARKER' }, contextFor(fixture.root)),
    );
    assert.deepEqual(result.matches, []);
  });

  it('reports a controlled error, not a crash, for a broken symlink', async () => {
    await assert.rejects(
      () => readFile.execute!({ path: 'broken-link' }, contextFor(fixture.root)),
      /No such file or directory/,
    );
  });

  it('lists symlink entries with an explicit "symlink" type instead of traversing them', async () => {
    const result = await callTool(listFiles.execute!({ path: '.' }, contextFor(fixture.root)));
    const outsideLink = result.entries.find((entry) => entry.name === 'outside-link');
    const secretLink = result.entries.find((entry) => entry.name === 'secret-link');
    assert.equal(outsideLink?.type, 'symlink');
    assert.equal(secretLink?.type, 'symlink');
    // None of the outside directory's own contents should appear.
    assert.ok(!result.entries.some((entry) => entry.name === 'secret.txt'));
  });

  it('does not reject a symlink whose target stays inside the repository', async () => {
    const result = await callTool(
      readFile.execute!({ path: 'internal-alias.go' }, contextFor(fixture.root)),
    );
    assert.match(result.content, /func CalculateTotal/);
  });
});

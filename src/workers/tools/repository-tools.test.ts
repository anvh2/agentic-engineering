import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RequestContext } from '@mastra/core/request-context';
import { listFiles, readFile, resolveWithinRepository, searchFiles } from './repository-tools.ts';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';
import { callTool } from './__testing__/call-tool.ts';
import { contextFor } from './__testing__/context-for.ts';

describe('resolveWithinRepository (path boundary enforcement)', () => {
  // Deliberately nonexistent - the pure path-math checks (traversal, prefix
  // confusion) must not require anything to actually exist on disk.
  // realpathTolerant() falls back to path-only resolution once it walks up
  // to an ancestor that doesn't exist either (see repository-symlink-security
  // tests for the disk-backed, symlink-aware cases).
  const root = '/tmp/test-repository-does-not-exist';

  it('allows a valid top-level relative path', async () => {
    await assert.doesNotReject(() => resolveWithinRepository(root, 'src/service.go'));
  });

  it('allows a nested relative path', async () => {
    await assert.doesNotReject(() => resolveWithinRepository(root, 'internal/service/service.go'));
  });

  it('rejects a single parent traversal', async () => {
    await assert.rejects(() => resolveWithinRepository(root, '../outside.txt'), /outside the repository root/);
  });

  it('rejects a deep parent traversal', async () => {
    await assert.rejects(() => resolveWithinRepository(root, '../../outside.txt'), /outside the repository root/);
  });

  it('rejects an absolute path outside the repository', async () => {
    await assert.rejects(() => resolveWithinRepository(root, '/etc/hosts'), /outside the repository root/);
  });

  it('rejects a sibling directory that merely shares the root as a string prefix', async () => {
    // "/tmp/repository-secret" is not inside "/tmp/repo" - a naive
    // `candidate.startsWith(root)` check would wrongly allow this because
    // the *string* "/tmp/repository-secret" starts with "/tmp/repo".
    await assert.rejects(
      () => resolveWithinRepository('/tmp/repo-does-not-exist', '/tmp/repository-secret-does-not-exist/file'),
      /outside the repository root/,
    );
  });

  it('allows the repository root itself', async () => {
    await assert.doesNotReject(() => resolveWithinRepository(root, '.'));
    await assert.doesNotReject(() => resolveWithinRepository(root, undefined));
  });
});

describe('repository tools', () => {
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await createFixtureRepo();
  });

  after(async () => {
    await fixture.cleanup();
  });

  describe('listFiles', () => {
    it('lists the repository root', async () => {
      const result = await callTool(listFiles.execute!({ path: '.' }, contextFor(fixture.root)));
      const names = result.entries.map((entry) => entry.name).sort();
      assert.deepEqual(names, ['README.md', 'go.mod', 'internal']);
    });

    it('lists a nested directory', async () => {
      const result = await callTool(listFiles.execute!({ path: 'internal' }, contextFor(fixture.root)));
      const names = result.entries.map((entry) => entry.name).sort();
      assert.deepEqual(names, ['service.go', 'service_test.go']);
    });

    it('returns a controlled error for a nonexistent directory', async () => {
      await assert.rejects(
        () => listFiles.execute!({ path: 'does-not-exist' }, contextFor(fixture.root)),
        /No such file or directory/,
      );
    });

    it('rejects a path outside the repository', async () => {
      await assert.rejects(
        () => listFiles.execute!({ path: '../../etc' }, contextFor(fixture.root)),
        /outside the repository root/,
      );
    });
  });

  describe('readFile', () => {
    it('reads a valid file', async () => {
      const result = await callTool(
        readFile.execute!({ path: 'internal/service.go' }, contextFor(fixture.root)),
      );
      assert.match(result.content, /func CalculateTotal/);
      assert.equal(result.truncated, false);
    });

    it('returns a controlled error for a nonexistent file', async () => {
      await assert.rejects(
        () => readFile.execute!({ path: 'internal/missing.go' }, contextFor(fixture.root)),
        /No such file or directory/,
      );
    });

    it('refuses to read a directory as a file', async () => {
      await assert.rejects(
        () => readFile.execute!({ path: 'internal' }, contextFor(fixture.root)),
        /is a directory/,
      );
    });

    it('rejects a path outside the repository', async () => {
      await assert.rejects(
        () => readFile.execute!({ path: '../outside.txt' }, contextFor(fixture.root)),
        /outside the repository root/,
      );
    });
  });

  describe('searchFiles', () => {
    it('finds known text across the repository', async () => {
      const result = await callTool(
        searchFiles.execute!({ query: 'CalculateTotal' }, contextFor(fixture.root)),
      );
      assert.ok(result.matches.length > 0);
      assert.ok(result.matches.some((match) => match.path === 'internal/service.go'));
    });

    it('restricts the search to a given directory', async () => {
      const result = await callTool(
        searchFiles.execute!({ query: 'module', path: 'internal' }, contextFor(fixture.root)),
      );
      // "module" only appears in go.mod, which lives outside internal/.
      assert.deepEqual(result.matches, []);
    });

    it('handles a no-match search cleanly', async () => {
      const result = await callTool(
        searchFiles.execute!({ query: 'ZZZ_TOKEN_NOT_PRESENT_ANYWHERE' }, contextFor(fixture.root)),
      );
      assert.deepEqual(result.matches, []);
      assert.equal(result.truncated, false);
    });

    it('rejects a search path outside the repository', async () => {
      await assert.rejects(
        () => searchFiles.execute!({ query: 'anything', path: '../../etc' }, contextFor(fixture.root)),
        /outside the repository root/,
      );
    });
  });
});

describe('repository tools without a configured repository', () => {
  it('every tool fails closed when no repository root is set', async () => {
    const emptyContext = { requestContext: new RequestContext() } as any;
    await assert.rejects(() => listFiles.execute!({ path: '.' }, emptyContext), /No repository is configured/);
    await assert.rejects(
      () => readFile.execute!({ path: 'README.md' }, emptyContext),
      /No repository is configured/,
    );
    await assert.rejects(
      () => searchFiles.execute!({ query: 'anything' }, emptyContext),
      /No repository is configured/,
    );
  });
});

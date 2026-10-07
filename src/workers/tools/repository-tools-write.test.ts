import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile as readRaw, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPatch } from 'diff';
import { applyPatch, readFile } from './repository-tools.ts';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';
import { callTool } from './__testing__/call-tool.ts';
import { contextFor } from './__testing__/context-for.ts';

const MAX_PATCH_BYTES = 20_000;
const MAX_CHANGED_LINES = 200;

const README_CONTENT = '# Fixture repository\n\nUsed by repository-tools tests.\n';

describe('applyPatch: valid changes', () => {
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await createFixtureRepo();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('applies a patch that matches the current file content and reports success', async () => {
    const original = README_CONTENT;
    const updated = `${README_CONTENT}\nAppended by a valid patch.\n`;
    const patch = createPatch('README.md', original, updated);

    const result = await callTool(applyPatch.execute!({ path: 'README.md', patch }, contextFor(fixture.root)));

    assert.equal(result.success, true);
    assert.equal(result.path, 'README.md');
    assert.equal(result.created, false);

    const onDisk = await callTool(readFile.execute!({ path: 'README.md' }, contextFor(fixture.root)));
    assert.equal(onDisk.content, updated);
  });

  it('returns a diff that accurately reflects the actual change', async () => {
    const original = await callTool(
      readFile.execute!({ path: 'internal/service.go' }, contextFor(fixture.root)),
    );
    const updated = original.content.replace(
      'func CalculateTotal',
      'func Helper(x int) int {\n\treturn x * 2\n}\n\nfunc CalculateTotal',
    );
    const patch = createPatch('internal/service.go', original.content, updated);

    const result = await callTool(
      applyPatch.execute!({ path: 'internal/service.go', patch }, contextFor(fixture.root)),
    );

    assert.match(result.diff, /\+func Helper\(x int\) int \{/);
    assert.doesNotMatch(result.diff, /-func CalculateTotal/); // unrelated existing line must not show as removed

    const onDisk = await callTool(
      readFile.execute!({ path: 'internal/service.go' }, contextFor(fixture.root)),
    );
    assert.match(onDisk.content, /func Helper\(x int\) int \{/);
  });

  it('creates a new file inside an existing directory', async () => {
    const patch = createPatch('internal/new_helper.go', '', 'package internal\n\nvar Answer = 42\n');

    const result = await callTool(
      applyPatch.execute!({ path: 'internal/new_helper.go', patch }, contextFor(fixture.root)),
    );

    assert.equal(result.success, true);
    assert.equal(result.created, true);

    const onDisk = await callTool(
      readFile.execute!({ path: 'internal/new_helper.go' }, contextFor(fixture.root)),
    );
    assert.equal(onDisk.content, 'package internal\n\nvar Answer = 42\n');
  });

  it('rejects creating a file whose parent directory does not exist', async () => {
    const patch = createPatch('missing_dir/new_file.go', '', 'package missing\n');
    await assert.rejects(
      () => applyPatch.execute!({ path: 'missing_dir/new_file.go', patch }, contextFor(fixture.root)),
      /parent directory does not exist/,
    );
  });
});

describe('applyPatch: stale/mismatched patches are rejected without touching the file', () => {
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await createFixtureRepo();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('rejects a patch whose context does not match the current file, leaving it unchanged', async () => {
    const staleOriginal = README_CONTENT.replace('Fixture repository', 'STALE CONTENT NOT ACTUALLY IN THE FILE');
    const updated = `${staleOriginal}\nshould never be applied\n`;
    const patch = createPatch('README.md', staleOriginal, updated);

    await assert.rejects(
      () => applyPatch.execute!({ path: 'README.md', patch }, contextFor(fixture.root)),
      /expected context was not found/,
    );

    const onDisk = await callTool(readFile.execute!({ path: 'README.md' }, contextFor(fixture.root)));
    assert.equal(onDisk.content, README_CONTENT);
  });

  it('rejects a patch against a file that does not exist and is not being created from empty content', async () => {
    const patch = createPatch('internal/missing.go', 'package internal\n\nold content\n', 'package internal\n\nnew content\n');
    await assert.rejects(
      () => applyPatch.execute!({ path: 'internal/missing.go', patch }, contextFor(fixture.root)),
      /expected context was not found/,
    );
  });

  it('rejects a patch targeting a directory', async () => {
    const patch = createPatch('internal', 'a\n', 'b\n');
    await assert.rejects(
      () => applyPatch.execute!({ path: 'internal', patch }, contextFor(fixture.root)),
      /is a directory/,
    );
  });
});

describe('applyPatch: path security', () => {
  let fixture: FixtureRepo;
  let outsideDir: string;

  before(async () => {
    fixture = await createFixtureRepo();
    outsideDir = await mkdtemp(join(tmpdir(), 'repo-tools-write-outside-'));
    await writeFile(join(outsideDir, 'secret.txt'), 'OUTSIDE_ORIGINAL_CONTENT\n');
    await symlink(outsideDir, join(fixture.root, 'link'), 'dir');
    await symlink(
      join(fixture.root, 'internal', 'service.go'),
      join(fixture.root, 'internal-alias.go'),
      'file',
    );
  });

  after(async () => {
    await fixture.cleanup();
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('rejects a single parent traversal', async () => {
    const patch = createPatch('../outside.txt', '', 'malicious\n');
    await assert.rejects(
      () => applyPatch.execute!({ path: '../outside.txt', patch }, contextFor(fixture.root)),
      /outside the repository root/,
    );
  });

  it('rejects a deep parent traversal', async () => {
    const patch = createPatch('../../outside.txt', '', 'malicious\n');
    await assert.rejects(
      () => applyPatch.execute!({ path: '../../outside.txt', patch }, contextFor(fixture.root)),
      /outside the repository root/,
    );
  });

  it('rejects an absolute path outside the repository', async () => {
    const patch = createPatch('/etc/hosts', '', 'malicious\n');
    await assert.rejects(
      () => applyPatch.execute!({ path: '/etc/hosts', patch }, contextFor(fixture.root)),
      /outside the repository root/,
    );
  });

  it('rejects a write through a symlink resolving outside the repository, and leaves the outside file untouched', async () => {
    const patch = createPatch('link/secret.txt', 'OUTSIDE_ORIGINAL_CONTENT\n', 'OUTSIDE_MODIFIED_CONTENT\n');

    await assert.rejects(
      () => applyPatch.execute!({ path: 'link/secret.txt', patch }, contextFor(fixture.root)),
      /outside the repository root/,
    );

    const outsideContent = await readRaw(join(outsideDir, 'secret.txt'), 'utf8');
    assert.equal(outsideContent, 'OUTSIDE_ORIGINAL_CONTENT\n');
  });

  it('rejects a write through a symlink even when its real target is inside the repository', async () => {
    // Design decision (documented): unlike reads, writes reject ANY
    // symlink-mediated path, even one whose real target resolves inside
    // the repository. This removes the check-then-write TOCTOU window
    // entirely for the one operation where it's destructive, at the cost
    // of not supporting writes through legitimate internal symlinks.
    const original = await callTool(
      readFile.execute!({ path: 'internal/service.go' }, contextFor(fixture.root)),
    );
    const patch = createPatch('internal-alias.go', original.content, `${original.content}\n// appended\n`);

    await assert.rejects(
      () => applyPatch.execute!({ path: 'internal-alias.go', patch }, contextFor(fixture.root)),
      /reached through a symlink/,
    );

    // The real file behind the symlink must be untouched too.
    const stillOriginal = await callTool(
      readFile.execute!({ path: 'internal/service.go' }, contextFor(fixture.root)),
    );
    assert.equal(stillOriginal.content, original.content);
  });
});

describe('applyPatch: size limits', () => {
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await createFixtureRepo();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('rejects a patch larger than MAX_PATCH_BYTES', async () => {
    const hugeContent = `${'x'.repeat(MAX_PATCH_BYTES + 5_000)}\n`;
    const patch = createPatch('internal/huge.go', '', hugeContent);
    assert.ok(Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES);

    await assert.rejects(
      () => applyPatch.execute!({ path: 'internal/huge.go', patch }, contextFor(fixture.root)),
      /exceeds the .*byte limit/,
    );

    await assert.rejects(() => stat(join(fixture.root, 'internal', 'huge.go')));
  });

  it('rejects a patch that changes more lines than MAX_CHANGED_LINES', async () => {
    const manyLines = Array.from({ length: MAX_CHANGED_LINES + 50 }, (_, i) => `line ${i}`).join('\n');
    const content = `${manyLines}\n`;
    const patch = createPatch('internal/many-lines.go', '', content);
    assert.ok(Buffer.byteLength(patch, 'utf8') < MAX_PATCH_BYTES, 'test patch should stay under the byte limit so this isolates the line-count check');

    await assert.rejects(
      () => applyPatch.execute!({ path: 'internal/many-lines.go', patch }, contextFor(fixture.root)),
      /exceeds the .*line limit/,
    );

    await assert.rejects(() => stat(join(fixture.root, 'internal', 'many-lines.go')));
  });
});

describe('applyPatch: rejects multi-file patches', () => {
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await createFixtureRepo();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('rejects a unified diff that touches more than one file', async () => {
    const patchA = createPatch('internal/a.go', '', 'package internal\n');
    const patchB = createPatch('internal/b.go', '', 'package internal\n');
    const combined = `${patchA}\n${patchB}`;

    await assert.rejects(
      () => applyPatch.execute!({ path: 'internal/a.go', patch: combined }, contextFor(fixture.root)),
      /exactly one file per call/,
    );
  });
});

describe('applyPatch: does not accidentally introduce global state', () => {
  it('two concurrent applyPatch calls against different repositories only affect their own repository', async () => {
    const repoA = await createFixtureRepo('RepoAMarker', { dirName: 'repo-a' });
    const repoB = await createFixtureRepo('RepoBMarker', { parent: repoA.parent, dirName: 'repo-b' });

    try {
      const [resultA, resultB] = await Promise.all([
        callTool(
          applyPatch.execute!(
            { path: 'README.md', patch: createPatch('README.md', README_CONTENT, `${README_CONTENT}\nA\n`) },
            contextFor(repoA.root),
          ),
        ),
        callTool(
          applyPatch.execute!(
            { path: 'README.md', patch: createPatch('README.md', README_CONTENT, `${README_CONTENT}\nB\n`) },
            contextFor(repoB.root),
          ),
        ),
      ]);

      assert.equal(resultA.success, true);
      assert.equal(resultB.success, true);

      const readA = await callTool(readFile.execute!({ path: 'README.md' }, contextFor(repoA.root)));
      const readB = await callTool(readFile.execute!({ path: 'README.md' }, contextFor(repoB.root)));
      assert.match(readA.content, /\nA\n$/);
      assert.match(readB.content, /\nB\n$/);
    } finally {
      await repoA.cleanup();
    }
  });
});

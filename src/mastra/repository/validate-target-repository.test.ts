import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validateTargetRepository } from './validate-target-repository.ts';
import { createFixtureRepo, type FixtureRepo } from '../tools/__testing__/fixture-repo.ts';

const execFileAsync = promisify(execFile);

async function initGitRepo(root: string): Promise<void> {
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: root });
}

describe('validateTargetRepository', () => {
  it('is invalid when the path is unset', async () => {
    const result = await validateTargetRepository(undefined);
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /not set/);
  });

  it('is invalid when the path is empty/whitespace', async () => {
    const result = await validateTargetRepository('   ');
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /not set/);
  });

  it('is invalid when the path does not exist', async () => {
    const result = await validateTargetRepository('/tmp/target-repository-does-not-exist-xyz');
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /does not exist/);
  });

  describe('against a real git repository', () => {
    let fixture: FixtureRepo;

    before(async () => {
      fixture = await createFixtureRepo();
      await initGitRepo(fixture.root);
    });

    after(async () => {
      await fixture.cleanup();
    });

    it('is invalid when the path is a file, not a directory', async () => {
      const filePath = join(fixture.root, 'README.md');
      const result = await validateTargetRepository(filePath);
      assert.equal(result.valid, false);
      assert.match(result.errors[0], /not a directory/);
    });

    it('is valid for a clean real git repository and reports its git status', async () => {
      const result = await validateTargetRepository(fixture.root);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
      assert.equal(result.resolvedPath, fixture.root);
      assert.equal(result.gitStatus?.trim(), '');
    });

    it('stays valid and surfaces git status output when the tree is dirty', async () => {
      await writeFile(join(fixture.root, 'untracked.txt'), 'new\n');
      try {
        const result = await validateTargetRepository(fixture.root);
        assert.equal(result.valid, true);
        assert.match(result.gitStatus ?? '', /untracked\.txt/);
      } finally {
        await execFileAsync('rm', [join(fixture.root, 'untracked.txt')]).catch(() => {});
      }
    });
  });

  it('is invalid when the directory exists but is not a git repository', async () => {
    const fixture = await createFixtureRepo('NoGitMarker', { dirName: 'no-git-repo' });
    try {
      const result = await validateTargetRepository(fixture.root);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => /does not look like a git repository/.test(e)));
    } finally {
      await fixture.cleanup();
    }
  });
});

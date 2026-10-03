import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile as readRaw, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitDiff, gitStatus } from './execution-tools.ts';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';
import { callTool } from './__testing__/call-tool.ts';
import { contextFor } from './__testing__/context-for.ts';

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root });
  return stdout;
}

async function initGitRepo(root: string): Promise<void> {
  await git(root, ['init', '--quiet']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '--quiet', '-m', 'initial']);
}

describe('gitStatus / gitDiff', () => {
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await createFixtureRepo();
    await initGitRepo(fixture.root);
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('gitStatus reports a clean tree right after commit', async () => {
    const result = await callTool(gitStatus.execute!({}, contextFor(fixture.root)));
    assert.equal(result.success, true);
    assert.equal(result.stdout.trim(), '');
  });

  it('gitStatus reports a modified tracked file and a new untracked file', async () => {
    await writeFile(join(fixture.root, 'README.md'), '# changed\n');
    await writeFile(join(fixture.root, 'untracked.txt'), 'new\n');
    try {
      const result = await callTool(gitStatus.execute!({}, contextFor(fixture.root)));
      assert.equal(result.success, true);
      assert.match(result.stdout, /README\.md/);
      assert.match(result.stdout, /untracked\.txt/);
    } finally {
      await git(fixture.root, ['checkout', '--', 'README.md']).catch(() => {});
      await rm(join(fixture.root, 'untracked.txt'), { force: true });
    }
  });

  it('gitDiff shows the content of an uncommitted change to a tracked file', async () => {
    const original = await readRaw(join(fixture.root, 'internal', 'service.go'), 'utf8');
    await writeFile(join(fixture.root, 'internal', 'service.go'), `${original}\n// a local edit\n`);
    try {
      const result = await callTool(gitDiff.execute!({}, contextFor(fixture.root)));
      assert.equal(result.success, true);
      assert.match(result.stdout, /a local edit/);
    } finally {
      await writeFile(join(fixture.root, 'internal', 'service.go'), original);
    }
  });

  it('gitDiff can be scoped to a single path', async () => {
    const original = await readRaw(join(fixture.root, 'README.md'), 'utf8');
    await writeFile(join(fixture.root, 'README.md'), `${original}\nscoped change\n`);
    try {
      const result = await callTool(gitDiff.execute!({ path: 'README.md' }, contextFor(fixture.root)));
      assert.match(result.stdout, /scoped change/);
    } finally {
      await writeFile(join(fixture.root, 'README.md'), original);
    }
  });

  it('rejects a path outside the repository for both tools', async () => {
    await assert.rejects(
      () => gitStatus.execute!({ path: '../outside' }, contextFor(fixture.root)),
      /outside the repository root/,
    );
    await assert.rejects(
      () => gitDiff.execute!({ path: '../outside' }, contextFor(fixture.root)),
      /outside the repository root/,
    );
  });

  it('reports a controlled failure, not a crash, when the repository has no .git directory', async () => {
    const noGitFixture = await createFixtureRepo('NoGitMarker', { dirName: 'no-git-repo' });
    try {
      const result = await callTool(gitStatus.execute!({}, contextFor(noGitFixture.root)));
      assert.equal(result.success, false);
      assert.match(result.stderr, /not a git repository/i);
    } finally {
      await noGitFixture.cleanup();
    }
  });

  it('never mutates the repository: HEAD and the index are unchanged after status/diff calls', async () => {
    const headBefore = await git(fixture.root, ['rev-parse', 'HEAD']);
    const statusBefore = await git(fixture.root, ['status', '--porcelain']);

    await callTool(gitStatus.execute!({}, contextFor(fixture.root)));
    await callTool(gitDiff.execute!({}, contextFor(fixture.root)));
    await callTool(gitStatus.execute!({ path: 'internal' }, contextFor(fixture.root)));

    const headAfter = await git(fixture.root, ['rev-parse', 'HEAD']);
    const statusAfter = await git(fixture.root, ['status', '--porcelain']);
    assert.equal(headAfter, headBefore);
    assert.equal(statusAfter, statusBefore);
  });
});

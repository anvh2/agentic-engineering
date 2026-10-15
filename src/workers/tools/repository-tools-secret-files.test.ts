import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, symlink, writeFile as writeFileOnDisk } from 'node:fs/promises';
import { join } from 'node:path';
import { isSecretPath, readFile, searchFiles, listFiles } from './repository-tools.ts';
import { gitDiff, gitStatus } from './execution-tools.ts';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';
import { contextFor } from './__testing__/context-for.ts';

/**
 * Audit F-13: agent read tools must never surface credentials. A specialist rooted at a project directory could otherwise
 * `readFile .env` or find a token with `searchFiles`, and the value would land in model context, traces and reports.
 */

const SECRET = 'sk_live_ABCDEFGHIJKLMNOP1234';

describe('read tools refuse credential files', () => {
  let fixture: FixtureRepo;
  before(async () => {
    fixture = await createFixtureRepo();
    await writeFileOnDisk(join(fixture.root, '.env'), `API_KEY=${SECRET}\n`);
    await writeFileOnDisk(join(fixture.root, '.env.local'), `TOKEN=${SECRET}\n`);
    await writeFileOnDisk(join(fixture.root, '.env.example'), 'API_KEY=changeme\n');
    await writeFileOnDisk(join(fixture.root, 'server.pem'), `-----BEGIN PRIVATE KEY-----\n${SECRET}\n`);
    await writeFileOnDisk(join(fixture.root, 'plain.txt'), `harmless ${'needle'}\n`);
    await mkdir(join(fixture.root, 'config', '.ssh'), { recursive: true });
    await writeFileOnDisk(join(fixture.root, 'config', '.ssh', 'id_ed25519'), SECRET);
    await symlink(join(fixture.root, '.env'), join(fixture.root, 'notes.txt'));
  });
  after(() => fixture.cleanup());

  const ctx = () => contextFor(fixture.root);

  for (const path of ['.env', '.env.local', 'server.pem', 'config/.ssh/id_ed25519', '.ENV', 'config/../.env']) {
    it(`readFile refuses ${path}`, async () => {
      await assert.rejects(readFile.execute!({ path }, ctx()), /holds credentials/);
    });
  }

  it('readFile refuses a symlink that points at a credential file, reported without echoing the target', async () => {
    await assert.rejects(readFile.execute!({ path: 'notes.txt' }, ctx()), (e: Error) => /holds credentials/.test(e.message) && !e.message.includes(SECRET));
  });

  it('template files and ordinary files stay readable', async () => {
    const example = (await readFile.execute!({ path: '.env.example' }, ctx())) as { content: string };
    assert.match(example.content, /changeme/);
    const plain = (await readFile.execute!({ path: 'plain.txt' }, ctx())) as { content: string };
    assert.match(plain.content, /needle/);
  });

  it('searchFiles never scans or echoes credential files, even when the query matches them', async () => {
    const result = (await searchFiles.execute!({ query: 'sk_live|API_KEY|PRIVATE KEY|TOKEN' }, ctx())) as { matches: { path: string; text: string }[] };
    assert.ok(result.matches.every((m) => !m.text.includes(SECRET)), JSON.stringify(result.matches));
    assert.ok(result.matches.every((m) => !['.env', '.env.local', 'server.pem'].includes(m.path) && !m.path.includes('.ssh')));
    const direct = searchFiles.execute!({ query: 'API_KEY', path: '.env' }, ctx());
    await assert.rejects(direct, /holds credentials/);
    const found = (await searchFiles.execute!({ query: 'needle' }, ctx())) as { matches: { path: string }[] };
    assert.ok(found.matches.some((m) => m.path === 'plain.txt'), 'ordinary files are still searched');
  });

  it('listFiles still lists names (existence is not the secret), so tools stay usable for navigation', async () => {
    const listing = (await listFiles.execute!({ path: '.' }, ctx())) as { entries: { name: string }[] };
    assert.ok(listing.entries.some((e) => e.name === 'plain.txt'));
  });

  it('isSecretPath classification', () => {
    for (const p of ['.env', 'a/.env.production', '.npmrc', 'x/id_rsa', 'a/b.PEM', 'k.key', 'home/.aws/credentials', 'creds/.ssh/config', 'secrets.json',
      '.git/config', '.GIT/config', '.envrc', '.pgpass', '.docker/config.json', 'infra/terraform.tfstate', 'prod.env', '.workdir/scheduler/scheduler.db', 'x/terraform.tfvars']) assert.equal(isSecretPath(p), true, p);
    for (const p of ['.env.example', '.env.sample', 'envfile.go', 'src/keyboard.go', 'docs/pem-format.md', 'id_rsa.pub.md', 'monkey.ts', '.github/workflows/ci.yml', '.gitignore', 'src/credentials/login.go', 'environment.ts']) assert.equal(isSecretPath(p), false, p);
  });

  it('git internals and runtime state are unreadable, so a credentialed remote URL or a database cannot reach model context', async () => {
    await mkdir(join(fixture.root, '.git'), { recursive: true });
    await writeFileOnDisk(join(fixture.root, '.git', 'config'), '[remote "origin"]\n\turl = https://user:tok3n@example.com/r.git\n');
    await mkdir(join(fixture.root, '.workdir'), { recursive: true });
    await writeFileOnDisk(join(fixture.root, '.workdir', 'state.json'), '{"secret":"x"}');
    for (const path of ['.git/config', '.workdir/state.json', 'prod.env', '.envrc']) {
      await assert.rejects(readFile.execute!({ path }, ctx()), /holds credentials/, path);
    }
  });

  it('a source directory that merely has a credential-like NAME is still searched, and withheld files are reported, never silent', async () => {
    await mkdir(join(fixture.root, 'src', 'credentials'), { recursive: true });
    await writeFileOnDisk(join(fixture.root, 'src', 'credentials', 'login.go'), 'package credentials\n\nfunc LoginNeedle() {}\n');
    const found = (await searchFiles.execute!({ query: 'LoginNeedle' }, ctx())) as { matches: { path: string }[]; notice?: string };
    assert.ok(found.matches.some((m) => m.path === join('src', 'credentials', 'login.go')), 'ordinary code under credentials/ is searched');
    assert.match(found.notice ?? '', /credential-like path\(s\) were withheld and not searched/, 'the caller is told that something was skipped');
  });
});

describe('gitDiff never prints credential files', () => {
  let fixture: FixtureRepo;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: fixture.root, encoding: 'utf8' });
  before(async () => {
    fixture = await createFixtureRepo();
    await writeFileOnDisk(join(fixture.root, '.env'), 'API_KEY=original\n');
    await writeFileOnDisk(join(fixture.root, 'creds.pem'), 'old\n');
    git('init', '-q'); git('add', '-A', '-f'); git('commit', '-q', '-m', 'init');
    await writeFileOnDisk(join(fixture.root, '.env'), `API_KEY=${SECRET}\n`);
    await writeFileOnDisk(join(fixture.root, 'creds.pem'), `${SECRET}\n`);
    await writeFileOnDisk(join(fixture.root, 'internal', 'service.go'), 'package internal\n\n// changed\n');
  });
  after(() => fixture.cleanup());
  const ctx = () => contextFor(fixture.root);

  it('omits the lines of modified credential files, keeps ordinary changes, and says what was withheld', async () => {
    const r = (await gitDiff.execute!({}, ctx())) as { success: boolean; stdout: string };
    assert.equal(r.success, true);
    assert.doesNotMatch(r.stdout, new RegExp(SECRET));
    assert.match(r.stdout, /\+\/\/ changed/);
    assert.match(r.stdout, /2 credential-like file\(s\) withheld/);
  });

  it('refuses to diff a credential path directly and scoping to a safe directory still works', async () => {
    await assert.rejects(gitDiff.execute!({ path: '.env' }, ctx()), /holds credentials/);
    const scoped = (await gitDiff.execute!({ path: 'internal' }, ctx())) as { stdout: string };
    assert.match(scoped.stdout, /changed/);
    assert.doesNotMatch(scoped.stdout, /withheld/);
  });

  it('a diff consisting only of credential changes returns just the notice', async () => {
    git('add', 'internal/service.go'); git('commit', '-q', '-m', 'service');
    const r = (await gitDiff.execute!({}, ctx())) as { stdout: string };
    assert.equal(r.stdout.trim(), '[diff of 2 credential-like file(s) withheld]');
  });

  it('gitStatus lists names only, so existence is visible but contents never are', async () => {
    const r = (await gitStatus.execute!({}, ctx())) as { stdout: string };
    assert.doesNotMatch(r.stdout, new RegExp(SECRET));
  });
});

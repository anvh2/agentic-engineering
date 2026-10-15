import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile as writeFileOnDisk } from 'node:fs/promises';
import { join } from 'node:path';
import { isSecretPath, readFile, searchFiles, listFiles } from './repository-tools.ts';
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
    for (const p of ['.env', 'a/.env.production', '.npmrc', 'x/id_rsa', 'a/b.PEM', 'k.key', 'home/.aws/credentials', 'creds/.ssh/config', 'secrets.json']) assert.equal(isSecretPath(p), true, p);
    for (const p of ['.env.example', '.env.sample', 'envfile.go', 'src/keyboard.go', 'docs/pem-format.md', 'id_rsa.pub.md', 'monkey.ts']) assert.equal(isSecretPath(p), false, p);
  });
});

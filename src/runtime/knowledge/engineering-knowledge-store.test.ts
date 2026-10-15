import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { DurableEngineeringKnowledge, keyringPromotionAuthority } from './engineering-knowledge-store.ts';
import { entryDigest } from './engineering-knowledge.ts';
import { normalizeSessionObservation, recordSessionObservation } from './engineering-continuity.ts';
import { keyringOf, testIdentity } from './__testing__/keys.ts';
import { grantFor, inactive } from './__testing__/promotion.ts';

const run = promisify(execFile);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const promoter = testIdentity('k-promoter', 'lead-promoter', ['promoter']);
const verifier = testIdentity('k-verifier', 'rev-verifier', ['verifier']);
const authority = keyringPromotionAuthority(keyringOf(promoter, verifier));
const rule = (id: string, extra = {}) => inactive({ id, revision: 'v1', kind: 'rule', language: 'go', body: `Rule ${id}: follow strict gofmt and test boundaries.`, source: 'curated', ...extra });
const open = () => new DurableEngineeringKnowledge(new DatabaseSync(':memory:'));

test('promotion needs a promoter-signed grant bound to the exact entry digest', () => {
  const store = open();
  const r = rule('go-reviewed');
  assert.throws(() => store.promote(r, undefined, authority), /not authorized/);
  assert.throws(() => store.promote(r, grantFor(verifier, 'promote', r), authority), /not authorized/, 'a verifier key is not a promoter');
  assert.throws(() => store.promote(r, grantFor(promoter, 'promote', rule('other-rule')), authority), /not authorized/, 'grant for another entry');
  assert.throws(() => store.promote({ ...r, body: 'tampered after signing' }, grantFor(promoter, 'promote', r), authority), /not authorized/, 'content changed after signing');
  assert.throws(() => store.promote({ ...r, approved: true }, grantFor(promoter, 'promote', r), authority), /start inactive/, 'caller-asserted approved flag');
  assert.equal(store.activeCatalog().list().length, 0);
  store.promote(r, grantFor(promoter, 'promote', r), authority);
  assert.match(store.activeCatalog().resolve({ language: 'go', ids: ['go-reviewed'] }).text, /gofmt/);
});

test('a grant is single-use: replay of a promotion or revocation is refused', () => {
  const store = open();
  const a = rule('rule-a'), b = rule('rule-b');
  const g = grantFor(promoter, 'promote', a);
  store.promote(a, g, authority);
  assert.throws(() => store.promote(a, g, authority), /already active|already used/);
  store.revoke('rule-a', grantFor(promoter, 'revoke', a), authority);
  // Replaying the OLD promotion grant after revocation must not resurrect the rule.
  assert.throws(() => store.promote(a, g, authority), /already used|already exists/);
  assert.equal(store.activeCatalog().list().length, 0);
  // A grant minted for A cannot promote B even with a valid nonce.
  assert.throws(() => store.promote(b, grantFor(promoter, 'promote', a), authority), /not authorized/);
});

test('expired grants and revoked or not-yet-valid keys do not authorize', () => {
  const r = rule('rule-exp');
  const store = open();
  assert.throws(() => store.promote(r, grantFor(promoter, 'promote', r, { expiresAt: Date.now() - 1 }), authority), /not authorized/);
  const late = testIdentity('k-late', 'late-promoter', ['promoter'], { notBefore: Date.now() + 60_000 });
  assert.throws(() => store.promote(r, grantFor(late, 'promote', r), keyringPromotionAuthority(keyringOf(late))), /not authorized/);
  const revokedKey = testIdentity('k-gone', 'gone-promoter', ['promoter'], { revokedAt: Date.now() - 10 });
  assert.throws(() => store.promote(r, grantFor(revokedKey, 'promote', r), keyringPromotionAuthority(keyringOf(revokedKey))), /not authorized/);
});

test('F-02 revocation is one-way at the database level and audit rows cannot be rewritten', () => {
  const db = new DatabaseSync(':memory:');
  const store = new DurableEngineeringKnowledge(db);
  const r = rule('rule-r');
  store.promote(r, grantFor(promoter, 'promote', r), authority);
  store.revoke('rule-r', grantFor(promoter, 'revoke', r), authority);
  assert.throws(() => db.exec("UPDATE engineering_knowledge SET revoked_at=NULL WHERE id='rule-r'"), /immutable/);
  assert.throws(() => db.exec("UPDATE engineering_knowledge SET manifest_json='{}' WHERE id='rule-r'"), /immutable/);
  assert.throws(() => db.exec("DELETE FROM engineering_knowledge"), /never deleted/);
  assert.throws(() => db.exec("UPDATE engineering_knowledge_events SET actor='x'"), /append only/);
  assert.throws(() => db.exec("DELETE FROM engineering_knowledge_events"), /append only/);
  assert.throws(() => db.exec("DELETE FROM engineering_knowledge_authorizations"), /append only/);
  assert.throws(() => store.activeCatalog().resolve({ language: 'go', ids: ['rule-r'] }), /unknown entry/);
  assert.throws(() => store.revoke('rule-r', grantFor(promoter, 'revoke', r), authority), /no active entry/);
  assert.deepEqual(store.history('rule-r').map((e) => [e.action, e.actor, e.keyId]), [['promoted', 'lead-promoter', 'k-promoter'], ['revoked', 'lead-promoter', 'k-promoter']]);
});

test('F-02 a silent edit of a stored manifest is detected on read (fail closed)', () => {
  const db = new DatabaseSync(':memory:');
  const store = new DurableEngineeringKnowledge(db);
  const r = rule('rule-t');
  store.promote(r, grantFor(promoter, 'promote', r), authority);
  db.exec('DROP TRIGGER engineering_knowledge_one_way_revoke');           // an attacker with raw DB access removes the trigger...
  db.exec(`UPDATE engineering_knowledge SET manifest_json=replace(manifest_json,'gofmt','rm -rf')`); // ...and edits the rule
  assert.throws(() => store.activeCatalog(), /corrupt stored manifest/);
});

test('F-03 project lessons are invisible to other projects and to global catalogs', () => {
  const store = open();
  const lesson = inactive({ id: 'lesson-alpha', revision: 'v1', kind: 'lesson', language: 'common', body: 'Alpha-only lesson.', source: 'project:alpha', projectId: 'proj-alpha' });
  const global = rule('global-rule');
  store.promote(lesson, grantFor(promoter, 'promote', lesson), authority);
  store.promote(global, grantFor(promoter, 'promote', global), authority);
  assert.equal(store.activeCatalog({ projectId: 'proj-alpha' }).resolve({ language: 'go', ids: ['lesson-alpha', 'global-rule'] }).entries.length, 2);
  assert.throws(() => store.activeCatalog({ projectId: 'proj-beta' }).resolve({ language: 'go', ids: ['lesson-alpha'] }), /unknown entry/);
  assert.throws(() => store.activeCatalog().resolve({ language: 'go', ids: ['lesson-alpha'] }), /unknown entry/);
});

test('F-06 promoting or revoking an unrelated entry does not change a pinned selection digest', () => {
  const store = open();
  const a = rule('rule-a'), b = rule('rule-b');
  store.promote(a, grantFor(promoter, 'promote', a), authority);
  const pinned = store.activeCatalog().resolve({ language: 'go', ids: ['rule-a'] }).digest;
  store.promote(b, grantFor(promoter, 'promote', b), authority);
  assert.equal(store.activeCatalog().resolve({ language: 'go', ids: ['rule-a'] }).digest, pinned);
  store.revoke('rule-b', grantFor(promoter, 'revoke', b), authority);
  assert.equal(store.activeCatalog().resolve({ language: 'go', ids: ['rule-a'] }).digest, pinned);
  // ...but a revoked SELECTED entry can no longer be resolved for a new snapshot.
  store.revoke('rule-a', grantFor(promoter, 'revoke', a), authority);
  assert.throws(() => store.activeCatalog().resolve({ language: 'go', ids: ['rule-a'] }), /unknown entry/);
});

test('versioning: supersede swaps the active revision atomically; rollback is a new revision, never an un-revoke', () => {
  const store = open();
  const v1 = rule('rule-v');
  const v2 = { ...v1, revision: 'v2', body: 'Rule rule-v: v2 text, stricter.' };
  store.promote(v1, grantFor(promoter, 'promote', v1), authority);
  assert.throws(() => store.promote(v2, grantFor(promoter, 'promote', v2), authority), /already active/);
  store.supersede(v2, 'v1', grantFor(promoter, 'supersede', v2, { replacesRevision: 'v1' }), authority);
  assert.match(store.activeCatalog().resolve({ language: 'go', ids: ['rule-v'] }).text, /v2 text/);
  // grant must name the revision it replaces
  assert.throws(() => store.supersede({ ...v1, revision: 'v3' }, 'v1', grantFor(promoter, 'supersede', { ...v1, revision: 'v3' }, { replacesRevision: 'v2' }), authority), /not authorized/);
  const rolledBack = { ...v1, revision: 'v3' };
  store.supersede(rolledBack, 'v2', grantFor(promoter, 'supersede', rolledBack, { replacesRevision: 'v2' }), authority);
  assert.match(store.activeCatalog().resolve({ language: 'go', ids: ['rule-v'] }).text, /follow strict gofmt/);
  assert.deepEqual(store.history('rule-v').map((e) => `${e.action}:${e.revision}`), ['promoted:v1', 'superseded:v1', 'promoted:v2', 'superseded:v2', 'promoted:v3']);
});

test('a failed promotion leaves no partial state (atomic): nonce is not burned by a rejected insert', () => {
  const store = open();
  const r = rule('rule-atomic');
  const g1 = grantFor(promoter, 'promote', r);
  store.promote(r, g1, authority);
  const twin = { ...r, revision: 'v1' };
  const g2 = grantFor(promoter, 'promote', twin);
  assert.throws(() => store.promote(twin, g2, authority), /already active/);
  store.revoke('rule-atomic', grantFor(promoter, 'revoke', r), authority);
  // g2 must still be usable because its transaction rolled back (the nonce insert was undone), but the revision exists, so the
  // honest failure is "revision already exists", not "authorization already used".
  assert.throws(() => store.promote(twin, g2, authority), /revision already exists/);
});

test('session observations are durable, repeatable, append-only and reject conflicting sequence', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new DurableEngineeringKnowledge(db);
  const obs = { sessionId: 'session-1', taskId: 'task-1', seq: 1, event: 'checkpoint' as const, stateRef: 'task-state-1', stateDigest: sha('one') };
  assert.equal(await recordSessionObservation(store, obs), 'written');
  assert.equal(await recordSessionObservation(store, obs), 'exists');
  await assert.rejects(() => recordSessionObservation(store, { ...obs, stateDigest: sha('two') }), /conflict/);
  await assert.rejects(() => store.recordOnce({ ...normalizeSessionObservation(obs), fingerprint: sha('fake') }), /mismatched/);
  assert.throws(() => db.exec("UPDATE engineering_session_events SET fingerprint='x'"), /append only/);
  assert.deepEqual(store.sessionEvents('session-1'), [obs]);
});

test('concurrent processes racing to promote the same entry: exactly one wins, the database stays consistent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-race-'));
  try {
    const file = join(dir, 'k.db');
    new DurableEngineeringKnowledge(new DatabaseSync(file)); // create schema once
    const r = rule('rule-race');
    // N distinct, individually valid grants: the race is on the entry, not on a shared nonce.
    const grants = Array.from({ length: 6 }, () => grantFor(promoter, 'promote', r));
    const script = join(dir, 'racer.ts');
    writeFileSync(script, `
      import { DatabaseSync } from 'node:sqlite';
      import { DurableEngineeringKnowledge, keyringPromotionAuthority } from '${join(process.cwd(), 'src/runtime/knowledge/engineering-knowledge-store.ts')}';
      import { TrustedKeyring } from '${join(process.cwd(), 'src/runtime/knowledge/trust.ts')}';
      const [file, ring, entry, grant] = process.argv.slice(2).map((x, i) => i === 0 ? x : JSON.parse(x));
      const store = new DurableEngineeringKnowledge(new DatabaseSync(file));
      try { store.promote(entry, grant, keyringPromotionAuthority(new TrustedKeyring(ring))); console.log('WON'); }
      catch (e) { console.log('LOST ' + (e as Error).message); }
    `);
    const ring = JSON.stringify([promoter.input]);
    const results = await Promise.all(grants.map((g) => run('node', ['--disable-warning=ExperimentalWarning', script, file, ring, JSON.stringify(r), JSON.stringify(g)])));
    const out = results.map((x) => x.stdout.trim());
    assert.equal(out.filter((x) => x === 'WON').length, 1, out.join('\n'));
    assert.ok(out.filter((x) => x !== 'WON').every((x) => /already active/.test(x)), out.join('\n'));
    const store = new DurableEngineeringKnowledge(new DatabaseSync(file));
    assert.equal(store.history('rule-race').length, 1);
    assert.equal(store.activeCatalog().list().length, 1);
    assert.equal(entryDigest({ ...r, approved: true }), store.history('rule-race')[0]!.digest);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

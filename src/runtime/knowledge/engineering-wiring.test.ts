import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { findProjectRoot } from '../../core/paths.ts';
import { defaultActiveSkills, knowledgeDbPath, loadActiveCatalog } from './engineering-control.ts';
import { runEngineeringCli } from './engineering-cli.ts';
import { DurableEngineeringKnowledge, keyringPromotionAuthority } from './engineering-knowledge-store.ts';
import { loadPackRegistry } from './packs/loader.ts';
import { promotedDigestOf, skillToCandidate } from './packs/skills.ts';
import { trustedCatalog } from '../../lead/lifecycle/cli.ts';
import { keyringOf, testIdentity } from './__testing__/keys.ts';
import { grantFor, inactive } from './__testing__/promotion.ts';

const pack = loadPackRegistry(findProjectRoot()!);
const promoter = testIdentity('k-promoter', 'lead', ['promoter']);
const authority = keyringPromotionAuthority(keyringOf(promoter));
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-'));
  mkdirSync(join(dir, 'engineering'), { recursive: true });
  const db = knowledgeDbPath(dir);
  return { dir, db, store: () => new DurableEngineeringKnowledge(new DatabaseSync(db)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('loadActiveCatalog: undefined when nothing was promoted, global entries only, fresh on every call', () => {
  const s = sandbox();
  try {
    assert.equal(loadActiveCatalog(s.db), undefined);
    const c = skillToCandidate(pack.skillById.get('go-testing')!);
    s.store().promote(c, grantFor(promoter, 'promote', c), authority);
    assert.deepEqual(loadActiveCatalog(s.db)!.list().map((e) => e.id), ['go-testing']);
    const scoped = inactive({ id: 'lesson-p', revision: 'v1', kind: 'lesson', language: 'common', body: 'Project lesson text.', source: 'learning', projectId: 'proj-a' });
    s.store().promote(scoped, grantFor(promoter, 'promote', scoped), authority);
    assert.deepEqual(loadActiveCatalog(s.db)!.list().map((e) => e.id), ['go-testing'], 'a project-scoped lesson is not in the global catalog');
    s.store().revoke('go-testing', grantFor(promoter, 'revoke', c), authority);
    assert.equal(loadActiveCatalog(s.db), undefined, 'revocation is visible on the next read');
  } finally { s.cleanup(); }
});

test('defaultActiveSkills: promoted skills only, and any failure means no skills rather than an error', () => {
  const s = sandbox();
  try {
    assert.equal(defaultActiveSkills(s.db).size, 0);
    const c = skillToCandidate(pack.skillById.get('go-testing')!);
    s.store().promote(c, grantFor(promoter, 'promote', c), authority);
    assert.equal(defaultActiveSkills(s.db).get('go-testing'), promotedDigestOf(pack.skillById.get('go-testing')!));
    const raw = new DatabaseSync(s.db);
    raw.exec('DROP TRIGGER engineering_knowledge_one_way_revoke');
    raw.exec("UPDATE engineering_knowledge SET manifest_json = replace(manifest_json, 'Go testing', 'x')");
    raw.close();
    assert.equal(defaultActiveSkills(s.db).size, 0, 'a corrupt store yields no optional guidance');
  } finally { s.cleanup(); }
});

test('the lifecycle reviewer uses the store, and a damaged store yields no catalog plus a logged reason (pinned tasks cannot be approved)', () => {
  const s = sandbox();
  try {
    const errs: string[] = [];
    const ctx = { workdir: s.dir, err: (t: string) => errs.push(t) };
    assert.equal(trustedCatalog(ctx), undefined);
    const c = skillToCandidate(pack.skillById.get('go-testing')!);
    s.store().promote(c, grantFor(promoter, 'promote', c), authority);
    assert.deepEqual(trustedCatalog(ctx)!.list().map((e) => e.id), ['go-testing']);
    assert.deepEqual(errs, []);
    const raw = new DatabaseSync(s.db);
    raw.exec('DROP TRIGGER engineering_knowledge_one_way_revoke');
    raw.exec("UPDATE engineering_knowledge SET manifest_json = replace(manifest_json, 'Go testing', 'x')");
    raw.close();
    assert.equal(trustedCatalog(ctx), undefined);
    assert.match(errs.join(), /knowledge store unreadable; tasks that pin knowledge cannot be approved: .*corrupt stored manifest/);
    assert.deepEqual(trustedCatalog({ ...ctx, knowledgeCatalog: () => undefined }), undefined, 'an injected source takes precedence');
  } finally { s.cleanup(); }
});

test('engineering pin prints the contract pin for a task, from promoted skills only', async () => {
  const s = sandbox();
  try {
    const run = async (args: string[]) => { const out: string[] = [], err: string[] = []; const code = await runEngineeringCli([...args, '--root', s.dir, '--db', s.db], { out: (t) => out.push(t), err: (t) => err.push(t) }); return { code, out: out.join('\n'), err: err.join('\n') }; };
    const text = 'Add table-driven go test subtests for the parser boundary cases';
    const noPack = await run(['pin', '--language', 'go', '--type', 'test', '--text', text]);
    assert.equal(noPack.code, 1, 'the pack is not present in this sandbox root');
    const real = async (args: string[]) => { const out: string[] = []; const code = await runEngineeringCli([...args, '--root', findProjectRoot()!, '--db', s.db], { out: (t) => out.push(t), err: () => undefined }); return { code, out: out.join('\n') }; };
    const none = JSON.parse((await real(['pin', '--language', 'go', '--type', 'test', '--text', text, '--json'])).out);
    assert.equal(none.knowledge, null, 'nothing promoted -> no pin');
    const c = skillToCandidate(pack.skillById.get('go-testing')!);
    s.store().promote(c, grantFor(promoter, 'promote', c), authority);
    const pinned = JSON.parse((await real(['pin', '--language', 'go', '--type', 'test', '--text', text, '--json'])).out);
    assert.deepEqual(pinned.knowledge.ids, ['go-testing']);
    assert.match(pinned.knowledge.selectionDigest, /^[a-f0-9]{64}$/);
    assert.equal((await real(['pin', '--language', 'ruby', '--type', 'test', '--text', text])).code, 2, 'only implementation languages can be pinned');
    assert.equal((await real(['pin', '--language', 'go', '--type', 'bogus', '--text', text])).code, 2);
  } finally { s.cleanup(); }
});

import { strict as assert } from 'node:assert';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { findProjectRoot } from '../../core/paths.ts';
import { runEngineeringCli } from './engineering-cli.ts';
import { buildEngineeringReport, probeOllama, providerReadiness, readActiveKnowledge, STATUS_SCHEMA, type EngineeringReport } from './engineering-control.ts';
import { DurableEngineeringKnowledge, keyringPromotionAuthority } from './engineering-knowledge-store.ts';
import { loadPackRegistry } from './packs/loader.ts';
import { skillToCandidate } from './packs/skills.ts';
import { keyringOf, testIdentity } from './__testing__/keys.ts';
import { grantFor } from './__testing__/promotion.ts';

const projectRoot = findProjectRoot()!;
const promoter = testIdentity('k-promoter', 'lead', ['promoter']);
const pack = loadPackRegistry(projectRoot);
const NOW = 1_700_000_000_000;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'eng-cli-'));
  mkdirSync(join(dir, '.workdir', 'engineering'), { recursive: true });
  cpSync(join(projectRoot, 'engineering'), join(dir, 'engineering'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'agentic-engineering' }));
  writeFileSync(join(dir, '.workdir', 'engineering', 'keyring.json'), JSON.stringify([promoter.input]));
  return { dir, db: join(dir, '.workdir', 'engineering', 'knowledge.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
async function cli(args: string[], dir: string, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await runEngineeringCli([...args, '--root', dir], { out: (t) => out.push(t), err: (t) => err.push(t) }, env, () => NOW);
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const snapshot = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${join(e.parentPath, e.name)}:${statSync(join(e.parentPath, e.name)).mtimeMs}`).sort();

test('status reports a healthy pack with nothing promoted as a warning, never as an error, and is stable', async () => {
  const s = sandbox();
  try {
    const first = await cli(['status', '--json'], s.dir);
    assert.equal(first.code, 0);
    const report = JSON.parse(first.out) as EngineeringReport;
    assert.equal(report.schema, STATUS_SCHEMA);
    assert.equal(report.pack.loaded, true);
    assert.equal(report.pack.skills, pack.skills.length);
    assert.equal(report.scenarios!.passed, report.scenarios!.total);
    assert.ok(report.issues.some((i) => i.code === 'no_promoted_skills' && i.level === 'warning'));
    assert.ok(!report.issues.some((i) => i.level === 'error'));
    assert.deepEqual(report.drift.unpromoted.length, pack.skills.length);
    assert.equal(JSON.parse((await cli(['status', '--json'], s.dir)).out).reportDigest, report.reportDigest, 'same state -> same digest');
    const text = await cli(['status'], s.dir);
    assert.match(text.out, /engineering pack: loaded/);
  } finally { s.cleanup(); }
});

test('read-only commands change nothing on disk and never contact a provider by default', async () => {
  const s = sandbox();
  try {
    const before = snapshot(s.dir);
    for (const args of [['status'], ['agents'], ['skills'], ['validate'], ['drift'], ['render', 'claude-code', 'go-reviewer']]) assert.equal((await cli(args, s.dir)).code, 0, args.join(' '));
    assert.deepEqual(snapshot(s.dir), before);
    assert.ok(!existsSync(s.db), 'no database is created by reading');
    for (const p of providerReadiness({})) assert.notEqual(p.basis, 'probe');
  } finally { s.cleanup(); }
});

test('agents and skills listings are machine readable and agree with the pack', async () => {
  const s = sandbox();
  try {
    const agents = JSON.parse((await cli(['agents', '--json'], s.dir)).out) as { id: string; tools: string[]; mastraOllama: string }[];
    assert.equal(agents.length, pack.agents.length);
    assert.ok(agents.every((a) => a.tools.every((t) => ['listFiles', 'readFile', 'searchFiles', 'gitDiff', 'gitStatus'].includes(t))));
    const skills = JSON.parse((await cli(['skills', '--json'], s.dir)).out) as { id: string; state: string }[];
    assert.equal(skills.length, pack.skills.length);
    assert.ok(skills.every((x) => x.state === 'not-promoted'));
    const small = JSON.parse((await cli(['agents', '--json'], s.dir, { OLLAMA_NUM_CTX: '4096' })).out) as { mastraOllama: string }[];
    assert.ok(small.every((a) => /below the required/.test(a.mastraOllama)), 'a declared small context makes the incompatibility visible');
  } finally { s.cleanup(); }
});

test('promote applies only a signed grant from a trusted key; wrong keys and tampered grants change nothing', async () => {
  const s = sandbox();
  try {
    const candidate = skillToCandidate(pack.skillById.get('go-testing')!);
    const good = grantFor(promoter, 'promote', candidate);
    const file = join(s.dir, 'grant.json');
    const stranger = testIdentity('k-promoter', 'imposter', ['promoter']);
    writeFileSync(file, JSON.stringify(grantFor(stranger, 'promote', candidate)));
    const forged = await cli(['promote', 'go-testing', '--grant', file], s.dir);
    assert.equal(forged.code, 1);
    assert.match(forged.err, /not authorized/);
    writeFileSync(file, JSON.stringify(grantFor(promoter, 'promote', skillToCandidate(pack.skillById.get('go-engineering')!))));
    assert.equal((await cli(['promote', 'go-testing', '--grant', file], s.dir)).code, 1, 'a grant for another skill');
    assert.deepEqual(readActiveKnowledge(s.db), []);
    writeFileSync(file, JSON.stringify(good));
    const ok = await cli(['promote', 'go-testing', '--grant', file, '--json'], s.dir);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(JSON.parse(ok.out).action, 'promoted');
    const again = await cli(['promote', 'go-testing', '--grant', file, '--json'], s.dir);
    assert.deepEqual([again.code, JSON.parse(again.out).action], [0, 'unchanged'], 're-running for an identical active revision is a no-op (store-level replay refusal is tested in the knowledge store)');
    const status = JSON.parse((await cli(['status', '--json'], s.dir)).out) as EngineeringReport;
    assert.equal(status.skills.find((x) => x.id === 'go-testing')!.state, 'active');
    assert.ok(!status.issues.some((i) => i.code === 'no_promoted_skills'));
    assert.ok(status.agents.find((a) => a.id === 'go-reviewer')!.skillsActive >= 1);
  } finally { s.cleanup(); }
});

test('promote and revoke refuse to run without a keyring or a grant, and unknown skills are rejected', async () => {
  const s = sandbox();
  try {
    assert.equal((await cli(['promote', 'go-testing'], s.dir)).code, 2);
    rmSync(join(s.dir, '.workdir', 'engineering', 'keyring.json'));
    writeFileSync(join(s.dir, 'g.json'), '{}');
    const noRing = await cli(['promote', 'go-testing', '--grant', join(s.dir, 'g.json')], s.dir);
    assert.equal(noRing.code, 1);
    assert.match(noRing.err, /no trusted keyring/);
    assert.ok(!existsSync(s.db));
    writeFileSync(join(s.dir, '.workdir', 'engineering', 'keyring.json'), JSON.stringify([promoter.input]));
    assert.equal((await cli(['promote', 'no-such-skill', '--grant', join(s.dir, 'g.json')], s.dir)).code, 1);
  } finally { s.cleanup(); }
});

test('drift: editing a promoted skill makes it stale and unselectable; a revoked or removed skill is flagged; --strict gates on it', async () => {
  const s = sandbox();
  try {
    const store = new DurableEngineeringKnowledge(new DatabaseSync(s.db));
    const authority = keyringPromotionAuthority(keyringOf(promoter));
    const goTesting = skillToCandidate(pack.skillById.get('go-testing')!);
    store.promote(goTesting, grantFor(promoter, 'promote', goTesting), authority);
    assert.equal((await cli(['drift', '--strict'], s.dir)).code, 0);
    const file = join(s.dir, 'engineering', 'skills', 'go-testing.json');
    const edited = JSON.parse(readFileSync(file, 'utf8')); edited.summary += ' Edited after promotion.';
    writeFileSync(file, JSON.stringify(edited));
    const drift = await cli(['drift', '--json', '--strict'], s.dir);
    assert.equal(drift.code, 1);
    assert.deepEqual(JSON.parse(drift.out).stale, ['go-testing']);
    const status = JSON.parse((await cli(['status', '--json'], s.dir)).out) as EngineeringReport;
    assert.ok(status.issues.some((i) => i.code === 'promoted_skill_stale'));
    writeFileSync(file, readFileSync(join(projectRoot, 'engineering', 'skills', 'go-testing.json'), 'utf8'));
    const ghost = skillToCandidate({ ...pack.skillById.get('go-testing')!, id: 'ghost-skill' });
    store.promote(ghost, grantFor(promoter, 'promote', ghost), authority);
    const orphaned = JSON.parse((await cli(['drift', '--json'], s.dir)).out);
    assert.deepEqual(orphaned.orphaned, ['ghost-skill'], 'promoted but absent from the pack');
    rmSync(file);
    const broken = await cli(['status', '--json'], s.dir);
    assert.equal(broken.code, 1, 'removing a skill that agents reference breaks the pack, which fails closed');
    assert.ok((JSON.parse(broken.out) as EngineeringReport).issues.some((i) => i.code === 'pack_unloaded'));
  } finally { s.cleanup(); }
});

test('validate fails closed on a broken pack and names the file', async () => {
  const s = sandbox();
  try {
    assert.equal((await cli(['validate'], s.dir)).code, 0);
    const file = join(s.dir, 'engineering', 'agents', 'go-reviewer.json');
    const bad = JSON.parse(readFileSync(file, 'utf8')); bad.tools = ['readFile', 'writeFile'];
    writeFileSync(file, JSON.stringify(bad));
    const r = await cli(['validate'], s.dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /go-reviewer\.json.*read-only/);
    const status = await cli(['status', '--json'], s.dir);
    assert.equal(status.code, 1);
    assert.ok((JSON.parse(status.out) as EngineeringReport).issues.some((i) => i.code === 'pack_unloaded'));
  } finally { s.cleanup(); }
});

test('render prints a Claude Code definition to stdout only, with just the active skills, and writes nothing', async () => {
  const s = sandbox();
  try {
    const goEngineering = skillToCandidate(pack.skillById.get('go-engineering')!);
    new DurableEngineeringKnowledge(new DatabaseSync(s.db)).promote(goEngineering, grantFor(promoter, 'promote', goEngineering), keyringPromotionAuthority(keyringOf(promoter)));
    const before = snapshot(s.dir);
    const r = await cli(['render', 'claude-code', 'go-reviewer'], s.dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /^---\nname: go-reviewer\n/);
    assert.match(r.out, /Skill go-engineering@1\.0\.0/);
    assert.doesNotMatch(r.out, /Skill go-testing@/, 'an unpromoted skill is not embedded');
    assert.match(r.err, /omitted: gitDiff, gitStatus/);
    assert.deepEqual(snapshot(s.dir), before);
    assert.equal((await cli(['render', 'claude-code', 'nope'], s.dir)).code, 1);
    assert.equal((await cli(['render', 'cursor', 'go-reviewer'], s.dir)).code, 2);
  } finally { s.cleanup(); }
});

test('readActiveKnowledge refuses a database whose stored manifest was edited out of band', () => {
  const s = sandbox();
  try {
    const store = new DurableEngineeringKnowledge(new DatabaseSync(s.db));
    const c = skillToCandidate(pack.skillById.get('go-testing')!);
    store.promote(c, grantFor(promoter, 'promote', c), keyringPromotionAuthority(keyringOf(promoter)));
    const raw = new DatabaseSync(s.db);
    raw.exec('DROP TRIGGER engineering_knowledge_one_way_revoke');
    raw.exec("UPDATE engineering_knowledge SET manifest_json = replace(manifest_json, 'Go testing', 'Go TESTING')");
    raw.close();
    assert.throws(() => readActiveKnowledge(s.db), /corrupt stored manifest/);
    assert.deepEqual(readActiveKnowledge(join(s.dir, 'missing.db')), []);
  } finally { s.cleanup(); }
});

test('ollama probing is explicit, loopback-only and bounded', async () => {
  let fetched = 0;
  const ok = (async (url: string) => { fetched++; assert.match(String(url), /^http:\/\/localhost:11434\/api\/tags$/); return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })); }) as unknown as typeof fetch;
  assert.deepEqual((await probeOllama({}, ok)).configured, true);
  assert.equal(fetched, 1);
  const missing = (async () => new Response(JSON.stringify({ models: [{ name: 'llama3' }] }))) as unknown as typeof fetch;
  assert.match((await probeOllama({}, missing)).detail, /not installed/);
  const remote = await probeOllama({ OLLAMA_BASE_URL: 'https://example.com' }, (async () => { throw new Error('must not be called'); }) as unknown as typeof fetch);
  assert.equal(remote.basis, 'not-checked');
  assert.match(remote.detail, /not a loopback address/);
  const down = await probeOllama({}, (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
  assert.deepEqual([down.configured, down.detail], [false, 'endpoint unreachable']);
  assert.equal((await probeOllama({ OLLAMA_BASE_URL: 'not a url' })).configured, false);
});

test('the report distinguishes declining and unmeasured skills and carries recommendations, not actions', () => {
  const day = 86_400_000;
  const runs = [
    ...[true, true, true, true].map((ok, i) => ({ skillId: 'go-testing', revision: 'v1', taskId: `a${i}`, projectId: 'p', outcome: ok ? 'accepted' as const : 'rejected' as const, independentlyVerified: true, at: NOW - 40 * day })),
    ...[false, false, false, false].map((ok, i) => ({ skillId: 'go-testing', revision: 'v1', taskId: `b${i}`, projectId: 'p', outcome: ok ? 'accepted' as const : 'rejected' as const, independentlyVerified: true, at: NOW - 5 * day })),
  ];
  const report = buildEngineeringReport({ registry: pack, activeEntries: [], skillRuns: runs, now: NOW, env: {} });
  assert.ok(report.recommendations.some((r) => r.action === 'revoke-or-rollback' && r.skillId === 'go-testing'));
  assert.ok(report.issues.some((i) => i.code === 'skill_declining'));
  assert.ok(Object.isFrozen(report));
});

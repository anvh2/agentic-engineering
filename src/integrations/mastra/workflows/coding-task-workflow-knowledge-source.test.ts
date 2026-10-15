import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCodingTaskWorkflow, type CodingTaskWorkflowInput } from './coding-task-workflow.ts';
import { loadPackRegistry } from '../../../runtime/knowledge/packs/loader.ts';
import { pinSkillsForTask, skillToCandidate } from '../../../runtime/knowledge/packs/skills.ts';
import { DurableEngineeringKnowledge, keyringPromotionAuthority } from '../../../runtime/knowledge/engineering-knowledge-store.ts';
import { knowledgeDbPath, loadActiveCatalog } from '../../../runtime/knowledge/engineering-control.ts';
import { keyringOf, testIdentity } from '../../../runtime/knowledge/__testing__/keys.ts';
import { grantFor } from '../../../runtime/knowledge/__testing__/promotion.ts';
import { findProjectRoot } from '../../../core/paths.ts';

const pack = loadPackRegistry(findProjectRoot()!);
const promoter = testIdentity('k-promoter', 'lead', ['promoter']);
const authority = keyringPromotionAuthority(keyringOf(promoter));
const STUB = 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n';
const RIGHT = 'package calc\n\nfunc Double(n int) int {\n\treturn n * 2\n}\n';
const TEST_SRC = 'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif got := Double(3); got != 6 {\n\t\tt.Fatalf("Double(3) = %d, want 6", got)\n\t}\n}\n';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });

describe('the registered coding workflow reads promoted knowledge from the durable store, per run, and only when a task pins any', () => {
  let root: string, artifacts: string, workdir: string;
  const prompts: string[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ctw-ks-repo-'));
    artifacts = await mkdtemp(join(tmpdir(), 'ctw-ks-art-'));
    workdir = await mkdtemp(join(tmpdir(), 'ctw-ks-work-'));
    await mkdir(join(root, 'calc'));
    await writeFile(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    await writeFile(join(root, 'calc', 'calc.go'), STUB);
    await writeFile(join(root, 'calc', 'calc_test.go'), TEST_SRC);
    git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init');
    prompts.length = 0;
  });
  afterEach(async () => { for (const d of [root, artifacts, workdir]) await rm(d, { recursive: true, force: true }); });

  const dbPath = () => knowledgeDbPath(workdir);
  const base = (knowledge?: CodingTaskWorkflowInput['contract']['knowledge']): CodingTaskWorkflowInput => ({
    repository: root,
    contract: { taskId: 'KS-1', objective: 'Implement Double and handle errors with context cancellation in this golang package', allowedFiles: ['calc/calc.go'], contextFiles: ['calc/calc_test.go'],
      acceptanceCriteria: ['TestDouble passes'], verificationCommands: [['go', 'test', '-count=1', './...']], constraints: ['tests are immutable'], ...(knowledge ? { knowledge } : {}) },
    assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one function with an existing test' },
  });
  const workflow = (source: () => ReturnType<typeof loadActiveCatalog>, calls = { n: 0 }) => createCodingTaskWorkflow({
    knowledgeCatalog: () => { calls.n++; return source(); },
    resolveWorker: () => ({ generate: async (p) => { prompts.push(p); await writeFile(join(root, 'calc', 'calc.go'), RIGHT); return { text: 'done', finishReason: 'stop', steps: [{}] }; } }),
    artifactRoot: artifacts, runOptions: { runtimeRetryDelayMs: 0 },
  });
  const start = async (wf: ReturnType<typeof workflow>, data: CodingTaskWorkflowInput) => (await (await wf.createRun()).start({ inputData: data as never })) as { status: string; result?: { status: string; reasons: string[] } };
  const store = () => new DurableEngineeringKnowledge(new DatabaseSync(dbPath()));
  const promote = (id: string) => { mkdirSyncFor(); const c = skillToCandidate(pack.skillById.get(id)!); store().promote(c, grantFor(promoter, 'promote', c), authority); return c; };
  const mkdirSyncFor = () => { execFileSync('mkdir', ['-p', join(workdir, 'engineering')]); };

  it('does not read the store at all for a task that pins nothing, even if the store is broken', async () => {
    const calls = { n: 0 };
    const r = await start(workflow(() => { throw new Error('store is corrupt'); }, calls), base());
    assert.equal(r.status, 'success');
    assert.equal(r.result!.status, 'PASS');
    assert.equal(calls.n, 0);
  });

  it('a pinned task is refused with a reason when nothing is promoted, runs once its skill is promoted, and is refused again after revocation', async () => {
    const wf = workflow(() => loadActiveCatalog(dbPath()));
    const empty = await start(wf, base({ ids: ['go-engineering'], selectionDigest: '0'.repeat(64) }));
    assert.equal(empty.result!.status, 'KEPT_BY_CLAUDE');
    assert.match(empty.result!.reasons.join(), /pinned knowledge rejected: no trusted runtime catalog/);

    const candidate = promote('go-engineering');
    const pin = pinSkillsForTask(pack.skills, loadActiveCatalog(dbPath())!, { language: 'go', taskType: 'implement', text: base().contract.objective });
    assert.deepEqual(pin.knowledge!.ids, ['go-engineering']);
    const ran = await start(wf, base(pin.knowledge));
    assert.equal(ran.result!.status, 'PASS', JSON.stringify(ran.result));
    assert.match(prompts[0]!, /Skill go-engineering@1\.0\.0/, 'the promoted skill reached the real worker prompt');

    await writeFile(join(root, 'calc', 'calc.go'), STUB);
    store().revoke('go-engineering', grantFor(promoter, 'revoke', candidate), authority);
    const after = await start(wf, base(pin.knowledge));
    assert.equal(after.result!.status, 'KEPT_BY_CLAUDE', 'the revocation took effect on the very next run');
    assert.equal(prompts.length, 1, 'the worker was not invoked again');
  });

  it('a damaged store stops a task that depends on it with the real error, instead of quietly running without guidance', async () => {
    promote('go-engineering');
    const raw = new DatabaseSync(dbPath());
    raw.exec('DROP TRIGGER engineering_knowledge_one_way_revoke');
    raw.exec("UPDATE engineering_knowledge SET manifest_json = replace(manifest_json, 'Go engineering', 'Go ENGINEERING')");
    raw.close();
    const r = await start(workflow(() => loadActiveCatalog(dbPath())), base({ ids: ['go-engineering'], selectionDigest: '0'.repeat(64) }));
    assert.notEqual(r.status === 'success' ? r.result!.status : r.status, 'PASS');
    assert.equal(prompts.length, 0);
  });
});

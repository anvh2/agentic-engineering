import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findProjectRoot } from '../../core/paths.ts';
import { agentsForTask } from '../../runtime/knowledge/packs/agents.ts';
import { loadPackRegistry } from '../../runtime/knowledge/packs/loader.ts';
import { createFixtureRepo } from '../../workers/tools/__testing__/fixture-repo.ts';
import { report, scriptedModel, type ScriptStep } from './__testing__/scripted-model.ts';
import { MAX_SPECIALISTS_PER_REVIEW, reviewRequestFromTask, runSpecialistReviews, type VerifiedTaskLike } from './specialist-review-runner.ts';
import { createMastraSpecialist } from './specialist-agents.ts';
import { createSpecialistReviewWorkflow } from './workflows/specialist-review-workflow.ts';

const pack = loadPackRegistry(findProjectRoot()!);
const task = (over: Partial<VerifiedTaskLike> = {}): VerifiedTaskLike => ({
  id: 'task-1', state: 'REVIEW_PENDING', worktreePath: '/placeholder',
  spec: { request: { contract: { objective: 'Review CalculateTotal for correctness.', allowedFiles: ['internal/service.go'] } } }, ...over,
});

async function harness(script: readonly ScriptStep[] | ((call: number) => ScriptStep)) {
  const fixture = await createFixtureRepo('CalculateTotal');
  const scripted = scriptedModel(script);
  const workflow = createSpecialistReviewWorkflow({
    registry: pack, allowedRoots: () => [fixture.parent], contextTokens: () => 16_384,
    resolveAgent: (manifest) => createMastraSpecialist(manifest, { model: scripted.model }) as never,
  });
  const request = reviewRequestFromTask(task({ worktreePath: fixture.root }), { language: 'go' });
  return { fixture, scripted, workflow, request, done: () => fixture.cleanup() };
}

test('only a runtime-verified task parked for review is reviewed; anything else is an explicit refusal', () => {
  assert.throws(() => reviewRequestFromTask(task({ state: 'ESCALATED' }), { language: 'go' }), /needs a runtime-verified task in REVIEW_PENDING/);
  assert.throws(() => reviewRequestFromTask(task({ state: 'RUNNING' }), { language: 'go' }), /REVIEW_PENDING/);
  assert.throws(() => reviewRequestFromTask(task({ worktreePath: null }), { language: 'go' }), /no worktree/);
  assert.throws(() => reviewRequestFromTask(task({ spec: {} }), { language: 'go' }), /no delegation contract/);
  assert.deepEqual(reviewRequestFromTask(task(), { language: 'go' }).focusPaths, ['internal/service.go']);
});

test('specialists are chosen by the capability gate, capped, run one at a time, and the summary can carry no verdict', async () => {
  const h = await harness([{ text: report() }]);
  try {
    const fit = agentsForTask(pack.agents, { language: 'go', taskType: 'review' });
    assert.ok(fit.length >= 1);
    const s = await runSpecialistReviews({ workflow: h.workflow, registry: pack }, h.request);
    assert.deepEqual(s.selected, fit.slice(0, MAX_SPECIALISTS_PER_REVIEW));
    assert.deepEqual(s.skippedForCap, fit.slice(MAX_SPECIALISTS_PER_REVIEW));
    assert.equal(s.runs.length, s.selected.length);
    assert.ok(s.runs.every((r) => r.status === 'REPORTED' && r.workflowRunId && r.inferenceCalls >= 1), JSON.stringify(s.runs));
    assert.equal(s.advisory, true);
    for (const forbidden of ['verdict', 'approved', 'passed', 'decision', 'approve']) assert.ok(!(forbidden in s), `summary must not carry "${forbidden}"`);
    assert.equal((await runSpecialistReviews({ workflow: h.workflow, registry: pack, maxSpecialists: 99 }, h.request)).selected.length, Math.min(fit.length, MAX_SPECIALISTS_PER_REVIEW), 'the cap cannot be raised by the caller');
  } finally { await h.done(); }
});

test('one specialist failing is recorded and contained: the next one still runs and nothing throws', async () => {
  const h = await harness((call) => (call === 0 ? { error: new Error('provider down') } : { text: report() }));
  try {
    const s = await runSpecialistReviews({ workflow: h.workflow, registry: pack }, h.request);
    assert.ok(s.runs.length >= 2, 'containment needs at least two specialists to be observable');
    assert.equal(s.runs[0]!.status, 'PROVIDER_ERROR');
    assert.ok(s.runs.slice(1).every((r) => r.status === 'REPORTED'), JSON.stringify(s.runs));
  } finally { await h.done(); }
});

test('cancellation stops the remaining specialists before they start and no model is called', async () => {
  const h = await harness([{ text: report() }]);
  try {
    const ctl = new AbortController();
    ctl.abort();
    const s = await runSpecialistReviews({ workflow: h.workflow, registry: pack, signal: ctl.signal }, h.request);
    assert.ok(s.runs.length >= 1 && s.runs.every((r) => r.status === 'CANCELED'));
    assert.equal(h.scripted.calls(), 0);
  } finally { await h.done(); }
});

test('the lead can put the specialists it needs first; unknown or non-fitting ids are ignored and the cap still holds', async () => {
  const h = await harness([{ text: report() }]);
  try {
    const defaultOrder = (await runSpecialistReviews({ workflow: h.workflow, registry: pack }, h.request)).selected;
    assert.ok(!defaultOrder.includes('security-reviewer'), 'the default alphabetical order would have skipped the security reviewer');
    const s = await runSpecialistReviews({ workflow: h.workflow, registry: pack, prefer: ['security-reviewer', 'not-a-specialist', 'security-reviewer', 'ruby-reviewer'] }, h.request);
    assert.equal(s.selected[0], 'security-reviewer');
    assert.equal(s.selected.length, MAX_SPECIALISTS_PER_REVIEW);
    assert.ok(!s.selected.includes('not-a-specialist') && !s.selected.includes('ruby-reviewer'), 'ids that do not fit a Go review are not honoured');
    assert.equal(new Set(s.selected).size, s.selected.length, 'no duplicates');
  } finally { await h.done(); }
});

test('ADR invariant: substituting the model keeps the agent identity, manifest digest and registered id; only the run id and the model change', async () => {
  const a = await harness([{ text: report() }]);
  const b = await harness([{ text: report() }]);
  try {
    const one = (await runSpecialistReviews({ workflow: a.workflow, registry: pack, maxSpecialists: 1, prefer: ['go-reviewer'] }, a.request)).runs[0]!;
    const two = (await runSpecialistReviews({ workflow: b.workflow, registry: pack, maxSpecialists: 1, prefer: ['go-reviewer'] }, b.request)).runs[0]!;
    assert.equal(one.specialistId, 'go-reviewer');
    assert.equal(two.specialistId, one.specialistId, 'the agent is the same agent whatever model backs it');
    assert.notEqual(one.workflowRunId, two.workflowRunId, 'each execution has its own run id');
    const agentA = createMastraSpecialist(pack.agentById.get('go-reviewer')!, { model: a.scripted.model });
    const agentB = createMastraSpecialist(pack.agentById.get('go-reviewer')!, { model: scriptedModel([{ text: report() }]).model });
    assert.equal(agentA.id, agentB.id);
    assert.ok(!/scripted|qwen|ollama|claude/i.test(agentA.id), 'the agent id never encodes a model or provider');
  } finally { await a.done(); await b.done(); }
});

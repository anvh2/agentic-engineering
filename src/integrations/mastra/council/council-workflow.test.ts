import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { findProjectRoot } from '../../../core/paths.ts';
import { councilRecordIntact, type CouncilRecord } from '../../../runtime/council/record.ts';
import { loadPackRegistry } from '../../../runtime/knowledge/packs/loader.ts';
import { createEngineeringCouncilWorkflow, type CouncilWorkflowDeps, type CouncilWorkflowInput, type CouncilWorkflowResult } from './council-workflow.ts';
import { createScriptedCouncilAgents } from './scripted.ts';

const root = findProjectRoot()!;
const registry = loadPackRegistry(root);
const SEATS = ['architect', 'security-reviewer', 'reliability-reviewer'];

function harness(extra: Partial<CouncilWorkflowDeps> = {}) {
  const workdir = mkdtempSync(join(tmpdir(), 'council-wf-'));
  const deps: CouncilWorkflowDeps = { workdir, registry, env: {}, allowedRoots: () => [root], ...extra };
  const workflow = createEngineeringCouncilWorkflow(deps);
  // The same registration index.ts performs: scripted agents live in a real Mastra instance next to the workflow.
  const mastra = new Mastra({ agents: createScriptedCouncilAgents(registry, SEATS), workflows: { engineeringCouncilWorkflow: workflow } });
  const run = async (input: CouncilWorkflowInput = {}) => {
    const r = await (await mastra.getWorkflow('engineeringCouncilWorkflow').createRun()).start({ inputData: input as never });
    return r as unknown as { status: string; result?: CouncilWorkflowResult; error?: unknown };
  };
  const record = (meetingId: string): CouncilRecord => JSON.parse(readFileSync(join(workdir, 'council', meetingId, 'record.json'), 'utf8'));
  return { workdir, run, record, done: () => rmSync(workdir, { recursive: true, force: true }) };
}

test('SCRIPTED council end to end: 3 specialists, blind proposals, critique with a real disagreement, synthesis, durable record', async () => {
  const h = harness();
  try {
    const r = await h.run({ meetingId: 'happy' });
    assert.equal(r.status, 'success', JSON.stringify(r.error));
    const result = r.result!;
    assert.equal(result.status, 'recorded');
    assert.equal(result.mode, 'SCRIPTED');
    assert.equal(result.outcome, 'decided');
    assert.equal(result.humanApproval, 'pending');
    assert.equal(result.advisory, true);
    assert.deepEqual(result.panel.map((p) => p.specialistId).sort(), [...SEATS].sort());
    assert.equal(result.panel.find((p) => p.chair)!.specialistId, 'architect');
    assert.ok(result.panel.every((p) => p.provider === 'scripted'), 'a scripted record never claims a real model');
    assert.equal(result.disagreementRaised, true);

    const rec = h.record('happy');
    assert.ok(councilRecordIntact(rec));
    assert.deepEqual(rec.rounds.map((x) => x.phase), ['proposal', 'critique', 'synthesis']);
    assert.equal(rec.proposals.length, 3);
    assert.equal(new Set(rec.proposals.map((p) => p.specialistId)).size, 3, 'one proposal per distinct specialist');
    assert.deepEqual(rec.critiques.map((c) => c.stance).sort(), ['object', 'object', 'support']);
    for (const c of rec.critiques) assert.notEqual(c.specialistId, c.targetSpecialistId, 'nobody critiques their own proposal');
    assert.ok(rec.synthesis);
    assert.equal(rec.synthesis!.recorded.authority, 'none');
    assert.equal(rec.synthesis!.recorded.contested, true, 'the chair adopted a proposal over outstanding objections: the record says so');
    assert.ok(rec.disagreements.objections.every((o) => o.status === 'outstanding'));
    const synth = rec.synthesis!.synthesis as { uncertainties: string[]; disagreements: { status: string }[] };
    assert.ok(synth.uncertainties.length > 0 && synth.disagreements.some((d) => d.status === 'unresolved'));
    assert.equal(rec.humanApproval.status, 'pending');
    assert.match(rec.limitations[0]!, /^SCRIPTED/);
    assert.equal(rec.workflowRuns.length, 1);
    assert.equal(rec.workflowRuns[0]!.runId, result.workflowRunId);
    // 3 proposals + 3 critiques + 1 synthesis = 7 model calls; round-3 members never speak because the decision ended the meeting.
    assert.equal(rec.accounting.modelCalls, 7);
    assert.equal(rec.accounting.reasks, 0);
    assert.equal(rec.accounting.turnsReserved, 7);
    assert.deepEqual(rec.accounting.tokens.input === 'UNKNOWN', false);
    // Proposals used the read-only tool: the journal shows a readFile per seat, and nothing else.
    const proposalCalls = rec.calls.filter((c) => c.phase === 'proposal');
    assert.equal(proposalCalls.length, 3);
    for (const c of proposalCalls) assert.deepEqual(c.toolCalls, [{ tool: 'readFile', count: 1 }]);
    for (const f of ['record.json', 'record.md', 'meeting-record.json', 'calls.jsonl', 'meeting.json']) assert.ok(existsSync(join(h.workdir, 'council', 'happy', f)), f);
    const md = readFileSync(join(h.workdir, 'council', 'happy', 'record.md'), 'utf8');
    assert.match(md, /\[SCRIPTED\]/);
    assert.match(md, /OBJECTS to/);
    assert.match(md, /Human approval: \*\*pending\*\*/);
  } finally { h.done(); }
});

test('re-running a closed meeting returns its record and makes no model call', async () => {
  const h = harness();
  try {
    await h.run({ meetingId: 'again' });
    const first = h.record('again');
    const r = await h.run({ meetingId: 'again' });
    assert.equal(r.result!.status, 'recorded');
    const second = h.record('again');
    assert.equal(second.accounting.modelCalls, first.accounting.modelCalls, 'no new call');
    assert.equal(second.workflowRuns.length, 2, 'the second workflow run is evidenced, not hidden');
  } finally { h.done(); }
});

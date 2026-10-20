import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { findProjectRoot } from '../../../core/paths.ts';
import { resolvePanel } from '../../../runtime/council/panel.ts';
import type { SpecialistCall, SpecialistInvoker } from '../../../runtime/council/participant.ts';
import type { CouncilRecord } from '../../../runtime/council/record.ts';
import { TOOL_CLASSES } from '../../../runtime/knowledge/engineering-hooks.ts';
import { loadPackRegistry } from '../../../runtime/knowledge/packs/loader.ts';
import { createFixtureRepo } from '../../../workers/tools/__testing__/fixture-repo.ts';
import { scriptedModel } from '../__testing__/scripted-model.ts';
import { registerSpecialists, createMastraSpecialist } from '../specialist-agents.ts';
import { createEngineeringCouncilWorkflow, type CouncilWorkflowDeps, type CouncilWorkflowInput, type CouncilWorkflowResult } from './council-workflow.ts';
import { createMastraInvoker } from './invoker.ts';
import { councilReadiness } from './readiness.ts';
import { councilRegistration } from './register.ts';
import { createScriptedCouncilAgents } from './scripted.ts';

const root = findProjectRoot()!;
const registry = loadPackRegistry(root);
const seats = (() => { const p = resolvePanel({ registry, language: 'ts', contextTokens: 32_000 }); assert.ok(p.ok); return p.seats; })();

const validProposal = JSON.stringify({ position: 'p', rationale: 'r', risks: [], evidence: ['internal/service.go'], unknowns: [] });

test('denied tools and unauthorized paths: a specialist that tries to write, or to read outside the repository, gets nothing and changes nothing', async () => {
  const fixture = await createFixtureRepo('CalculateTotal');
  try {
    await writeFile(join(fixture.parent, 'outside-secret.txt'), 'TOPSECRET-OUTSIDE\n');
    const scripted = scriptedModel([
      { toolCall: { name: 'writeFile', args: { path: 'pwned.txt', content: 'x' } } },
      { toolCall: { name: 'readFile', args: { path: '../outside-secret.txt' } } },
      { toolCall: { name: 'readFile', args: { path: '/etc/hosts' } } },
      { toolCall: { name: 'readFile', args: { path: 'internal/service.go' } } },
      { text: validProposal },
    ]);
    const manifest = registry.agentById.get('architect')!;
    const agent = createMastraSpecialist(manifest, { model: scripted.model });
    const invoker = createMastraInvoker({ resolveAgent: () => agent as never, repositoryRoot: fixture.root, workflowRunId: 'wf-1' });
    const call: SpecialistCall = { meetingId: 'm', seat: seats[0]!, phase: 'proposal', round: 1, turn: 0, attempt: 1, instructions: 'x', prompt: 'COUNCIL m | PHASE: proposal | SEAT: architect', signal: new AbortController().signal };
    const result = await invoker.invoke(call);

    assert.equal(result.text, validProposal, 'the specialist survived the denials and produced its reply');
    assert.equal(existsSync(join(fixture.root, 'pwned.txt')), false, 'no write tool exists for a specialist');
    assert.equal(existsSync(join(fixture.parent, 'pwned.txt')), false);
    const seen = scripted.seenText();
    assert.doesNotMatch(seen, /TOPSECRET-OUTSIDE/, 'a path outside the repository root was never read');
    assert.doesNotMatch(seen, /localhost/, '/etc/hosts was never read');
    assert.match(seen, /func CalculateTotal/, 'the allowed read worked: the root came from RequestContext');
    assert.equal(scripted.calls(), 5);
    assert.ok(Object.keys(await agent.listTools()).every((t) => TOOL_CLASSES[t] === 'read'));
    assert.ok(!Object.keys(await agent.listTools()).includes('writeFile'));
  } finally { await fixture.cleanup(); }
});

test('an aborted call is never a reply, even though Mastra can return normally after an abort', async () => {
  const fixture = await createFixtureRepo();
  try {
    const ac = new AbortController();
    const scripted = scriptedModel(() => { ac.abort(new Error('stop')); return { text: validProposal }; });
    const agent = createMastraSpecialist(registry.agentById.get('architect')!, { model: scripted.model });
    const invoker = createMastraInvoker({ resolveAgent: () => agent as never, repositoryRoot: fixture.root, workflowRunId: 'wf-1' });
    await assert.rejects(invoker.invoke({ meetingId: 'm', seat: seats[0]!, phase: 'proposal', round: 1, turn: 0, attempt: 1, instructions: 'x', prompt: 'COUNCIL m | PHASE: proposal | SEAT: architect', signal: ac.signal }), /aborted|stop/);
  } finally { await fixture.cleanup(); }
});

function workflowHarness(extra: Partial<CouncilWorkflowDeps> = {}) {
  const workdir = mkdtempSync(join(tmpdir(), 'council-wf2-'));
  const calls: SpecialistCall[] = [];
  const counting: SpecialistInvoker = { async invoke(call) { calls.push(call); throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); } };
  const wf = createEngineeringCouncilWorkflow({ workdir, registry, env: {}, allowedRoots: () => [root], invokerFor: () => counting, ...extra });
  const mastra = new Mastra({ workflows: { engineeringCouncilWorkflow: wf } });
  const run = async (input: CouncilWorkflowInput) => (await (await mastra.getWorkflow('engineeringCouncilWorkflow').createRun()).start({ inputData: input as never })) as unknown as { status: string; result?: CouncilWorkflowResult };
  return { workdir, calls, run, done: () => rmSync(workdir, { recursive: true, force: true }) };
}

test('refusals through the workflow: nothing starts, no model is called, no meeting directory appears', async () => {
  const h = workflowHarness({ env: { AGENTIC_COUNCIL_LIVE: '1', OLLAMA_NUM_CTX: '8192' }, probe: async () => ({ id: 'ollama', configured: false, basis: 'probe', detail: 'endpoint unreachable' }) });
  try {
    const cases: [CouncilWorkflowInput & { meetingId: string }, RegExp][] = [
      [{ meetingId: 'outside', repository: tmpdir() }, /repository_refused/],
      [{ meetingId: 'live-missing', mode: 'live' }, /model_not_ready: endpoint unreachable/],
      [{ meetingId: 'bad-focus', focusPaths: ['../x'], question: 'q' }, /focus_path_refused/],
    ];
    for (const [input, pattern] of cases) {
      const r = await h.run(input);
      assert.equal(r.status, 'success');
      assert.equal(r.result!.status, 'refused', input.meetingId);
      assert.match(r.result!.reasons.join(' | '), pattern, input.meetingId);
      assert.equal(r.result!.humanApproval, 'pending');
      assert.equal(existsSync(join(h.workdir, 'council', input.meetingId)), false);
    }
    assert.equal(h.calls.length, 0);
  } finally { h.done(); }
});

test('input validation rejects an unknown mode before any step runs', async () => {
  const h = workflowHarness();
  try {
    await assert.rejects(h.run({ mode: 'paid' as never }), /Invalid input data[\s\S]*mode/);
    await assert.rejects(h.run({ meetingId: '../escape' }), /Invalid input data[\s\S]*meetingId/);
    await assert.rejects(h.run({ question: 'x'.repeat(5_000) }), /Invalid input data[\s\S]*question/);
    assert.equal(h.calls.length, 0);
  } finally { h.done(); }
});

test('Ollama offline: the provider error fails the meeting closed with the reason, records the lost call, and invents no proposal', async () => {
  const h = workflowHarness();
  try {
    const r = await h.run({ meetingId: 'offline' });
    assert.equal(r.status, 'success');
    assert.equal(r.result!.status, 'recorded');
    assert.equal(r.result!.outcome, 'failed');
    assert.match(r.result!.reasons.join(), /council-architect failed: connect ECONNREFUSED/);
    assert.equal(h.calls.length, 1, 'one attempt, no retry of a provider failure');
    const rec = JSON.parse(readFileSync(join(h.workdir, 'council', 'offline', 'record.json'), 'utf8')) as CouncilRecord;
    assert.equal(rec.proposals.length, 0);
    assert.equal(rec.synthesis, null);
    assert.equal(rec.accounting.failedCalls, 1);
    assert.equal(rec.humanApproval.status, 'pending');
  } finally { h.done(); }
});

test('registration: the council agents are read-only, no model call is made to register them, and status names what is missing', async () => {
  const scripted = createScriptedCouncilAgents(registry, ['architect', 'security-reviewer', 'reliability-reviewer']);
  assert.equal(Object.keys(scripted).length, 3);
  for (const [key, agent] of Object.entries(scripted)) {
    const tools = Object.keys(await agent.listTools());
    assert.ok(tools.length > 0, key);
    for (const t of tools) assert.equal(TOOL_CLASSES[t], 'read', `${key} holds non-read tool ${t}`);
  }
  const specialists = registerSpecialists(registry);
  const reg = councilRegistration(specialists);
  assert.equal(Object.keys(reg.agents).length, 3);
  const mastra = new Mastra({ agents: { ...specialists.agents, ...reg.agents }, workflows: { engineeringCouncilWorkflow: reg.workflow } });
  assert.equal(Object.keys(mastra.listAgents()).length, registry.agents.length + 3);

  const ok = await councilReadiness({ specialists, env: {} });
  assert.equal(ok.scripted.ready, true);
  assert.equal(ok.live.ready, false);
  assert.match(ok.live.reasons.join(), /model_context_undeclared/);
  assert.equal(ok.live.reasons.filter((r) => /context/.test(r)).length, 1, 'said once, not once per seat');
  assert.match(ok.live.reasons.join(), /live_not_enabled/);
  assert.match(ok.live.reasons.join(), /model_not_checked/);

  const noPack = await councilReadiness({ specialists: { agents: {}, registry: undefined, error: 'cannot read pack' }, env: {} });
  assert.equal(noPack.pack.loaded, false);
  assert.equal(noPack.scripted.ready, false);
  assert.match(noPack.scripted.reasons.join(), /pack_unavailable: cannot read pack/);
  assert.deepEqual(noPack.mastra.panelMissing, ['architect', 'security-reviewer', 'reliability-reviewer']);

  const partial = await councilReadiness({ specialists: { ...specialists, agents: Object.fromEntries(Object.entries(specialists.agents).filter(([k]) => k !== 'specialist_architect')) }, env: {} });
  assert.deepEqual(partial.mastra.panelMissing, ['architect']);
  assert.equal(partial.scripted.ready, false);

  const ready = await councilReadiness({ specialists, env: { AGENTIC_COUNCIL_LIVE: '1', OLLAMA_NUM_CTX: '8192' }, probe: true, probeImpl: async () => ({ id: 'ollama', configured: true, basis: 'probe', detail: 'endpoint reachable and model present', model: 'qwen3:8b' }) });
  assert.equal(ready.live.ready, true, ready.live.reasons.join());
});

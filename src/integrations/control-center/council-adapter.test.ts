import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Mastra } from '@mastra/core/mastra';
import { findProjectRoot } from '../../core/paths.ts';
import { loadPackRegistry } from '../../runtime/knowledge/packs/loader.ts';
import { AGENT_ROLES, ModelRegistry, ModelResolver } from '../../runtime/models/index.ts';
import { createEngineeringCouncilWorkflow } from '../mastra/council/council-workflow.ts';
import { createScriptedCouncilAgents } from '../mastra/council/scripted.ts';
import { prepareCouncil } from '../../runtime/council/run.ts';
import { registerSpecialists } from '../mastra/specialist-agents.ts';
import { agentRoster } from './agents-adapter.ts';
import { createCouncilReader } from './council-adapter.ts';
import { createControlCenterApp } from './http-app.ts';
import { fixture } from './__testing__/fixture.ts';

const root = findProjectRoot()!;
const registry = loadPackRegistry(root);
const SEATS = ['architect', 'security-reviewer', 'reliability-reviewer'];
const ORIGIN = 'http://127.0.0.1:4111';

/** A real SCRIPTED council meeting, held by the council workflow on the M9/M10 engine, in a fresh workdir. */
async function heldMeeting(meetingId = 'org-scripted-1') {
  const workdir = mkdtempSync(join(tmpdir(), 'org-council-'));
  const workflow = createEngineeringCouncilWorkflow({ workdir, registry, env: {}, allowedRoots: () => [root] });
  const mastra = new Mastra({ agents: createScriptedCouncilAgents(registry, SEATS), workflows: { engineeringCouncilWorkflow: workflow } });
  const run = await (await mastra.getWorkflow('engineeringCouncilWorkflow').createRun()).start({ inputData: { meetingId } as never });
  assert.equal((run as { result?: { status: string } }).result?.status, 'recorded', JSON.stringify(run));
  return { workdir, meetingId, runId: (run as { result: { workflowRunId: string } }).result.workflowRunId, done: () => rmSync(workdir, { recursive: true, force: true }) };
}

test('council meetings come from the verified Core B store, labelled SCRIPTED, linked to their record and workflow run', async (t) => {
  const m = await heldMeeting(); t.after(m.done);
  const view = createCouncilReader({ workdir: m.workdir, studioOrigin: ORIGIN }).snapshot();
  assert.equal(view.availability, 'AVAILABLE');
  assert.equal(view.source, 'core');
  assert.equal(view.meetings.length, 1);
  const meeting = view.meetings[0]!;
  assert.equal(meeting.id, `council-${m.meetingId}`);
  assert.equal(meeting.councilIssue, null);
  assert.equal(meeting.council?.mode, 'SCRIPTED');
  assert.equal(meeting.council?.model, 'scripted/scripted-council-1');
  assert.equal(meeting.council?.modelCalls, 7);
  assert.equal(meeting.council?.failedCalls, 0);
  assert.equal(meeting.council?.integrity, 'RECORD_VERIFIED');
  assert.deepEqual(meeting.council?.workflowRuns, [{ runId: m.runId, url: `${ORIGIN}/workflows/engineering-council-workflow/graph/${m.runId}` }]);
  assert.equal(meeting.council?.recordPath, `.workdir/council/${m.meetingId}/record.md`);
  // Proposals, objections and the decision are Core B's own messages and record, not the council's summary.
  const thread = view.threads.find((th) => th.id === meeting.threadId)!;
  assert.equal(thread.messages.filter((x) => x.type === 'PROPOSAL').length, 3);
  assert.ok(thread.messages.some((x) => x.type === 'OBJECTION'));
  assert.equal(meeting.decisions.length, 1);
  assert.match(meeting.decisions[0]!.text, /grants no authority/);
  assert.deepEqual(meeting.participants.map((p) => [p.name, p.provider]), [['Architect', 'scripted'], ['Security Reviewer', 'scripted'], ['Reliability Reviewer', 'scripted']]);
  assert.ok(meeting.provenance && meeting.endedAt);
});

test('a council record that does not match the verified events loses its claims; the meeting itself is still shown', async (t) => {
  const m = await heldMeeting(); t.after(m.done);
  const recordPath = join(m.workdir, 'council', m.meetingId, 'record.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  writeFileSync(recordPath, JSON.stringify({ ...record, integrity: { ...record.integrity, meetingRecordHash: 'f'.repeat(64) } }));
  let meeting = createCouncilReader({ workdir: m.workdir, studioOrigin: ORIGIN }).snapshot().meetings[0]!;
  assert.equal(meeting.council, null);
  assert.match(meeting.councilIssue!, /does not match the verified meeting record/);
  assert.equal(meeting.decisions.length, 1, 'Core B still verifies and shows the meeting');

  // A sidecar relabelling a scripted meeting as LIVE is refused: the verified participants say scripted.
  writeFileSync(recordPath, JSON.stringify(record));
  const sidecarPath = join(m.workdir, 'council', m.meetingId, 'meeting.json');
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  writeFileSync(sidecarPath, JSON.stringify({ ...sidecar, mode: 'LIVE', model: { provider: 'ollama', model: 'qwen3:8b' } }));
  meeting = createCouncilReader({ workdir: m.workdir, studioOrigin: ORIGIN }).snapshot().meetings[0]!;
  assert.equal(meeting.council, null);
  assert.match(meeting.councilIssue!, /claims ollama\/qwen3:8b, but the verified participants are scripted\/scripted-council-1/);
});

test('a council store without its append-only guards is an integrity failure, never an empty list; a missing store says why', async (t) => {
  const m = await heldMeeting(); t.after(m.done);
  const db = new DatabaseSync(join(m.workdir, 'council', 'council.db'));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  // A copy laid out as <workdir>/council/council.db, with one append-only guard removed.
  const workdir = mkdtempSync(join(tmpdir(), 'org-council-corrupt-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  mkdirSync(join(workdir, 'council'));
  copyFileSync(join(m.workdir, 'council', 'council.db'), join(workdir, 'council', 'council.db'));
  const tampered = new DatabaseSync(join(workdir, 'council', 'council.db'));
  tampered.exec('DROP TRIGGER collab_events_no_update');
  tampered.close();
  const view = createCouncilReader({ workdir, studioOrigin: ORIGIN }).snapshot();
  assert.equal(view.availability, 'CORRUPT');
  assert.deepEqual(view.meetings, []);

  const missing = createCouncilReader({ workdir: mkdtempSync(join(tmpdir(), 'org-council-none-')), studioOrigin: ORIGIN }).snapshot();
  assert.equal(missing.availability, 'NOT_AVAILABLE');
  assert.match(missing.reason!, /No council meetings have been held/);
});

test('the agent roster is the registration: bindings, and registered / refused / unavailable are kept apart', () => {
  const ok = { state: 'available' } as const;
  const caps = { toolCalling: true, structuredOutput: true };
  const models = new ModelRegistry()
    .addProvider({ providerId: 'ollama', kind: 'local', url: 'http://127.0.0.1:9/v1', billing: 'local-free', credential: { env: 'OLLAMA_API_KEY', placeholder: 'ollama' }, availability: ok })
    .addModel({ providerId: 'ollama', modelId: 'qwen3:8b', capabilities: caps, availability: ok, roles: AGENT_ROLES })
    .addModel({ providerId: 'ollama', modelId: 'qwen3:gone', capabilities: caps, availability: { state: 'unavailable', reason: 'not installed' }, roles: AGENT_ROLES })
    .addModel({ providerId: 'ollama', modelId: 'coder-only', capabilities: caps, availability: ok, roles: ['coding-worker'] });
  const resolver = new ModelResolver(models, {
    defaults: { 'coding-worker': { providerId: 'ollama', modelId: 'qwen3:8b' }, specialist: { providerId: 'ollama', modelId: 'qwen3:8b' } },
    assignments: { 'specialist-architect': { providerId: 'ollama', modelId: 'qwen3:gone' }, 'specialist-security-reviewer': { providerId: 'ollama', modelId: 'coder-only' } },
  }, {});
  const specialists = registerSpecialists(registry, { resolver });
  const roster = agentRoster({ specialists, councilAgents: createScriptedCouncilAgents(registry, SEATS) });
  const row = (id: string) => roster.agents.find((a) => a.agentId === id)!;
  assert.equal(row('specialist-architect').status, 'unavailable');
  assert.match(row('specialist-architect').reason!, /^model_unavailable/);
  assert.equal(row('specialist-security-reviewer').status, 'refused');
  assert.match(row('specialist-security-reviewer').reason!, /^unauthorized_model/);
  assert.deepEqual([row('specialist-reliability-reviewer').status, row('specialist-reliability-reviewer').model, row('specialist-reliability-reviewer').modelPinned], ['registered', 'ollama/qwen3:8b', true]);
  assert.equal(roster.counts.registered, registry.agents.length - 2 + SEATS.length);
  assert.ok(roster.agents.filter((a) => a.kind === 'council-scripted').every((a) => a.model === 'scripted/scripted-council-1' && /SCRIPTED/.test(a.reason!)));

  (specialists.agents.specialist_reliability_reviewer as unknown as { __updateModel(o: { model: string }): void }).__updateModel({ model: 'openai/gpt-4o' });
  assert.equal(agentRoster({ specialists }).agents.find((a) => a.agentId === 'specialist-reliability-reviewer')!.modelPinned, false, 'a repointed agent is flagged');
});

test('Gateway: /council and /agents are read-only, same-origin and stream council invalidations', async (t) => {
  const m = await heldMeeting(); t.after(m.done);
  const f = fixture(); t.after(() => f.close());
  const council = createCouncilReader({ workdir: m.workdir, studioOrigin: ORIGIN });
  const app = createControlCenterApp({ reader: f.reader, assetsDir: f.directory, embedded: true, council, agents: () => agentRoster({ specialists: registerSpecialists(registry) }) });
  t.after(() => app.closeStreams());
  const get = (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost:4111${path}`, init));
  const view = await get('/control-center/v1/council').json();
  assert.equal(view.meetings[0].council.mode, 'SCRIPTED');
  const roster = await get('/control-center/v1/agents').json();
  assert.equal(roster.source, 'mastra-registration');
  for (const path of ['/control-center/v1/council', '/control-center/v1/agents']) {
    assert.equal(get(path, { method: 'POST' }).status, 405);
    assert.equal(get(path, { headers: { origin: 'https://external.example' } }).status, 403);
    assert.equal(app.fetch(new Request(`http://external.example${path}`)).status, 403);
  }
  const abort = new AbortController();
  const stream = get('/control-center/v1/council/events?cursor=0', { signal: abort.signal }).body!.getReader();
  let text = '';
  while (!/event: collab/.test(text)) text += new TextDecoder().decode((await stream.read()).value);
  assert.doesNotMatch(text, /PROPOSAL|position|rationale/, 'frames carry ids and types, never message bodies');
  abort.abort();

  const bare = createControlCenterApp({ reader: f.reader, assetsDir: f.directory, embedded: true });
  assert.equal((await bare.fetch(new Request('http://localhost:4111/control-center/v1/council')).json()).availability, 'NOT_AVAILABLE');
  assert.equal((await bare.fetch(new Request('http://localhost:4111/control-center/v1/agents')).json()).source, 'unavailable');
});

test('runs, calls and traces come only from an intact record: a raw-log append or a body edit is never shown as verified', async (t) => {
  const m = await heldMeeting(); t.after(m.done);
  const dir = join(m.workdir, 'council', m.meetingId);
  // A replay of the closed meeting appends a run that made no model call; it is not in the record and is not listed.
  writeFileSync(join(dir, 'workflow-runs.jsonl'), `${readFileSync(join(dir, 'workflow-runs.jsonl'), 'utf8')}${JSON.stringify({ runId: 'replayed-run-0', at: 1 })}\n`);
  let meeting = createCouncilReader({ workdir: m.workdir, studioOrigin: ORIGIN }).snapshot().meetings[0]!;
  assert.deepEqual(meeting.council?.workflowRuns.map((r) => r.runId), [m.runId]);
  // Editing the record body (here, its call count) breaks the record's own hash.
  const record = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  writeFileSync(join(dir, 'record.json'), JSON.stringify({ ...record, accounting: { ...record.accounting, modelCalls: 1 } }));
  meeting = createCouncilReader({ workdir: m.workdir, studioOrigin: ORIGIN }).snapshot().meetings[0]!;
  assert.equal(meeting.council, null);
  assert.match(meeting.councilIssue!, /fails its own integrity hash/);
});

test('an open meeting is OPEN_UNRECORDED: mode and model checked against events, no runs or call counts claimed', async (t) => {
  const workdir = mkdtempSync(join(tmpdir(), 'org-council-open-')); t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const opened = await prepareCouncil({ workdir, registry, env: {}, allowedRoots: () => [root] }, { meetingId: 'open-1', mode: 'SCRIPTED', question: 'Which lease length?', repository: root });
  assert.equal(opened.status, 'ready');
  const meeting = createCouncilReader({ workdir, studioOrigin: ORIGIN }).snapshot().meetings[0]!;
  assert.equal(meeting.status, 'OPEN');
  assert.equal(meeting.provenance, null);
  assert.deepEqual([meeting.council?.integrity, meeting.council?.mode, meeting.council?.modelCalls, meeting.council?.toolCalls, meeting.council?.workflowRuns], ['OPEN_UNRECORDED', 'SCRIPTED', null, null, []]);
});

test('a sidecar is trusted only for its own session: a copied or misnamed one is ignored, two claimants are both dropped', async (t) => {
  const m = await heldMeeting(); t.after(m.done);
  const src = join(m.workdir, 'council', m.meetingId, 'meeting.json');
  mkdirSync(join(m.workdir, 'council', 'copy-1'));
  writeFileSync(join(m.workdir, 'council', 'copy-1', 'meeting.json'), readFileSync(src));
  assert.equal(createCouncilReader({ workdir: m.workdir, studioOrigin: ORIGIN }).snapshot().meetings[0]!.council?.mode, 'SCRIPTED', 'a copy under another name names another meeting and is ignored');
  const sidecar = JSON.parse(readFileSync(src, 'utf8'));
  writeFileSync(join(m.workdir, 'council', 'copy-1', 'meeting.json'), JSON.stringify({ ...sidecar, meetingId: 'copy-1' }));
  assert.equal(createCouncilReader({ workdir: m.workdir, studioOrigin: ORIGIN }).snapshot().meetings[0]!.council?.mode, 'SCRIPTED', 'its sessionId is not council-copy-1, so it is ignored');
});

test('/agents never carries a credential or an endpoint URL', () => {
  const ok = { state: 'available' } as const;
  const models = new ModelRegistry()
    .addProvider({ providerId: 'ollama', kind: 'local', url: 'http://127.0.0.1:9/v1', billing: 'local-free', credential: { env: 'OLLAMA_API_KEY' }, availability: ok })
    .addModel({ providerId: 'ollama', modelId: 'qwen3:8b', capabilities: { toolCalling: true, structuredOutput: true }, availability: ok, roles: AGENT_ROLES });
  const resolver = new ModelResolver(models, { defaults: { 'coding-worker': { providerId: 'ollama', modelId: 'qwen3:8b' }, specialist: { providerId: 'ollama', modelId: 'qwen3:8b' } } }, { OLLAMA_API_KEY: 'sekrit-loopback-key' });
  const wire = JSON.stringify(agentRoster({ specialists: registerSpecialists(registry, { resolver }) }));
  assert.doesNotMatch(wire, /sekrit|127\.0\.0\.1:9|apiKey|"url"/);
  assert.match(wire, /ollama\/qwen3:8b/);
});

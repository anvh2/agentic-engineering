import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { plan, workerTask } from '../../runtime/scheduler/test-helpers.ts';
import { collabHarness, openMeeting } from '../../runtime/collaboration/__testing__/harness.ts';
import { createCollaborationReader } from './collaboration-adapter.ts';
import { createControlCenterApp } from './http-app.ts';
import { snapshotSchema } from './contract.ts';
import { fixture } from './__testing__/fixture.ts';

/** B1 and historical-smoke belong to project 'proj' (the fixture); B9 is added to project 'other'. */
function scoped(t: { after(fn: () => void): void }) {
  const f = fixture();
  t.after(f.close);
  f.store.createBatch(plan('/synthetic-test-repo', [workerTask('other-task')], { batchId: 'B9', project: 'other' }));
  return f;
}
const call = (runId: string, attempt: number, inputTokens: number, outputTokens: number) => ({
  runId, workerId: 'worker-1', attempt, provider: 'ollama', model: 'qwen-test', startedAt: 1_000 + attempt, inferenceMs: 10, inputTokens, outputTokens, usageSupport: 'tokens',
});
const setCalls = (f: ReturnType<typeof fixture>, id: string, runIds: string[], calls: unknown) =>
  f.store.db.prepare("UPDATE tasks SET run_ids=?, artifacts=json_set(artifacts, '$.modelCalls', json(?)) WHERE id=?").run(JSON.stringify(runIds), JSON.stringify(calls), id);

test('a project scope covers exactly its batches from batches.project; an objective outside the project is an empty scope', t => {
  const f = scoped(t);
  const project = f.reader.snapshot({ project: 'proj' });
  assert.equal(snapshotSchema.safeParse(project).success, true);
  assert.deepEqual(project.scope, { project: 'proj', objectiveId: null, objectiveIds: ['B1', 'historical-smoke'] });
  assert.equal(project.objectiveId, null);
  assert.deepEqual(project.tasks.map(x => x.id).sort(), ['old-smoke', 'task-a', 'task-b']);
  const other = f.reader.snapshot({ project: 'other' });
  assert.deepEqual(other.tasks.map(x => x.id), ['other-task']);
  // One batch inside its project, or alone (the project then comes from the batch, never from a name match).
  assert.deepEqual(f.reader.snapshot({ project: 'proj', objectiveId: 'B1' }).tasks.map(x => x.id), ['task-a', 'task-b']);
  assert.equal(f.reader.snapshot('B9').scope?.project, 'other');
  // A batch that is not in the selected project is an empty scope, never a silently widened one.
  const mismatch = f.reader.snapshot({ project: 'proj', objectiveId: 'B9' });
  assert.deepEqual([mismatch.tasks.length, mismatch.scope?.objectiveIds], [0, []]);
  assert.equal(mismatch.source, 'connected');
  assert.deepEqual(f.reader.snapshot({ project: 'missing' }).scope?.objectiveIds, []);
  assert.deepEqual(f.reader.snapshot({ project: 'pro' }).tasks, [], 'no prefix or partial-name matching');
});

test('project usage is the exact sum of its objectives and excludes other projects', t => {
  const f = scoped(t);
  setCalls(f, 'task-a', ['run-a'], [call('run-a', 1, 100, 10), call('run-a', 2, 50, 5)]);
  setCalls(f, 'old-smoke', ['run-s'], [call('run-s', 1, 7, 3)]);
  setCalls(f, 'other-task', ['run-o'], [call('run-o', 1, 1000, 1000)]);
  const b1 = f.reader.snapshot('B1').usage;
  const smoke = f.reader.snapshot('historical-smoke').usage;
  const project = f.reader.snapshot({ project: 'proj' });
  assert.deepEqual([b1.inputTokens, smoke.inputTokens], [150, 7]);
  assert.deepEqual([project.usage.inputTokens, project.usage.outputTokens, project.usage.completeness], [157, 18, 'complete']);
  assert.deepEqual(project.calls.map(c => c.objectiveId).sort(), ['B1', 'B1', 'historical-smoke']);
  assert.equal(project.providers.find(p => p.id === 'ollama')!.usage.inputTokens, 157);
  assert.equal(f.reader.snapshot({ project: 'other' }).usage.inputTokens, 1000);
});

test('event replay follows the project scope and keeps cursor semantics', t => {
  const f = scoped(t);
  const start = f.reader.snapshot({ project: 'proj' }).cursor!;
  f.store.audit('task-a', 'actor', 'a');
  f.store.audit('old-smoke', 'actor', 'b');
  f.store.audit('other-task', 'actor', 'c');
  const replay = f.reader.eventsAfter({ project: 'proj' }, start);
  assert.equal(replay.reset, false);
  assert.deepEqual(replay.events.map(e => e.taskId), ['task-a', 'old-smoke']);
  assert.deepEqual(f.reader.eventsAfter('B1', start).events.map(e => e.taskId), ['task-a']);
  assert.deepEqual(f.reader.eventsAfter({ project: 'other' }, start).events.map(e => e.taskId), ['other-task']);
  assert.equal(f.reader.eventsAfter({ project: 'proj' }, 'not-a-cursor').reset, true);
});

test('gateway: project scope is accepted, bounded and validated; objective-only requests are unchanged', async t => {
  const f = scoped(t);
  const app = createControlCenterApp({ reader: f.reader, assetsDir: f.directory, embedded: true });
  const get = (path: string) => app.fetch(new Request(`http://localhost:4111/control-center/v1${path}`));
  const body = await get('/snapshot?project=proj').json();
  assert.deepEqual(body.scope.objectiveIds, ['B1', 'historical-smoke']);
  assert.deepEqual((await get('/snapshot?objectiveId=B1').json()).scope.objectiveIds, ['B1']);
  assert.equal(get(`/snapshot?project=${encodeURIComponent('a\u0000b')}`).status, 400);
  assert.equal(get(`/snapshot?project=${'x'.repeat(201)}`).status, 400);
  assert.equal(get('/snapshot?project=').status, 400);
  assert.equal(app.fetch(new Request('http://localhost:4111/control-center/v1/snapshot?project=proj', { method: 'POST' })).status, 405);
});

test('collaboration attribution comes only from validated batch/task references in the scheduler of record', t => {
  const directory = mkdtempSync(join(tmpdir(), 'control-center-scope-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'scheduler.db');
  const h = collabHarness({ path: dbPath });
  h.scheduler.createBatch(plan('/repo', [workerTask('alpha-task')], { batchId: 'A1', project: 'alpha' }));
  openMeeting(h.store, { threadId: 't-batch', sessionId: 's-batch', refs: { batchId: 'A1' } });
  openMeeting(h.store, { threadId: 't-task', sessionId: 's-task', refs: { taskId: 'alpha-task' } });
  openMeeting(h.store, { threadId: 't-label', sessionId: 's-label', refs: { objectiveId: 'ALPHA-OBJECTIVE' } });
  openMeeting(h.store, { threadId: 't-none', sessionId: 's-none' });
  h.scheduler.close();
  const view = createCollaborationReader({ dbPath, schedulerOfRecord: true }).snapshot();
  const by = (id: string) => view.threads.find(x => x.id === id)!.attribution;
  assert.deepEqual(by('t-batch'), { status: 'ATTRIBUTED', batchId: 'A1', project: 'alpha', reason: null });
  assert.deepEqual(by('t-task'), { status: 'ATTRIBUTED', batchId: 'A1', project: 'alpha', reason: null });
  assert.equal(by('t-label').status, 'UNATTRIBUTED', 'a free-form objective label is never joined to a batch or project');
  assert.match(by('t-label').reason!, /unverified objective label \(ALPHA-OBJECTIVE\)/);
  assert.equal(by('t-none').status, 'UNATTRIBUTED');
  // Meetings inherit their thread's attribution.
  assert.equal(view.meetings.find(m => m.threadId === 't-task')!.attribution?.project, 'alpha');
  assert.equal(view.meetings.find(m => m.threadId === 't-none')!.attribution?.status, 'UNATTRIBUTED');
  // Any other store (e.g. the council's own database) never resolves references here, even valid-looking ones.
  const elsewhere = createCollaborationReader({ dbPath }).snapshot();
  assert.ok(elsewhere.threads.every(x => x.attribution.status === 'UNATTRIBUTED' && /not the scheduler of record/.test(x.attribution.reason!)));
  assert.ok(elsewhere.meetings.every(m => m.attribution?.status === 'UNATTRIBUTED'));
});

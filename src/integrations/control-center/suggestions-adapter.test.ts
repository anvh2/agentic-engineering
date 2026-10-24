import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { makeRepo, plan, tempDir, workerTask } from '../../runtime/scheduler/test-helpers.ts';
import { decideSuggestion, suggestForDeadTasks } from '../../lead/collaboration/suggestions.ts';
import { createCollaborationReader } from './collaboration-adapter.ts';
import { createControlCenterApp } from './http-app.ts';
import { createSuggestionReader } from './suggestions-adapter.ts';
import { fixture } from './__testing__/fixture.ts';

function storeWithSuggestions() {
  const dbPath = join(tempDir('suggestion-view-'), 'scheduler.db');
  const store = new SchedulerStore(dbPath);
  store.createBatch(plan(makeRepo(), [workerTask('b1.t1'), workerTask('b1.t2')], { batchId: 'b1', project: 'quota' }));
  for (const [id, category] of [['b1.t1', 'coding_attempts_exhausted'], ['b1.t2', 'integration_conflict']]) store.db.prepare("UPDATE tasks SET state = 'ESCALATED', failure_category = ?, state_reason = 'runtime evidence' WHERE id = ?").run(category, id);
  const out = suggestForDeadTasks(store, { objectiveId: 'b1', batchId: 'b1', tasks: [store.requireTask('b1.t1'), store.requireTask('b1.t2')], actor: 'lifecycle-driver' });
  decideSuggestion(store, out.created[1].id, { status: 'dismissed', by: 'anvh2', reason: 'merge resolved by hand' });
  store.close();
  return dbPath;
}

test('suggestions are read-only, attributed through their verified batch, and never counted as meetings', () => {
  const dbPath = storeWithSuggestions();
  const before = statSync(dbPath).mtimeMs;
  const view = createSuggestionReader({ dbPath }).snapshot();
  assert.equal(view.availability, 'AVAILABLE');
  assert.equal(view.pending, 1);
  assert.ok(view.suggestions.every((s) => s.kind === 'suggestion'));
  const pending = view.suggestions.find((s) => s.status === 'pending')!;
  assert.deepEqual(pending.attribution, { status: 'ATTRIBUTED', batchId: 'b1', project: 'quota', reason: null });
  assert.equal(pending.sessionId, null, 'nothing was opened');
  assert.equal(view.suggestions.find((s) => s.status === 'dismissed')?.decisionReason, 'merge resolved by hand');
  assert.equal(statSync(dbPath).mtimeMs, before, 'reading wrote nothing');
  const collaboration = createCollaborationReader({ dbPath, schedulerOfRecord: true }).snapshot();
  assert.equal(collaboration.meetings.length, 0, 'a suggestion is not a meeting');
  assert.equal(collaboration.threads.length, 0);
});

test('a database without suggestions says so; the endpoint serves the same payload', async (t) => {
  const empty = join(tempDir('suggestion-empty-'), 'scheduler.db');
  new SchedulerStore(empty).close();
  assert.deepEqual(createSuggestionReader({ dbPath: empty }).snapshot(), { availability: 'AVAILABLE', reason: 'No meeting has been suggested in this scheduler database.', pending: 0, suggestions: [] });

  const f = fixture();
  t.after(() => f.close());
  const dbPath = storeWithSuggestions();
  const app = createControlCenterApp({ reader: f.reader, assetsDir: f.directory, embedded: true, suggestions: createSuggestionReader({ dbPath }) });
  const response = await app.fetch(new Request('http://127.0.0.1/control-center/v1/meeting-suggestions'));
  assert.equal(response.status, 200);
  const body = await response.json() as { pending: number; suggestions: { kind: string }[] };
  assert.equal(body.pending, 1);
  assert.deepEqual(body.suggestions.map((s) => s.kind), ['suggestion', 'suggestion']);
  const none = createControlCenterApp({ reader: f.reader, assetsDir: f.directory, embedded: true });
  assert.equal((await (await none.fetch(new Request('http://127.0.0.1/control-center/v1/meeting-suggestions'))).json() as { availability: string }).availability, 'NOT_AVAILABLE');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { makeRepo, plan, tempDir, workerTask } from '../../runtime/scheduler/test-helpers.ts';
import { pinObjective } from '../../lead/collaboration/__testing__/pin.ts';
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
  pinObjective(store, 'b1', 'b1', 'ESCALATED');
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
  assert.equal(pending.objectiveId, 'b1', 'its pinned lifecycle confirms the objective runs as this batch');
  assert.equal(statSync(dbPath).mtimeMs, before, 'reading wrote nothing');
  const collaboration = createCollaborationReader({ dbPath, schedulerOfRecord: true }).snapshot();
  assert.equal(collaboration.meetings.length, 0, 'a suggestion is not a meeting');
  assert.equal(collaboration.threads.length, 0);
});

test('without its integrity guards the table is reported CORRUPT, never shown as fixed records', () => {
  const dbPath = storeWithSuggestions();
  const store = new SchedulerStore(dbPath);
  store.db.exec('DROP TRIGGER meeting_suggestions_fixed');
  store.close();
  const view = createSuggestionReader({ dbPath }).snapshot();
  assert.equal(view.availability, 'CORRUPT');
  assert.deepEqual(view.suggestions, []);
});

test('the integrity check and the rows come from ONE read transaction: a change in between is seen by the next snapshot, never half of this one', () => {
  const dbPath = storeWithSuggestions();
  const writer = new SchedulerStore(dbPath);
  const [pending] = writer.db.prepare("SELECT id FROM meeting_suggestions WHERE status = 'pending'").all() as { id: string }[];
  let fired = 0;
  const view = createSuggestionReader({
    dbPath,
    afterIntegrityCheck: () => {
      fired += 1;
      // a person accepts the suggestion AND a guard disappears, between the integrity check and the row reads
      decideSuggestion(writer, pending.id, { status: 'accepted', by: 'claude-engineering-lead', sessionId: 's1' });
      writer.db.exec('DROP TRIGGER meeting_suggestions_no_delete');
    },
  }).snapshot();
  assert.equal(fired, 1);
  assert.equal(view.availability, 'AVAILABLE', 'the guards were present in the snapshot these rows were read from');
  const ids = view.suggestions.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'no suggestion is listed twice');
  assert.deepEqual([view.pending, view.suggestions.filter((s) => s.status === 'pending').length], [1, 1], 'the count agrees with the rows');
  assert.equal(view.suggestions.find((s) => s.id === pending.id)?.status, 'pending', 'the whole snapshot predates the acceptance');
  const next = createSuggestionReader({ dbPath }).snapshot();
  assert.equal(next.availability, 'CORRUPT', 'the next snapshot sees the missing guard');
  assert.deepEqual(next.suggestions, []);
  writer.close();
});

test('an objective reference with no pinned lifecycle for the batch is never shown, even if a row says so', () => {
  const dbPath = storeWithSuggestions();
  const store = new SchedulerStore(dbPath);
  store.db.prepare("INSERT INTO meeting_suggestions (id, dedupe_key, status, meeting_type, category, project, objective_id, batch_id, task_id, reason, evidence, participants, created_at, created_by) SELECT 'sg-raw', 'raw', 'pending', meeting_type, category, project, 'ghost-objective', batch_id, task_id, reason, evidence, participants, created_at + 1, 'raw' FROM meeting_suggestions LIMIT 1").run();
  store.close();
  const view = createSuggestionReader({ dbPath }).snapshot();
  assert.equal(view.suggestions.find((s) => s.id === 'sg-raw')?.objectiveId, null);
});

test('a table without its CHECK constraint is reported CORRUPT', () => {
  const dbPath = storeWithSuggestions();
  const store = new SchedulerStore(dbPath);
  store.db.exec(`DROP TABLE meeting_suggestions; CREATE TABLE meeting_suggestions (id TEXT);
    CREATE TRIGGER meeting_suggestions_insert_new BEFORE INSERT ON meeting_suggestions BEGIN SELECT 1; END;
    CREATE TRIGGER meeting_suggestions_no_delete BEFORE DELETE ON meeting_suggestions BEGIN SELECT 1; END;
    CREATE TRIGGER meeting_suggestions_fixed BEFORE UPDATE ON meeting_suggestions BEGIN SELECT 1; END;`);
  store.close();
  assert.equal(createSuggestionReader({ dbPath }).snapshot().availability, 'CORRUPT');
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

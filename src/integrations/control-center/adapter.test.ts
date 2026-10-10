import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createReader } from './adapter.ts';
import { TASK_STATES as WIRE_STATES, snapshotSchema, unknownUsage } from './contract.ts';
import { TASK_STATES } from '../../runtime/scheduler/types.ts';
import { fixture } from './__testing__/fixture.ts';

test('wire states match scheduler truth; all telemetry starts unknown', () => {
  assert.deepEqual(WIRE_STATES, TASK_STATES);
  assert.equal(unknownUsage().inputTokens, null);
});
test('missing database remains missing and never implies idle or online', (t) => {
  const f = fixture();
  t.after(f.close);
  const path = join(f.directory, 'missing.db');
  const snapshot = createReader({ dbPath: path }).snapshot();
  assert.equal(snapshot.source, 'disconnected');
  assert.equal(existsSync(path), false);
  assert.ok(snapshot.agents.every((a) => a.activity === 'UNKNOWN' && a.configured === null && a.availability === 'UNKNOWN'));
  assert.equal(snapshotSchema.safeParse(snapshot).success, true);
});
test('snapshots are objective-scoped, consistent, read-only and omit private payloads', (t) => {
  const f = fixture();
  t.after(f.close);
  f.store.setArtifacts('task-a', { secret: 'secret-payload', studioUrl: 'javascript:alert(1)' });
  f.store.audit('task-a', 'private-actor', 'private-reason', { reasoning: 'hidden-model-thinking' });
  const before = f.store.db.prepare('SELECT * FROM tasks').all();
  const events = f.store.events();
  const noScope = f.reader.snapshot();
  assert.equal(noScope.tasks.length, 0);
  assert.equal(noScope.usage.inputTokens, null);
  const snapshot = f.reader.snapshot('B1');
  assert.equal(snapshot.source, 'connected');
  assert.equal(snapshot.tasks.length, 2);
  assert.deepEqual(snapshot.tasks[1]!.dependsOn, ['task-a']);
  assert.ok(snapshot.events.every((e) => e.taskId !== 'old-smoke'));
  const serialized = JSON.stringify(snapshot);
  for (const secret of [
    'secret-payload',
    'hidden-model-thinking',
    'private-reason',
    'private-actor',
    'javascript:',
    'hiddenFiles',
    'verificationCommands',
  ])
    assert.ok(!serialized.includes(secret), secret);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM tasks').all(), before);
  assert.deepEqual(f.store.events(), events);
  assert.equal(f.reader.snapshot('missing').tasks.length, 0);
});
test('live claims do not invent inference; expired runs and cancelled tasks never appear running', (t) => {
  const f = fixture();
  t.after(f.close);
  const claim = f.claim();
  f.store.recordRun('task-a', claim.fence, 'run-a');
  f.store.transition('task-a', 'CODING', { actor: 'worker-1', fence: claim.fence });
  let snapshot = f.reader.snapshot('B1');
  assert.equal(snapshot.tasks[0]!.activity, 'UNKNOWN');
  assert.match(snapshot.tasks[0]!.traceUrl!, /\/workflows\/coding-task-workflow\/graph\/run-a$/);
  assert.equal(snapshot.agents.find((a) => a.id === 'ollama')!.assignmentIds[0], 'task-a');
  f.advance(1001);
  snapshot = f.reader.snapshot('B1');
  assert.equal(snapshot.tasks[0]!.stale, true);
  assert.equal(snapshot.tasks[0]!.activeSince, null);
  assert.equal(snapshot.agents.find((a) => a.id === 'ollama')!.activity, 'UNKNOWN');
  f.store.transition('task-a', 'CANCELLED', { actor: 'human' });
  snapshot = f.reader.snapshot('B1');
  assert.equal(snapshot.tasks[0]!.activity, 'UNKNOWN');
  assert.equal(snapshot.agents.find((a) => a.id === 'ollama')!.lastOutcome, 'CANCELLED');
  assert.equal(snapshot.events.at(-1)!.type, 'task.cancelled');
  assert.equal(snapshot.tasks[0]!.usage.inputTokens, null);
});
test('verification reflects live scheduler evidence while history remains distinct', (t) => {
  const f = fixture();
  t.after(f.close);
  const claim = f.claim();
  f.store.transition('task-a', 'CODING', { actor: 'worker-1', fence: claim.fence });
  f.store.transition('task-a', 'VERIFYING', { actor: 'worker-1', fence: claim.fence });
  assert.equal(f.reader.snapshot('B1').agents.find((a) => a.id === 'ollama')!.activity, 'VERIFYING');
  f.store.transition('task-a', 'REVIEW_PENDING', { actor: 'worker-1', fence: claim.fence, review: { private: 'review-content' } });
  const snapshot = f.reader.snapshot('B1');
  assert.equal(snapshot.reviews.length, 1);
  assert.equal(snapshot.agents.find((a) => a.id === 'ollama')!.activity, 'UNKNOWN');
  assert.equal(snapshot.agents.find((a) => a.id === 'ollama')!.lastOutcome, 'REVIEW_PENDING');
  assert.equal(snapshot.agents.find((a) => a.id === 'ollama')!.historicallyVerified, true);
  assert.ok(!JSON.stringify(snapshot).includes('review-content'));
});
test('concurrent WAL writer cannot expose a task update without its committed event', (t) => {
  const f = fixture();
  t.after(f.close);
  const writer = new DatabaseSync(f.dbPath);
  t.after(() => writer.close());
  writer.exec('BEGIN IMMEDIATE');
  writer.prepare("UPDATE tasks SET state='CANCELLED' WHERE id='task-a'").run();
  writer
    .prepare("INSERT INTO events(task_id,at,from_state,to_state,actor) VALUES('task-a',1700000000001,'BACKLOG','CANCELLED','test')")
    .run();
  const during = f.reader.snapshot('B1');
  assert.equal(during.tasks[0]!.state, 'BACKLOG');
  assert.equal(
    during.events.some((e) => e.type === 'task.cancelled'),
    false,
  );
  writer.exec('COMMIT');
  const after = f.reader.snapshot('B1');
  assert.equal(after.tasks[0]!.state, 'CANCELLED');
  assert.equal(after.events.at(-1)!.type, 'task.cancelled');
});
test('event replay is ordered, scope-filtered, bounded and resets invalid cursors', (t) => {
  const f = fixture();
  t.after(f.close);
  const cursor = f.reader.snapshot('B1').cursor!;
  f.store.promote();
  const replay = f.reader.eventsAfter('B1', cursor);
  assert.equal(replay.reset, false);
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0]!.type, 'task.queued');
  assert.equal(f.reader.eventsAfter('B1', replay.cursor).events.length, 0);
  assert.equal(f.reader.eventsAfter('B1', 'old:999999').reset, true);
  for (let i = 0; i < 201; i++) f.store.audit('task-a', 'test', 'test audit');
  assert.equal(f.reader.eventsAfter('B1', cursor).reset, true);
  assert.equal(f.reader.snapshot('B1').events.length, 200);
});
test('malformed stored data fails closed and missing provider capacity stays unknown', (t) => {
  const f = fixture();
  t.after(f.close);
  const reader = createReader({ dbPath: f.dbPath, capacityDbPath: join(f.directory, 'missing-capacity.db') });
  assert.ok(reader.snapshot('B1').providers.every((p) => p.permits === null && p.quota === null));
  f.store.db.prepare("UPDATE tasks SET run_ids='broken json' WHERE id='task-a'").run();
  assert.equal(reader.snapshot('B1').source, 'disconnected');
});

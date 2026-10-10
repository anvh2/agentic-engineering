import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { collabHarness, designMeeting, openMeeting } from '../../runtime/collaboration/__testing__/harness.ts';
import { createCollaborationReader } from './collaboration-adapter.ts';
import { createControlCenterApp } from './http-app.ts';
import { fixture } from './__testing__/fixture.ts';

/** Core B's reference design meeting, run by its own coordinator with deterministic fake participants, persisted to disk. */
async function persistedMeeting(t: { after(fn: () => void): void }, options: { withUsage?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'control-center-collab-'));
  const dbPath = join(directory, 'scheduler.db');
  const h = collabHarness({ path: dbPath });
  const { sessionId, threadId } = openMeeting(h.store);
  const result = await h.coordinator.run(sessionId, { owner: 'coord', participants: designMeeting({ withUsage: options.withUsage ?? true }).participants });
  assert.equal(result.status, 'concluded');
  const record = h.store.record(sessionId)!;
  h.scheduler.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { dbPath, sessionId, threadId, record, reader: createCollaborationReader({ dbPath }) };
}

test('persisted Core B meeting is shown as recorded: messages, objection, contested decision, actions, provenance', async t => {
  const m = await persistedMeeting(t);
  const view = m.reader.snapshot();
  assert.equal(view.availability, 'AVAILABLE');
  assert.equal(view.source, 'core');
  assert.equal(view.threads.length, 1);
  const thread = view.threads[0];
  assert.equal(thread.id, m.threadId);
  assert.equal(thread.synthetic, true, 'fake-provider identities are labelled, never presented as live');
  assert.deepEqual(thread.messages.map(x => x.type), ['COMMENT', 'PROPOSAL', 'OBJECTION', 'QUESTION', 'ANSWER', 'CORRECTION', 'PASS', 'SUPPORT', 'DECISION']);
  assert.deepEqual(thread.messages.map(x => x.seq), [...thread.messages.map(x => x.seq)].sort((a, b) => a - b));
  const objection = thread.messages.find(x => x.type === 'OBJECTION')!;
  assert.equal(objection.objectionState, 'OPEN');
  const proposal = thread.messages.find(x => x.type === 'PROPOSAL')!;
  assert.deepEqual(proposal.correctedBy, [thread.messages.find(x => x.type === 'CORRECTION')!.id]);
  assert.equal(proposal.references[0].url, null, 'evidence stays an opaque reference');
  // The record covers events through the decision; the terminal event that stores the record is the head.
  assert.equal(view.cursor, m.reader.cursor());
  assert.ok(view.cursor! > m.record.provenance.throughSeq);

  assert.equal(view.meetings.length, 1);
  const meeting = view.meetings[0];
  assert.equal(meeting.id, m.sessionId);
  assert.equal(meeting.status, 'CONCLUDED');
  assert.equal(meeting.outcome, 'decided');
  assert.equal(meeting.budgetExhausted, false);
  assert.match(meeting.decisions[0].text, /^ACCEPT .* CONTESTED, overrules .* grants no authority$/);
  assert.deepEqual(meeting.objections.map(o => o.status), ['OUTSTANDING']);
  assert.ok(meeting.disagreements.some(d => d.text.startsWith('objection ')), 'an overruled objection stays unresolved');
  assert.deepEqual(meeting.actions.map(a => a.ownerId), ['worker-codex', 'reviewer']);
  assert.ok(meeting.actions.every(a => a.state === null), 'follow-up state is not recorded by Core B, so it is UNKNOWN');
  assert.ok(meeting.agreements.every(a => a.text.endsWith('not unanimous')));
  assert.deepEqual(meeting.provenance, { throughSeq: m.record.provenance.throughSeq, throughHash: m.record.provenance.throughHash, recordHash: m.record.recordHash, messageCount: 9 });
  assert.deepEqual(meeting.rounds.map(r => [r.number, r.messageIds.length]), [[1, 4], [2, 4], [3, 1]]);
  assert.deepEqual(meeting.usage, { inputTokens: 2240, outputTokens: 455, source: 'collab_events invocation references', completeness: 'complete' });
  assert.equal(meeting.tokensUsed, 2695);
});

test('unreported usage stays UNKNOWN (null), never zero', async t => {
  const m = await persistedMeeting(t, { withUsage: false });
  const meeting = m.reader.snapshot().meetings[0];
  assert.equal(meeting.usage.inputTokens, null);
  assert.equal(meeting.usage.outputTokens, null);
  assert.equal(meeting.usage.completeness, 'unavailable');
  assert.equal(meeting.tokensUsed, null);
});

test('thread, session and feed reads; unknown ids are not found', async t => {
  const m = await persistedMeeting(t);
  assert.equal(m.reader.thread(m.threadId)!.threads[0].messages.length, 9);
  assert.equal(m.reader.thread('no-such-thread'), null);
  assert.equal(m.reader.session(m.sessionId)!.meetings[0].provenance!.recordHash, m.record.recordHash);
  assert.equal(m.reader.session('no-such-session'), null);
  const head = m.reader.cursor();
  const tail = m.reader.feed(head - 3);
  assert.deepEqual(tail.events.map(e => e.seq), [head - 2, head - 1, head]);
  assert.equal(tail.cursor, head);
  assert.ok(tail.events.every(e => Object.keys(e).sort().join() === 'at,seq,threadId,type'), 'feed frames carry no message bodies');
  assert.deepEqual(m.reader.feed(head).events, []);
});

test('tampering is CORRUPT with no records; missing table is empty; missing database is not available', async t => {
  const m = await persistedMeeting(t);
  const db = new DatabaseSync(m.dbPath);
  const guard = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'collab_events_no_update'").get() as { sql: string }).sql;
  db.exec('DROP TRIGGER collab_events_no_update');
  // A rewritten message with the guard restored: only Core B's hash chain can catch it.
  db.prepare("UPDATE collab_events SET payload = replace(payload, 'My objection stands.', 'I withdraw nothing.') WHERE payload LIKE '%My objection stands.%'").run();
  db.exec(guard);
  const corrupt = m.reader.snapshot();
  assert.equal(corrupt.availability, 'CORRUPT');
  assert.match(corrupt.reason!, /integrity verification/);
  assert.deepEqual([corrupt.threads, corrupt.meetings], [[], []]);
  assert.equal(m.reader.session(m.sessionId)!.availability, 'CORRUPT');
  // A removed append-only guard is itself a failed integrity check, never a silent read.
  db.exec('DROP TRIGGER collab_events_no_delete');
  db.close();
  assert.match(m.reader.snapshot().reason!, /guard missing: collab_events_no_delete/);

  const directory = mkdtempSync(join(tmpdir(), 'control-center-collab-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new SchedulerStore(join(directory, 'scheduler.db')).close();
  const empty = createCollaborationReader({ dbPath: join(directory, 'scheduler.db') });
  assert.deepEqual({ ...empty.snapshot(), reason: null }, { availability: 'AVAILABLE', source: 'core', reason: null, cursor: 0, threads: [], meetings: [] });
  assert.deepEqual(empty.feed(0), { events: [], cursor: 0, hasMore: false });
  assert.equal(createCollaborationReader({ dbPath: join(directory, 'absent.db') }).snapshot().availability, 'NOT_AVAILABLE');
});

test('Gateway: read-only collaboration endpoints and SSE replay by Last-Event-ID', async t => {
  const m = await persistedMeeting(t);
  const f = fixture(); t.after(() => f.close());
  const app = createControlCenterApp({ reader: f.reader, assetsDir: f.directory, embedded: true, collaboration: m.reader, pollMs: 50 });
  t.after(() => app.closeStreams());
  const get = (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost:4111/control-center/v1${path}`, init));
  assert.equal((await get('/collaboration').json()).threads[0].messages.length, 9);
  assert.equal(get(`/collaboration/threads/${m.threadId}`).status, 200);
  assert.equal(get('/collaboration/threads/unknown').status, 404);
  assert.equal(get('/collaboration/threads/bad%20id').status, 400);
  assert.equal(get('/collaboration/nope').status, 404);
  assert.equal((await get(`/collaboration/sessions/${m.sessionId}`).json()).meetings[0].provenance.recordHash, m.record.recordHash);
  assert.equal(get('/collaboration', { method: 'POST' }).status, 405);
  assert.equal(get('/collaboration', { headers: { origin: 'https://external.example' } }).status, 403);

  const head = m.reader.cursor();
  async function frames(headers: Record<string, string>, until: RegExp) {
    const abort = new AbortController();
    const reader = get('/collaboration/events', { headers, signal: abort.signal }).body!.getReader();
    let text = '';
    while (!until.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    abort.abort();
    return text;
  }
  const fresh = await frames({}, /event: checkpoint/);
  assert.match(fresh, new RegExp(`id: ${head}\nevent: checkpoint`));
  assert.doesNotMatch(fresh, /event: collab/, 'a fresh subscriber starts at the head; history comes from the snapshot');

  const resumed = await frames({ 'Last-Event-ID': String(head - 2) }, new RegExp(`id: ${head}\nevent: collab`));
  assert.deepEqual([...resumed.matchAll(/id: (\d+)\nevent: collab/g)].map(x => Number(x[1])), [head - 1, head], 'replays exactly the missed events, once');
  assert.doesNotMatch(resumed, /objection stands/, 'frames never carry message bodies');

  for (const bad of ['not-a-seq', String(head + 100)]) assert.match(await frames({ 'Last-Event-ID': bad }, /event: checkpoint/), /event: reset[\s\S]*event: checkpoint/);
});

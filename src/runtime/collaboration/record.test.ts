import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CoordinatorResult } from './coordinator.ts';
import { eventHash } from './events.ts';
import { recordIntact, type MeetingRecord } from './record.ts';
import { latest, ScriptedParticipant } from './__testing__/fake-agents.ts';
import { collabHarness, designMeeting, LEAD, openMeeting } from './__testing__/harness.ts';

const FIXTURE = fileURLToPath(new URL('./__testing__/meeting-record.fixture.json', import.meta.url));

async function referenceMeeting() {
  const h = collabHarness();
  const { sessionId } = openMeeting(h.store);
  const r = (await h.coordinator.run(sessionId, { owner: 'coord', participants: designMeeting().participants })) as Extract<CoordinatorResult, { status: 'concluded' }>;
  assert.equal(r.status, 'concluded');
  return { h, sessionId, record: r.record };
}

describe('M9 meeting record', () => {
  it('links every entry to the event and message it came from, and binds itself to the event chain', async () => {
    const { h, record } = await referenceMeeting();
    const events = h.store.events('t-design');
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    const sources = [
      ...record.alternatives.map((x) => x.source),
      ...record.objections.map((x) => x.source),
      ...record.questions.map((x) => x.source),
      ...record.agreements.flatMap((x) => x.sources),
      ...record.decisions.map((x) => x.source),
      ...record.actionItems.map((x) => x.source),
      ...record.unresolved.map((x) => x.source),
      ...record.corrections.map((x) => x.source),
    ];
    assert.equal(sources.length, 9, 'proposal, objection, question, support, decision, 2 action items, unresolved objection, correction');
    for (const s of sources) {
      const e = bySeq.get(s.seq);
      assert.equal(e?.type, 'message.posted', `source seq ${s.seq}`);
      assert.equal((e!.payload as { message: { id: string } }).message.id, s.messageId);
    }
    for (const t of record.turns) assert.ok(bySeq.has(t.seq), `turn seq ${t.seq}`);
    // throughSeq/throughHash name the exact event the record was built on: the one just before the conclusion.
    const concludeIdx = events.findIndex((e) => e.type === 'session.concluded');
    assert.equal(record.provenance.throughSeq, events[concludeIdx - 1].seq);
    assert.equal(record.provenance.throughHash, events[concludeIdx - 1].hash);
    assert.equal(events[concludeIdx].hash, eventHash(events[concludeIdx].prevHash, events[concludeIdx]), 'the record is inside the hash chain');
    assert.ok(recordIntact(record));
    assert.equal(recordIntact({ ...record, decisions: record.decisions.map((d) => ({ ...d, contested: false })) }), false, 'an edited record no longer matches its hash');
  });

  it('does not invent consensus: overruled objections stay unresolved, agreement is only explicit support', async () => {
    const { record } = await referenceMeeting();
    assert.equal(record.outcome, 'decided');
    const [d] = record.decisions;
    assert.equal(d.outcome, 'accept');
    assert.equal(d.contested, true);
    assert.equal(d.authority, 'none');
    assert.deepEqual(d.overruledObjections, record.objections.map((o) => o.id));
    assert.deepEqual(record.objections.map((o) => [o.author, o.status]), [['worker-codex', 'outstanding']]);
    assert.deepEqual(record.unresolved.map((u) => u.kind), ['objection']);
    assert.deepEqual(record.agreements.map((a) => [a.supporters, a.unanimous]), [[['reviewer'], false]], 'the lead decided; it did not support, and codex did not agree');
    assert.deepEqual(record.questions.map((q) => q.status), ['answered']);
    assert.deepEqual(record.actionItems.map((a) => a.owner), ['worker-codex', 'reviewer']);
    assert.equal(record.alternatives[0].status, 'accepted');
    assert.equal(record.alternatives[0].correctedBy.length, 1);
    assert.equal(record.corrections.length, 1);
  });

  it('records an unresolved disagreement as unresolved, with no decision and no agreement', async () => {
    const h = collabHarness();
    const { sessionId } = openMeeting(h.store, { limits: { maxRounds: 2, maxInvocations: 20 } });
    const ps = [
      new ScriptedParticipant(LEAD, [{ kind: 'comment', body: 'Two options on the table.' }, { kind: 'comment', body: 'No decision today.' }]),
      new ScriptedParticipant('architect', [{ kind: 'proposal', body: 'Option A: limit in the spec.' }, (ctx) => ({ kind: 'objection', parentId: latest(ctx, 'proposal', 'worker-codex').id, body: 'B hides the limit.' })]),
      new ScriptedParticipant('worker-codex', [{ kind: 'proposal', body: 'Option B: limit in config.' }, (ctx) => ({ kind: 'objection', parentId: latest(ctx, 'proposal', 'architect').id, body: 'A couples planning to review.' })]),
      new ScriptedParticipant('reviewer', [{ kind: 'question', body: 'Which one is cheaper to test?' }, { kind: 'pass', body: '-' }]),
    ];
    const r = (await h.coordinator.run(sessionId, { owner: 'c', participants: ps })) as Extract<CoordinatorResult, { status: 'concluded' }>;
    assert.equal(r.outcome, 'unresolved');
    const rec = r.record;
    assert.deepEqual(rec.decisions, []);
    assert.deepEqual(rec.agreements, []);
    assert.deepEqual(rec.actionItems, []);
    assert.deepEqual(rec.alternatives.map((a) => [a.author, a.status, a.outstandingObjections.length]), [['architect', 'open', 1], ['worker-codex', 'open', 1]]);
    assert.deepEqual(rec.unresolved.map((u) => u.kind).sort(), ['objection', 'objection', 'proposal', 'proposal', 'question']);
  });

  it('is deterministic: the same meeting yields the same record, byte for byte (golden fixture)', async () => {
    const a = (await referenceMeeting()).record;
    const b = (await referenceMeeting()).record;
    assert.deepEqual(a, b);
    assert.equal(a.recordHash, b.recordHash);
    if (process.env.AGENTIC_UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, `${JSON.stringify(a, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as MeetingRecord;
    assert.deepEqual(a, golden, 'meeting record format changed: review the diff, then AGENTIC_UPDATE_FIXTURES=1');
    assert.ok(recordIntact(golden));
  });
});

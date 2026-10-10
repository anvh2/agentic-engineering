import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { plan, tempDir, workerTask } from '../scheduler/test-helpers.ts';
import { replay } from './replay.ts';
import { CollaborationError, COLLABORATION_CEILINGS } from './types.ts';
import { collabHarness, designMeeting, LEAD, openMeeting } from './__testing__/harness.ts';

const code = (c: CollaborationError['code']) => (e: unknown) => e instanceof CollaborationError && e.code === c;

function thread(h: ReturnType<typeof collabHarness>, participants = [LEAD, 'architect', 'worker-codex']) {
  h.store.openThread({ threadId: 't1', title: 'Review gate evidence', participants, actorId: LEAD });
}

describe('M9 collaboration store: persistence, ordering, replay', () => {
  it('persists a thread and replays it identically from a reopened database', async () => {
    const dbPath = join(tempDir('collab-'), 'scheduler.db');
    const h1 = collabHarness({ path: dbPath });
    const { sessionId } = openMeeting(h1.store);
    const result = await h1.coordinator.run(sessionId, { owner: 'coord-1', participants: designMeeting().participants });
    assert.equal(result.status, 'concluded');
    const before = h1.store.thread('t-design');
    const eventsBefore = h1.store.events('t-design');
    h1.scheduler.close();

    const h2 = collabHarness({ path: dbPath });
    const after = h2.store.thread('t-design');
    assert.deepEqual(h2.store.events('t-design'), eventsBefore, 'events read back byte-identical');
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.sessions.get(sessionId), before.sessions.get(sessionId));
    assert.equal(after.lastHash, before.lastHash);
    assert.deepEqual(h2.store.record(sessionId), (result as { record: unknown }).record, 'the stored meeting record survives the reopen');
    // replaying any prefix is deterministic and never throws
    for (let i = 1; i <= eventsBefore.length; i++) assert.deepEqual(replay(eventsBefore.slice(0, i)).lastSeq, eventsBefore[i - 1].seq);
  });

  it('orders events by one global sequence and chains them per thread', () => {
    const h = collabHarness();
    thread(h);
    h.store.openThread({ threadId: 't2', title: 'Other', participants: [LEAD, 'architect'], actorId: LEAD });
    h.store.post({ threadId: 't1', authorId: 'architect', kind: 'proposal', body: 'A', idempotencyKey: 'k1' });
    h.store.post({ threadId: 't2', authorId: LEAD, kind: 'comment', body: 'B', idempotencyKey: 'k2' });
    h.store.post({ threadId: 't1', authorId: 'worker-codex', kind: 'comment', body: 'C', idempotencyKey: 'k3' });
    const all = h.store.eventsSince(0);
    assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4, 5]);
    const t1 = h.store.events('t1');
    assert.deepEqual(t1.map((e) => e.seq), [1, 3, 5]);
    assert.ok(t1.every((e, i) => i === 0 || e.prevHash === t1[i - 1].hash), 'each event chains to the previous one of its thread');
    assert.deepEqual(h.store.thread('t1').messages.map((m) => [m.id, m.body]), [['m1', 'A'], ['m2', 'C']]);
  });

  it('is append-only: SQL updates and deletes are refused, and an out-of-band rewrite is detected on replay', () => {
    const h = collabHarness();
    thread(h);
    h.store.post({ threadId: 't1', authorId: 'architect', kind: 'proposal', body: 'original', idempotencyKey: 'k1' });
    assert.throws(() => h.scheduler.db.prepare("UPDATE collab_events SET payload = '{}' WHERE seq = 2").run(), /append-only/);
    assert.throws(() => h.scheduler.db.prepare('DELETE FROM collab_events WHERE seq = 2').run(), /append-only/);
    // Someone with raw database access drops the guard and rewrites a contribution: the thread fails closed.
    h.scheduler.db.exec('DROP TRIGGER collab_events_no_update');
    h.scheduler.db.prepare("UPDATE collab_events SET payload = replace(payload, 'original', 'rewritten') WHERE seq = 2").run();
    assert.throws(() => h.store.thread('t1'), code('corrupt'));
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'comment', body: 'x', idempotencyKey: 'k2' }), code('corrupt'), 'no write on top of a broken chain');
  });

  it('is idempotent per key: a retry returns the same message, a different request under the same key is refused', () => {
    const h = collabHarness();
    thread(h);
    const a = h.store.post({ threadId: 't1', authorId: 'architect', kind: 'proposal', body: 'P', idempotencyKey: 'retry-1' });
    const b = h.store.post({ threadId: 't1', authorId: 'architect', kind: 'proposal', body: 'P', idempotencyKey: 'retry-1' });
    assert.deepEqual(a, b);
    assert.equal(h.store.events('t1').length, 2, 'one thread.opened + one message, no duplicate');
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'proposal', body: 'P2', idempotencyKey: 'retry-1' }), code('idempotency_conflict'));
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'comment', body: 'no key' }), code('invalid'));
    assert.throws(() => h.store.openThread({ threadId: 't1', title: 'again', participants: [LEAD], actorId: LEAD, idempotencyKey: 'other' }), code('duplicate'));
  });
});

describe('M9 collaboration store: identity and authority', () => {
  it('attributes messages only to configured identities that take part in the thread, with the configured role', () => {
    const h = collabHarness();
    thread(h);
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'mallory', kind: 'comment', body: 'hi', idempotencyKey: 'a' }), code('unauthorized'));
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'reviewer', kind: 'comment', body: 'hi', idempotencyKey: 'b' }), code('unauthorized'), 'configured, but not a participant');
    const m = h.store.post({ threadId: 't1', authorId: 'worker-codex', kind: 'comment', body: 'hi', idempotencyKey: 'c' });
    assert.deepEqual([m.author.id, m.author.role, m.author.kind], ['worker-codex', 'implementer', 'worker']);
    // There is no input through which a caller can state a role: unknown fields never reach the stored author.
    const forged = h.store.post({ threadId: 't1', authorId: 'worker-codex', kind: 'comment', body: 'as operator', idempotencyKey: 'd', ...({ role: 'operator', author: { role: 'operator' } } as object) });
    assert.equal(forged.author.role, 'implementer');
    assert.throws(() => h.store.openThread({ threadId: 't9', title: 'x', participants: ['ghost'], actorId: LEAD }), code('unauthorized'));
  });

  it('records decisions and passes only as meeting turns, and decisions only from the chair', () => {
    const h = collabHarness();
    thread(h);
    const p = h.store.post({ threadId: 't1', authorId: 'architect', kind: 'proposal', body: 'P', idempotencyKey: 'p' });
    const decision = { outcome: 'accept', proposalIds: [p.id], rationale: 'r' };
    assert.throws(() => h.store.post({ threadId: 't1', authorId: LEAD, kind: 'decision', body: 'd', decision, idempotencyKey: 'd' }), code('unauthorized'));
    assert.throws(() => h.store.post({ threadId: 't1', authorId: LEAD, kind: 'pass', body: 'p', idempotencyKey: 'e' }), code('unauthorized'));
    assert.throws(() => h.store.post({ threadId: 't1', authorId: LEAD, kind: 'comment', body: 'c', decision, idempotencyKey: 'f' }), code('invalid'), 'a non-decision carries no decision payload');
  });

  it('only a lead or operator opens or cancels a session; a worker cannot', () => {
    const h = collabHarness();
    h.store.openThread({ threadId: 't1', title: 'x', participants: [LEAD, 'architect', 'worker-codex'], actorId: LEAD });
    const base = { threadId: 't1', agenda: ['a'], participants: [LEAD, 'architect'], chair: LEAD, limits: { maxRounds: 1, maxInvocations: 2 } };
    assert.throws(() => h.store.openSession({ ...base, sessionId: 's0', actorId: 'architect' }), code('unauthorized'));
    assert.throws(() => h.store.openSession({ ...base, sessionId: 's0', actorId: LEAD, limits: { maxRounds: 99, maxInvocations: 2 } }), code('invalid'), 'above the ceiling');
    assert.throws(() => h.store.openSession({ ...base, sessionId: 's0', actorId: LEAD, limits: { maxRounds: 1, maxInvocations: 1 } }), code('invalid'), 'budget below one round');
    assert.throws(() => h.store.openSession({ ...base, sessionId: 's0', actorId: LEAD, participants: [LEAD, 'reviewer'] }), code('unauthorized'), 'not a thread participant');
    h.store.openSession({ ...base, sessionId: 's1', actorId: LEAD });
    assert.throws(() => h.store.cancelSession('s1', { actorId: 'architect' }, 'I disagree'), code('unauthorized'));
    assert.equal(h.store.cancelSession('s1', { actorId: 'operator' }, 'operator stop').outcome, 'cancelled');
  });

  it('writes nothing outside its own table: a decided meeting changes no task, review, scheduler event or authorization', async () => {
    const h = collabHarness();
    const batch = h.scheduler.createBatch(plan('/repo', [workerTask('cap-1')]));
    const snapshot = () => ({
      tasks: h.scheduler.listTasks().map((t) => [t.id, t.state, t.claimEpoch, JSON.stringify(t.spec)]),
      events: h.scheduler.db.prepare('SELECT COUNT(*) AS n FROM events').get(),
      reviews: h.scheduler.db.prepare('SELECT COUNT(*) AS n FROM reviews').get(),
      tables: h.scheduler.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
    });
    const before = snapshot();
    const { sessionId } = openMeeting(h.store, { refs: { batchId: batch.batchId, taskId: 'cap-1' } });
    const r = await h.coordinator.run(sessionId, { owner: 'c', participants: designMeeting().participants });
    assert.equal(r.status === 'concluded' && r.outcome, 'decided');
    assert.deepEqual(snapshot(), before);
    assert.ok(r.status === 'concluded' && r.record.decisions.every((d) => d.authority === 'none'));
  });
});

describe('M9 collaboration store: content rules', () => {
  it('appends corrections and withdrawals; the original contribution is never rewritten', () => {
    const h = collabHarness();
    thread(h);
    const p = h.store.post({ threadId: 't1', authorId: 'architect', kind: 'proposal', body: 'v1', idempotencyKey: 'p' });
    const o = h.store.post({ threadId: 't1', authorId: 'worker-codex', kind: 'objection', parentId: p.id, body: 'no', idempotencyKey: 'o' });
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'worker-codex', kind: 'correction', parentId: p.id, body: 'v2', idempotencyKey: 'c0' }), code('unauthorized'), 'only the author corrects');
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'withdrawal', parentId: o.id, body: 'w', idempotencyKey: 'w0' }), code('unauthorized'), 'only the author withdraws');
    const c = h.store.post({ threadId: 't1', authorId: 'architect', kind: 'correction', parentId: p.id, body: 'v2', idempotencyKey: 'c1' });
    const w = h.store.post({ threadId: 't1', authorId: 'worker-codex', kind: 'withdrawal', parentId: o.id, body: 'fine', idempotencyKey: 'w1' });
    const s = h.store.thread('t1');
    assert.equal(s.byId.get(p.id)!.body, 'v1');
    assert.deepEqual(s.byId.get(p.id)!.correctedBy, [c.id]);
    assert.equal(s.byId.get(o.id)!.withdrawnBy, w.id);
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'worker-codex', kind: 'withdrawal', parentId: o.id, body: 'again', idempotencyKey: 'w2' }), code('invalid'));
  });

  it('enforces reply structure, evidence and references, and refuses (never truncates) oversize content', () => {
    const h = collabHarness();
    h.scheduler.createBatch(plan('/repo', [workerTask('real-task')]));
    thread(h);
    const q = h.store.post({ threadId: 't1', authorId: LEAD, kind: 'question', body: 'why?', idempotencyKey: 'q' });
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'objection', parentId: q.id, body: 'x', idempotencyKey: 'a' }), code('invalid'), 'objections target proposals');
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'answer', body: 'x', idempotencyKey: 'b' }), code('invalid'), 'an answer needs its question');
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'comment', body: 'x', evidence: [{ kind: 'message', ref: 'm99' }], idempotencyKey: 'c' }), code('invalid'));
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'comment', body: 'x', evidence: [{ kind: 'file', ref: '../etc/passwd' }], idempotencyKey: 'd' }), code('invalid'));
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'comment', body: 'x', evidence: [{ kind: 'task', ref: 'ghost' }], idempotencyKey: 'e' }), code('invalid'));
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'comment', body: 'x', refs: { taskId: 'ghost' }, idempotencyKey: 'f' }), code('invalid'));
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'comment', body: 'x', refs: { batchId: 'ghost-batch' }, idempotencyKey: 'f2' }), code('invalid'));
    assert.throws(() => h.store.openThread({ threadId: 't3', title: 'x', refs: { batchId: 'ghost-batch' }, participants: [LEAD], actorId: LEAD }), code('invalid'));
    const big = 'x'.repeat(COLLABORATION_CEILINGS.maxBodyChars + 1);
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'architect', kind: 'comment', body: big, idempotencyKey: 'g' }), (e: unknown) => code('invalid')(e) && /not truncated/.test((e as Error).message));
    const ok = h.store.post({ threadId: 't1', authorId: 'architect', kind: 'answer', parentId: q.id, body: 'because', refs: { taskId: 'real-task' }, evidence: [{ kind: 'task', ref: 'real-task' }, { kind: 'commit', ref: 'bc4617d' }, { kind: 'event', ref: '2' }, { kind: 'trace', ref: 'mastra-trace-abc' }], idempotencyKey: 'h' });
    assert.equal(ok.evidence.length, 4);
    assert.equal(h.store.events('t1').length, 3, 'every refused write left nothing behind');
  });

  it('records a model invocation with UNKNOWN for anything not reported; an operator has no invocations', () => {
    const h = collabHarness();
    h.store.openThread({ threadId: 't1', title: 'x', participants: [LEAD, 'operator'], actorId: 'operator' });
    const m = h.store.post({ threadId: 't1', authorId: LEAD, kind: 'comment', body: 'c', invocation: { traceId: 'tr-1', usage: { inputTokens: 10 } }, idempotencyKey: 'a' });
    assert.deepEqual(m.invocation, { provider: 'fake', model: 'scripted-lead', runId: null, traceId: 'tr-1', inferenceMs: 'UNKNOWN', usage: { inputTokens: 10, outputTokens: 'UNKNOWN', costUsd: 'UNKNOWN', quota: 'UNKNOWN' } });
    assert.throws(() => h.store.post({ threadId: 't1', authorId: 'operator', kind: 'comment', body: 'c', invocation: {}, idempotencyKey: 'b' }), code('invalid'));
    assert.equal(h.store.post({ threadId: 't1', authorId: 'operator', kind: 'comment', body: 'c', idempotencyKey: 'c' }).invocation, null);
  });
});

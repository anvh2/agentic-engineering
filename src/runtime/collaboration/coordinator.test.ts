import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CoordinatorResult } from './coordinator.ts';
import { CollaborationError } from './types.ts';
import { FailingParticipant, HangingParticipant, latest, ScriptedParticipant } from './__testing__/fake-agents.ts';
import { collabHarness, designMeeting, LEAD, MEETING_PARTICIPANTS, openMeeting } from './__testing__/harness.ts';

const code = (c: CollaborationError['code']) => (e: unknown) => e instanceof CollaborationError && e.code === c;
const talkers = (ids = MEETING_PARTICIPANTS) => ids.map((id) => new ScriptedParticipant(id, Array.from({ length: 10 }, (_, i) => ({ kind: 'comment' as const, body: `${id} round ${i + 1}` }))));
const concluded = (r: CoordinatorResult) => {
  assert.equal(r.status, 'concluded', JSON.stringify(r).slice(0, 300));
  return r as Extract<CoordinatorResult, { status: 'concluded' }>;
};

describe('M9 meeting coordinator: bounded deliberation', () => {
  it('runs the reference meeting to a decision in deterministic turn order', async () => {
    const h = collabHarness();
    const { sessionId } = openMeeting(h.store);
    const m = designMeeting();
    const r = concluded(await h.coordinator.run(sessionId, { owner: 'coord', participants: m.participants }));
    assert.equal(r.outcome, 'decided');
    const turns = r.record.turns.map((t) => `${t.round}.${t.turn}:${t.participant}:${t.kind}`);
    assert.deepEqual(turns, [
      `1.0:${LEAD}:comment`, '1.1:architect:proposal', '1.2:worker-codex:objection', '1.3:reviewer:question',
      `2.0:${LEAD}:answer`, '2.1:architect:correction', '2.2:worker-codex:pass', '2.3:reviewer:support',
      `3.0:${LEAD}:decision`,
    ]);
    assert.equal(r.record.usage.invocations, 9, 'the meeting stopped at the decision; nobody was asked after it');
    assert.deepEqual(m.architect.asked.map((a) => a.round), [1, 2]);
  });

  it('never exceeds maxRounds: a meeting that never decides ends unresolved after exactly rounds x participants turns', async () => {
    const h = collabHarness();
    const { sessionId } = openMeeting(h.store, { limits: { maxRounds: 2, maxInvocations: 50 } });
    const ps = talkers();
    const r = concluded(await h.coordinator.run(sessionId, { owner: 'coord', participants: ps }));
    assert.equal(r.outcome, 'unresolved');
    assert.match(r.record.reason, /^max_rounds/);
    assert.equal(r.record.usage.invocations, 8);
    assert.ok(ps.every((p) => p.asked.length === 2));
    const s = h.store.session(sessionId).session;
    const fence = { owner: s.owner!, epoch: s.epoch };
    assert.throws(() => h.store.reserveTurn(sessionId, fence, { round: 3, turn: 0, participant: LEAD }), code('session_closed'));
  });

  it('stops after a round in which nobody contributed (no endless loop)', async () => {
    const h = collabHarness();
    const { sessionId } = openMeeting(h.store, { limits: { maxRounds: 10, maxInvocations: 100 } });
    const ps = MEETING_PARTICIPANTS.map((id) => new ScriptedParticipant(id, []));
    const r = concluded(await h.coordinator.run(sessionId, { owner: 'coord', participants: ps }));
    assert.equal(r.outcome, 'unresolved');
    assert.match(r.record.reason, /^no_progress/);
    assert.equal(r.record.usage.invocations, 4);
  });

  it('enforces the invocation budget before asking, and ends budget_exhausted (fail closed)', async () => {
    const h = collabHarness();
    const { sessionId } = openMeeting(h.store, { limits: { maxRounds: 5, maxInvocations: 6 } });
    const ps = talkers();
    const r = concluded(await h.coordinator.run(sessionId, { owner: 'coord', participants: ps }));
    assert.equal(r.outcome, 'budget_exhausted');
    assert.equal(r.record.usage.invocations, 6);
    assert.equal(ps.reduce((n, p) => n + p.asked.length, 0), 6, 'no participant was asked beyond the budget');
  });

  it('treats UNKNOWN token usage under a token budget as exhausted, and stops when reported usage reaches the budget', async () => {
    const h = collabHarness();
    const { sessionId } = openMeeting(h.store, { limits: { maxRounds: 3, maxInvocations: 20, maxTokens: 10_000 } });
    const r = concluded(await h.coordinator.run(sessionId, { owner: 'coord', participants: designMeeting({ withUsage: false }).participants }));
    assert.equal(r.outcome, 'budget_exhausted');
    assert.match(r.record.reason, /UNKNOWN/);
    assert.equal(r.record.usage.invocations, 1);
    assert.equal(r.record.usage.tokens, 'UNKNOWN');

    const h2 = collabHarness();
    openMeeting(h2.store, { limits: { maxRounds: 3, maxInvocations: 20, maxTokens: 1_000 } });
    const r2 = concluded(await h2.coordinator.run('s-design', { owner: 'coord', participants: designMeeting().participants }));
    assert.equal(r2.outcome, 'budget_exhausted');
    assert.equal(r2.record.usage.tokens, 160 + 520 + 430, 'the reviewer was not asked once usage reached 1000 tokens');
    assert.equal(r2.record.usage.invocations, 3);
  });

  it('records a failing or hanging participant as a failed outcome (a valid, auditable result)', async () => {
    const h = collabHarness();
    const { sessionId } = openMeeting(h.store);
    const ps = [new ScriptedParticipant(LEAD, []), new FailingParticipant('architect'), ...talkers(['worker-codex', 'reviewer'])];
    const r = concluded(await h.coordinator.run(sessionId, { owner: 'coord', participants: ps }));
    assert.equal(r.outcome, 'failed');
    assert.match(r.record.reason, /architect failed: provider unavailable/);
    assert.equal(r.record.turns.at(-1)!.outcome, 'failed');

    const h2 = collabHarness({ turnTimeoutMs: 50 });
    openMeeting(h2.store);
    const hang = new HangingParticipant('architect');
    const r2 = concluded(await h2.coordinator.run('s-design', { owner: 'coord', participants: [new ScriptedParticipant(LEAD, []), hang, ...talkers(['worker-codex', 'reviewer'])] }));
    assert.equal(r2.outcome, 'failed');
    assert.match(r2.record.reason, /did not answer within 50 ms/);
  });

  it('refuses to run with participants that are missing or not in the session', async () => {
    const h = collabHarness();
    const { sessionId } = openMeeting(h.store);
    await assert.rejects(h.coordinator.run(sessionId, { owner: 'c', participants: talkers([LEAD, 'architect']) }), code('invalid'));
    await assert.rejects(h.coordinator.run(sessionId, { owner: 'c', participants: talkers([...MEETING_PARTICIPANTS, 'worker-ollama']) }), code('unauthorized'));
    assert.equal(h.store.session(sessionId).session.epoch, 0, 'nothing was claimed');
  });
});

describe('M9 meeting coordinator: turn ownership, stale writes and authority', () => {
  it('lets only the participant holding the reserved turn speak, under the current fence and attempt', () => {
    const h = collabHarness();
    const { sessionId, threadId } = openMeeting(h.store);
    const fence = h.store.claimSession(sessionId, 'coord');
    assert.throws(() => h.store.reserveTurn(sessionId, fence, { round: 1, turn: 1, participant: 'architect' }), code('not_your_turn'), 'turns are taken in order');
    assert.throws(() => h.store.reserveTurn(sessionId, fence, { round: 1, turn: 0, participant: 'architect' }), code('not_your_turn'), 'turn 0 belongs to the lead');
    const p = h.store.reserveTurn(sessionId, fence, { round: 1, turn: 0, participant: LEAD });
    const turn = { sessionId, fence, round: 1, turn: 0, attempt: p.attempt };
    assert.throws(() => h.store.post({ threadId, authorId: 'architect', kind: 'comment', body: 'me first', session: turn }), code('not_your_turn'));
    assert.throws(() => h.store.post({ threadId, authorId: LEAD, kind: 'comment', body: 'x', session: { ...turn, fence: { owner: 'coord', epoch: 0 } } }), code('stale'));
    assert.throws(() => h.store.post({ threadId, authorId: LEAD, kind: 'comment', body: 'x', session: { ...turn, attempt: 2 } }), code('not_your_turn'));
    const m = h.store.post({ threadId, authorId: LEAD, kind: 'comment', body: 'ok', session: turn });
    assert.equal(h.store.post({ threadId, authorId: LEAD, kind: 'comment', body: 'ok', session: turn }).id, m.id, 'the same turn re-sent is idempotent');
    assert.throws(() => h.store.post({ threadId, authorId: LEAD, kind: 'comment', body: 'twice', session: turn }), code('idempotency_conflict'), 'one message per turn');
  });

  it('holds maxRounds in the store itself, even for a caller that bypasses the coordinator', () => {
    const h = collabHarness();
    const { sessionId, threadId } = openMeeting(h.store, { participants: [LEAD, 'architect'], limits: { maxRounds: 1, maxInvocations: 10 } });
    const fence = h.store.claimSession(sessionId, 'rogue');
    for (const [turn, who] of [[0, LEAD], [1, 'architect']] as const) {
      const p = h.store.reserveTurn(sessionId, fence, { round: 1, turn, participant: who });
      h.store.post({ threadId, authorId: who, kind: 'comment', body: 'x', session: { sessionId, fence, round: 1, turn, attempt: p.attempt } });
    }
    assert.equal(h.store.session(sessionId).session.status, 'open', 'nobody concluded it');
    assert.throws(() => h.store.reserveTurn(sessionId, fence, { round: 2, turn: 0, participant: LEAD }), code('budget_exhausted'));
  });

  it('refuses every write of a superseded coordinator (stale epoch) after a takeover', async () => {
    const h = collabHarness();
    const { sessionId, threadId } = openMeeting(h.store);
    const old = h.store.claimSession(sessionId, 'coord-old');
    const p = h.store.reserveTurn(sessionId, old, { round: 1, turn: 0, participant: LEAD });
    const fresh = h.store.claimSession(sessionId, 'coord-new');
    assert.equal(fresh.epoch, old.epoch + 1);
    assert.throws(() => h.store.post({ threadId, authorId: LEAD, kind: 'comment', body: 'late', session: { sessionId, fence: old, round: 1, turn: 0, attempt: p.attempt } }), code('stale'));
    assert.throws(() => h.store.closeTurn(sessionId, old, p, { failed: { reason: 'x' } }), code('stale'));
    assert.throws(() => h.store.concludeSession(sessionId, old, 'unresolved', 'x'), code('stale'));
    assert.throws(() => h.store.cancelSession(sessionId, { fence: old }, 'x'), code('stale'));
    // The old reservation is abandoned and the same turn is asked again, as attempt 2, by the new owner.
    const again = h.store.reserveTurn(sessionId, fresh, { round: 1, turn: 0, participant: LEAD });
    assert.equal(again.attempt, 2);
    const s = h.store.session(sessionId).session;
    assert.deepEqual(s.turns.map((t) => [t.outcome, t.attempt]), [['abandoned', 1]]);
    assert.equal(s.invocationsUsed, 2, 'the abandoned call stays charged');
  });

  it('rejects an out-of-role decision or a decision that tries to grant authority; the meeting goes on and the attempt is audited', async () => {
    const h = collabHarness();
    const { sessionId } = openMeeting(h.store, { limits: { maxRounds: 2, maxInvocations: 20 } });
    const lead = new ScriptedParticipant(LEAD, [
      { kind: 'comment', body: 'frame' },
      (ctx) => ({ kind: 'decision', body: 'accept and authorize', decision: { outcome: 'accept', proposalIds: [latest(ctx, 'proposal').id], rationale: 'r', authorizations: [{ kind: 'repair', taskId: 'cap-1' }] } }),
    ]);
    const architect = new ScriptedParticipant('architect', [
      { kind: 'proposal', body: 'P' },
      (ctx) => ({ kind: 'decision', body: 'I decide', decision: { outcome: 'accept', proposalIds: [latest(ctx, 'proposal').id], rationale: 'mine' } }),
    ]);
    const r = concluded(await h.coordinator.run(sessionId, { owner: 'c', participants: [lead, architect, ...talkers(['worker-codex', 'reviewer'])] }));
    assert.equal(r.outcome, 'unresolved', 'no decision was recorded');
    assert.deepEqual(r.record.decisions, []);
    const rejected = r.record.turns.filter((t) => t.outcome === 'rejected');
    assert.deepEqual(rejected.map((t) => t.participant), [LEAD, 'architect']);
    assert.match(rejected[0].reason!, /invalid: decision: \(root\): Unrecognized key/);
    assert.match(rejected[1].reason!, /unauthorized: only the chair/);
    const events = h.store.events('t-design').filter((e) => e.type === 'turn.rejected');
    assert.equal((events[0].payload as { attempted: { body: string } }).attempted.body, 'accept and authorize', 'the refused content is kept in the audit trail');
  });
});

describe('M9 meeting coordinator: cancellation and resume', () => {
  it('an operator cancels a meeting mid-turn: terminal, audited, the in-flight turn recorded, and no resume', async () => {
    const h = collabHarness({ turnTimeoutMs: 300 });
    const { sessionId } = openMeeting(h.store);
    const hang = new HangingParticipant('architect');
    const running = h.coordinator.run(sessionId, { owner: 'coord', participants: [new ScriptedParticipant(LEAD, [{ kind: 'comment', body: 'frame' }]), hang, ...talkers(['worker-codex', 'reviewer'])] });
    while (hang.calls === 0) await new Promise((r) => setTimeout(r, 2));
    const rec = h.store.cancelSession(sessionId, { actorId: 'operator' }, 'operator stop: wrong agenda');
    assert.equal(rec.outcome, 'cancelled');
    assert.deepEqual(rec.pendingAtEnd && [rec.pendingAtEnd.participant, rec.pendingAtEnd.round], ['architect', 1]);
    const cancelEvent = h.store.events('t-design').find((e) => e.type === 'session.cancelled')!;
    assert.equal(cancelEvent.actor, 'operator');
    assert.throws(() => h.store.claimSession(sessionId, 'coord-2'), code('session_closed'), 'a cancelled meeting cannot be resumed');
    assert.equal(h.store.session(sessionId).session.turns.at(-1)!.outcome, 'abandoned');
    // The coordinator was still waiting on the hung participant; its next write meets the closed session.
    const settled = await running;
    assert.equal(settled.status, 'cancelled');
    assert.equal(h.store.events('t-design').filter((e) => e.type === 'turn.failed' || e.type === 'session.concluded').length, 0, 'nothing was written after the cancellation');
  });

  it('an abort suspends the meeting; a new coordinator resumes it from the events and the outcome matches an uninterrupted run', async () => {
    const h = collabHarness({ turnTimeoutMs: 5_000 });
    const { sessionId } = openMeeting(h.store);
    const ac = new AbortController();
    const hang = new HangingParticipant('worker-codex');
    const first = designMeeting();
    const running = h.coordinator.run(sessionId, { owner: 'coord-1', participants: [first.lead, first.architect, hang, first.reviewer], signal: ac.signal });
    while (hang.calls === 0) await new Promise((r) => setTimeout(r, 2));
    ac.abort('operator restart');
    const r1 = await running;
    assert.deepEqual(r1, { status: 'suspended', reason: 'operator restart' });
    const mid = h.store.session(sessionId).session;
    assert.equal(mid.status, 'open');
    assert.equal(mid.pending?.participant, 'worker-codex', 'the unanswered turn is still reserved');

    const second = designMeeting();
    const r2 = concluded(await h.coordinator.run(sessionId, { owner: 'coord-2', participants: second.participants }));
    assert.equal(r2.outcome, 'decided');
    assert.deepEqual(second.codex.asked[0], { round: 1, turn: 2, attempt: 2 }, 'codex was asked the same turn again as attempt 2');
    assert.deepEqual(second.lead.asked.map((a) => a.round), [2, 3], 'nothing already answered was asked again');
    const abandoned = r2.record.turns.filter((t) => t.outcome === 'abandoned');
    assert.deepEqual(abandoned.map((t) => [t.participant, t.attempt]), [['worker-codex', 1]]);

    // Same meeting without the interruption: same contributions, one fewer invocation.
    const h2 = collabHarness();
    openMeeting(h2.store);
    const straight = concluded(await h2.coordinator.run(sessionId, { owner: 'c', participants: designMeeting().participants }));
    const contributions = (rec: typeof straight.record) => rec.turns.filter((t) => t.outcome === 'message').map((t) => `${t.round}.${t.turn}:${t.participant}:${t.kind}`);
    assert.deepEqual(contributions(r2.record), contributions(straight.record));
    assert.equal(r2.record.usage.invocations, straight.record.usage.invocations + 1);
    assert.deepEqual(r2.record.unresolved.map((u) => u.kind), straight.record.unresolved.map((u) => u.kind));
  });
});

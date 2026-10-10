import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collaborationOverview, eventFeed, parseLastEventId, toSseFrame } from './read-model.ts';
import { HangingParticipant, ScriptedParticipant } from './__testing__/fake-agents.ts';
import { collabHarness, designMeeting, LEAD, openMeeting } from './__testing__/harness.ts';

describe('M9 collaboration read models', () => {
  it('reports agent activity only from events: idle agents are idle, unreported usage is UNKNOWN', async () => {
    const h = collabHarness();
    const { sessionId } = openMeeting(h.store);
    await h.coordinator.run(sessionId, { owner: 'coord', participants: designMeeting().participants });
    const o = collaborationOverview(h.store);
    const agent = (id: string) => o.agents.find((a) => a.id === id)!;
    assert.deepEqual([agent('worker-ollama').messages, agent('worker-ollama').invocations, agent('worker-ollama').lastActiveAt, agent('worker-ollama').inputTokens], [0, 0, null, 0], 'configured, never active');
    assert.deepEqual([agent(LEAD).messages, agent(LEAD).invocations, agent(LEAD).inputTokens, agent(LEAD).outputTokens], [3, 3, 920, 190]);
    assert.equal(agent('operator').provider, null);
    const [t] = o.threads;
    assert.equal(t.messageCount, 9);
    assert.deepEqual(t.sessions.map((s) => [s.status, s.outcome, s.invocationsUsed, s.tokensUsed, s.roundsStarted]), [['concluded', 'decided', 9, 2695, 3]]);
    assert.equal(o.cursor, h.store.eventsSince(0).at(-1)!.seq);

    // Same meeting, no usage reported: every token figure is UNKNOWN, never 0.
    const h2 = collabHarness();
    openMeeting(h2.store);
    await h2.coordinator.run(sessionId, { owner: 'coord', participants: designMeeting({ withUsage: false }).participants });
    const o2 = collaborationOverview(h2.store);
    assert.equal(o2.agents.find((a) => a.id === LEAD)!.inputTokens, 'UNKNOWN');
    assert.equal(o2.threads[0].sessions[0].tokensUsed, 'UNKNOWN');
  });

  it('shows the turn in flight and makes a charged but unanswered turn UNKNOWN for that agent', async () => {
    const h = collabHarness({ turnTimeoutMs: 5_000 });
    const { sessionId } = openMeeting(h.store);
    const ac = new AbortController();
    const hang = new HangingParticipant('architect');
    const running = h.coordinator.run(sessionId, { owner: 'coord', participants: [new ScriptedParticipant(LEAD, [{ kind: 'comment', body: 'f', invocation: { usage: { inputTokens: 5, outputTokens: 1 } } }]), hang, new ScriptedParticipant('worker-codex', []), new ScriptedParticipant('reviewer', [])], signal: ac.signal });
    while (hang.calls === 0) await new Promise((r) => setTimeout(r, 2));
    const live = collaborationOverview(h.store);
    assert.deepEqual(live.agents.find((a) => a.id === 'architect')!.currentTurn, { sessionId, round: 1, turn: 1 });
    assert.deepEqual(live.threads[0].sessions[0].pending, { participant: 'architect', round: 1, turn: 1, attempt: 1 });
    ac.abort('stop');
    await running;
    h.store.cancelSession(sessionId, { actorId: 'operator' }, 'done');
    const after = collaborationOverview(h.store);
    const architect = after.agents.find((a) => a.id === 'architect')!;
    assert.deepEqual([architect.invocations, architect.inputTokens, architect.currentTurn], [1, 'UNKNOWN', null]);
    assert.equal(after.agents.find((a) => a.id === LEAD)!.inputTokens, 5);
  });

  it('feeds events in order with a resumable cursor: a reconnect from Last-Event-ID sees no gap and no duplicate', async () => {
    const h = collabHarness();
    const { sessionId } = openMeeting(h.store);
    await h.coordinator.run(sessionId, { owner: 'coord', participants: designMeeting().participants });
    const all = h.store.eventsSince(0).map((e) => e.seq);

    // A client reads pages of 4, "disconnects" after the second page and reconnects with the last id it saw.
    const seen: number[] = [];
    let page = eventFeed(h.store, 0, 4);
    seen.push(...page.events.map((e) => e.seq));
    page = eventFeed(h.store, page.cursor, 4);
    const frames = page.events.map(toSseFrame);
    seen.push(...page.events.map((e) => e.seq));
    const lastId = parseLastEventId(frames.at(-1)!.match(/^id: (\d+)$/m)![1]);
    assert.equal(lastId, page.cursor);
    let cursor = lastId!;
    for (;;) {
      const p = eventFeed(h.store, cursor, 4);
      seen.push(...p.events.map((e) => e.seq));
      cursor = p.cursor;
      if (!p.hasMore) break;
    }
    assert.deepEqual(seen, all);
    assert.deepEqual(eventFeed(h.store, cursor, 4), { events: [], cursor, hasMore: false }, 'caught up: nothing repeats');

    // New events after reconnect arrive once.
    h.store.post({ threadId: 't-design', authorId: 'reviewer', kind: 'comment', body: 'late note', idempotencyKey: 'late' });
    const tail = eventFeed(h.store, cursor, 4);
    assert.deepEqual(tail.events.map((e) => e.type), ['message.posted']);

    const frame = toSseFrame(tail.events[0]);
    assert.match(frame, /^id: \d+\nevent: message\.posted\ndata: \{.*\}\n\n$/s);
    for (const bad of [undefined, null, '', 'abc', '-1', '1.5', '9'.repeat(16)]) assert.equal(parseLastEventId(bad as string | null | undefined), null, String(bad));
  });
});

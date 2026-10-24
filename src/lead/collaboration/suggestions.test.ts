import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SchedulerStore, type TaskRow } from '../../runtime/scheduler/store.ts';
import { makeRepo, plan, tempDir, workerTask } from '../../runtime/scheduler/test-helpers.ts';
import { classifyEscalation, decideSuggestion, listSuggestions, MAX_SUGGESTIONS_PER_BATCH, suggestForDeadTasks, suggestForRejectedObjective, SuggestionError } from './suggestions.ts';

/** A batch whose tasks we put into exactly the escalated states the lifecycle would see. */
function batchWith(ids: string[]) {
  const store = new SchedulerStore(join(tempDir('suggest-'), 'scheduler.db'));
  store.createBatch(plan(makeRepo(), ids.map((id) => workerTask(id)), { batchId: 'b1', project: 'quota' }));
  const fail = (id: string, category: string, reason: string, correctionOf?: string): TaskRow => {
    store.db.prepare('UPDATE tasks SET state = ?, failure_category = ?, state_reason = ?, correction_of = ? WHERE id = ?').run('ESCALATED', category, reason, correctionOf ?? null, id);
    return store.requireTask(id);
  };
  return { store, fail };
}
const suggest = (store: SchedulerStore, tasks: TaskRow[]) => suggestForDeadTasks(store, { objectiveId: 'obj1', batchId: 'b1', tasks, actor: 'lifecycle-driver' });

describe('M12 meeting suggestions: classification', () => {
  it('technical escalations suggest a typed meeting; security, authorization, budget and operator stops never do; retryable ones neither', () => {
    assert.deepEqual(classifyEscalation('coding_attempts_exhausted'), { kind: 'technical', meetingType: 'technical_escalation' });
    assert.deepEqual(classifyEscalation('review_rejected'), { kind: 'technical', meetingType: 'review_escalation' });
    assert.deepEqual(classifyEscalation('integration_conflict'), { kind: 'technical', meetingType: 'integration_failure' });
    for (const c of ['forbidden_mutation', 'review_gate_blocked', 'escalated_by_reviewer', 'provider_not_authorized', 'source_tree_dirty', 'cancelled']) assert.equal(classifyEscalation(c).kind, 'operator', c);
    for (const c of ['task_timeout', 'runtime_unavailable', 'capacity_wait_timeout', 'executor_error', 'lease_expired', 'provider_unavailable', 'dependency_failed', 'not_eligible', 'something_new', null]) assert.equal(classifyEscalation(c).kind, 'none', String(c));
  });
});

describe('M12 meeting suggestions: durable, deduplicated, bounded', () => {
  it('records a technical escalation with verified references, the runtime reason and proposed participants; skips the rest with a reason', () => {
    const { store, fail } = batchWith(['t1', 't2', 't3']);
    const out = suggest(store, [
      fail('t1', 'review_rejected', 'rejected after 2 correction(s); correction budget (2) exhausted: - finding:comment_removed'),
      fail('t2', 'forbidden_mutation', 'the worker changed go.mod'),
      fail('t3', 'task_timeout', 'task exceeded taskTimeout'),
    ]);
    assert.equal(out.created.length, 1);
    const s = out.created[0];
    assert.equal(s.status, 'pending');
    assert.equal(s.meetingType, 'review_escalation');
    assert.deepEqual(s.refs, { project: 'quota', objectiveId: 'obj1', batchId: 'b1', taskId: 't1' });
    assert.equal(s.reason, 't1 is ESCALATED [review_rejected]: rejected after 2 correction(s); correction budget (2) exhausted: - finding:comment_removed', 'the reason is the runtime record, verbatim');
    assert.deepEqual(s.participants.map((p) => p.role), ['engineering_lead', 'implementer', 'reviewer']);
    assert.deepEqual(out.skipped.map((k) => [k.taskId, k.why.split(':')[0]]), [['t2', 'operator decision, not a meeting'], ['t3', 'task_timeout is retryable or derived from another failure']]);
  });

  it('never suggests the same thing twice: a re-escalation, a correction of the same root, or a dismissed suggestion', () => {
    const { store, fail } = batchWith(['t1', 't1-fix1']);
    const first = suggest(store, [fail('t1', 'review_rejected', 'r1')]);
    assert.equal(first.created.length, 1);
    assert.equal(suggest(store, [store.requireTask('t1')]).created.length, 0, 'the objective escalated again the same way');
    assert.equal(suggest(store, [fail('t1-fix1', 'review_rejected', 'r2', 't1')]).created.length, 0, 'a correction belongs to its root task');
    decideSuggestion(store, first.created[0].id, { status: 'dismissed', by: 'anvh2', reason: 'known cause' });
    const again = suggest(store, [store.requireTask('t1')]);
    assert.equal(again.created.length, 0, 'a dismissed suggestion is never re-suggested');
    assert.match(again.skipped[0].why, /already suggested .*dismissed/);
    assert.equal(listSuggestions(store).length, 1);
  });

  it(`at most ${MAX_SUGGESTIONS_PER_BATCH} suggestions per batch, whatever escalates`, () => {
    const ids = Array.from({ length: MAX_SUGGESTIONS_PER_BATCH + 2 }, (_, i) => `t${i}`);
    const { store, fail } = batchWith(ids);
    const out = suggest(store, ids.map((id) => fail(id, 'coding_attempts_exhausted', `worker failed ${id}`)));
    assert.equal(out.created.length, MAX_SUGGESTIONS_PER_BATCH);
    assert.equal(out.skipped.filter((k) => /the limit/.test(k.why)).length, 2);
    assert.equal(suggestForRejectedObjective(store, { objectiveId: 'obj1', batchId: 'b1', detail: 'x', evidenceHash: 'abc', actor: 'a' }).created.length, 0, 'the cap holds for objective-level suggestions too');
  });

  it('a suggestion is decided once, and nothing about it can be rewritten afterwards, not even in SQL', () => {
    const { store, fail } = batchWith(['t1']);
    const [s] = suggest(store, [fail('t1', 'integration_conflict', 'merge conflict on budget.go')]).created;
    assert.throws(() => decideSuggestion(store, s.id, { status: 'dismissed', by: 'anvh2', reason: ' ' }), SuggestionError);
    assert.equal(decideSuggestion(store, s.id, { status: 'accepted', by: 'claude-engineering-lead', sessionId: 'm1' }).status, 'accepted');
    assert.throws(() => decideSuggestion(store, s.id, { status: 'dismissed', by: 'anvh2', reason: 'late' }), /already accepted/);
    assert.throws(() => store.db.prepare("UPDATE meeting_suggestions SET reason = 'a model said so' WHERE id = ?").run(s.id), /never changes/);
    assert.throws(() => store.db.prepare('DELETE FROM meeting_suggestions WHERE id = ?').run(s.id), /never deleted/);
    assert.equal(listSuggestions(store)[0].reason, 't1 is ESCALATED [integration_conflict]: merge conflict on budget.go');
  });

  it('the content of a pending suggestion is fixed too: only the decision columns may change', () => {
    const { store, fail } = batchWith(['t1']);
    const [s] = suggest(store, [fail('t1', 'coding_attempts_exhausted', 'runtime evidence')]).created;
    assert.throws(() => store.db.prepare("UPDATE meeting_suggestions SET reason = 'rewritten' WHERE id = ?").run(s.id), /never changes/);
    assert.throws(() => store.db.prepare("UPDATE meeting_suggestions SET task_id = NULL WHERE id = ?").run(s.id), /never changes/);
    assert.throws(() => store.db.prepare("UPDATE meeting_suggestions SET created_by = 'operator', created_at = 0 WHERE id = ?").run(s.id), /never changes/, 'provenance and order are fixed too');
  });
});

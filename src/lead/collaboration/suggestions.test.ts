import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LifecycleStore } from '../lifecycle/store.ts';
import { SchedulerStore, type TaskRow } from '../../runtime/scheduler/store.ts';
import { makeRepo, plan, tempDir, workerTask } from '../../runtime/scheduler/test-helpers.ts';
import { pinObjective } from './__testing__/pin.ts';
import { assertSuggestionGuards, classifyEscalation, decideSuggestion, listSuggestions, MAX_SUGGESTIONS_PER_BATCH, suggestForDeadTasks, suggestForRejectedObjective, SuggestionError } from './suggestions.ts';

/** A batch whose tasks we put into exactly the escalated states the lifecycle would see. */
function batchWith(ids: string[]) {
  const store = new SchedulerStore(join(tempDir('suggest-'), 'scheduler.db'));
  store.createBatch(plan(makeRepo(), ids.map((id) => workerTask(id)), { batchId: 'b1', project: 'quota' }));
  pinObjective(store, 'obj1', 'b1', 'ESCALATED');
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
    // the same batch is NOT_ACCEPTED for this check (the cap counts every kind of suggestion in the batch)
    store.db.prepare("UPDATE objective_lifecycle SET phase = 'ACCEPTING' WHERE objective_id = 'obj1'").run();
    new LifecycleStore(store).transition('obj1', 'NOT_ACCEPTED', { actor: 'lifecycle-acceptance', expectFrom: 'ACCEPTING', reason: 'oracle_rejected: x', detail: { evidenceHash: 'abc' } });
    assert.equal(suggestForRejectedObjective(store, { objectiveId: 'obj1', batchId: 'b1', evidenceHash: 'abc', actor: 'a' }).created.length, 0, 'the cap holds for objective-level suggestions too');
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

  it('the database itself refuses a half-made decision, a decision on a pending row, and replacing a decided row (INSERT OR REPLACE)', () => {
    const { store, fail } = batchWith(['t1', 't2', 't3']);
    const [a, b, c] = suggest(store, [fail('t1', 'coding_attempts_exhausted', 'r1'), fail('t2', 'coding_attempts_exhausted', 'r2'), fail('t3', 'coding_attempts_exhausted', 'r3')]).created;
    assert.throws(() => store.db.prepare("UPDATE meeting_suggestions SET decided_by = 'mallory', session_id = 'fake', decided_at = 1 WHERE id = ?").run(a.id), /CHECK constraint/, 'a pending row carries no decision');
    assert.throws(() => store.db.prepare("UPDATE meeting_suggestions SET status = 'accepted' WHERE id = ?").run(b.id), /CHECK constraint/, 'accepted needs who, when and the meeting');
    assert.throws(() => store.db.prepare("UPDATE meeting_suggestions SET status = 'dismissed', decided_by = 'x', decided_at = 1, decision_reason = '  ' WHERE id = ?").run(b.id), /CHECK constraint/, 'dismissed needs a reason');
    decideSuggestion(store, c.id, { status: 'dismissed', by: 'anvh2', reason: 'known' });
    const replace = "INSERT OR REPLACE INTO meeting_suggestions (id, dedupe_key, status, meeting_type, category, project, objective_id, batch_id, task_id, reason, evidence, participants, created_at, created_by) SELECT id, dedupe_key, 'pending', meeting_type, category, project, objective_id, batch_id, task_id, 'REWRITTEN', evidence, participants, created_at, created_by FROM meeting_suggestions WHERE id = ?";
    assert.throws(() => store.db.prepare(replace).run(c.id), /never replaced/);
    assert.throws(() => store.db.prepare(replace).run(a.id), /never replaced/, 'nor a pending one');
    assert.throws(() => store.db.prepare("INSERT INTO meeting_suggestions SELECT * FROM meeting_suggestions WHERE id = ?").run(a.id), /never replaced|UNIQUE/);
    const rows = listSuggestions(store);
    assert.deepEqual(rows.map((r) => [r.status, r.reason]), [['pending', 't1 is ESCALATED [coding_attempts_exhausted]: r1'], ['pending', 't2 is ESCALATED [coding_attempts_exhausted]: r2'], ['dismissed', 't3 is ESCALATED [coding_attempts_exhausted]: r3']]);
    assert.equal(rows[0].decidedBy, null);
  });

  it('a dropped guard is not quietly recreated: writing is refused until someone looks', () => {
    const { store, fail } = batchWith(['t1', 't2']);
    suggest(store, [fail('t1', 'coding_attempts_exhausted', 'r1')]);
    store.db.exec('DROP TRIGGER meeting_suggestions_insert_new');
    assert.throws(() => suggest(store, [fail('t2', 'coding_attempts_exhausted', 'r2')]), /missing its guard.*meeting_suggestions_insert_new/);
    assert.equal(listSuggestions(store).length, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'meeting_suggestions_insert_new'").get()?.n, 0, 'not healed behind anyone\'s back');
  });

  it('every write path fails closed while a guard is missing: creating, accepting and dismissing', () => {
    const { store, fail } = batchWith(['t1', 't2', 't3']);
    const [a, b] = suggest(store, [fail('t1', 'coding_attempts_exhausted', 'r1'), fail('t2', 'coding_attempts_exhausted', 'r2')]).created;
    store.db.exec('DROP TRIGGER meeting_suggestions_fixed');
    assert.throws(() => decideSuggestion(store, a.id, { status: 'accepted', by: 'claude-engineering-lead', sessionId: 'm1' }), /missing its guard.*meeting_suggestions_fixed/);
    assert.throws(() => decideSuggestion(store, b.id, { status: 'dismissed', by: 'anvh2', reason: 'no longer relevant' }), /missing its guard/);
    assert.throws(() => assertSuggestionGuards(store), /missing its guard/);
    assert.throws(() => suggest(store, [fail('t3', 'coding_attempts_exhausted', 'r3')]), /missing its guard/);
    assert.deepEqual(listSuggestions(store).map((x) => [x.status, x.decidedBy, x.sessionId]), [['pending', null, null], ['pending', null, null]], 'nothing was decided or created');
  });

  it('a table from before the CHECK constraint is refused too (triggers alone are not the guard)', () => {
    const { store, fail } = batchWith(['t1']);
    const [a] = suggest(store, [fail('t1', 'coding_attempts_exhausted', 'r1')]).created;
    store.db.exec(`DROP TABLE meeting_suggestions;
      CREATE TABLE meeting_suggestions (id TEXT PRIMARY KEY, dedupe_key TEXT, status TEXT, meeting_type TEXT, category TEXT, project TEXT, objective_id TEXT, batch_id TEXT, task_id TEXT, reason TEXT, evidence TEXT, participants TEXT, created_at INTEGER, created_by TEXT, decided_at INTEGER, decided_by TEXT, decision_reason TEXT, session_id TEXT);
      CREATE TRIGGER meeting_suggestions_insert_new BEFORE INSERT ON meeting_suggestions BEGIN SELECT 1; END;
      CREATE TRIGGER meeting_suggestions_no_delete BEFORE DELETE ON meeting_suggestions BEGIN SELECT 1; END;
      CREATE TRIGGER meeting_suggestions_fixed BEFORE UPDATE ON meeting_suggestions BEGIN SELECT 1; END;`);
    assert.throws(() => decideSuggestion(store, a.id, { status: 'dismissed', by: 'anvh2', reason: 'x' }), /no CHECK constraint/);
    assert.throws(() => suggest(store, [store.requireTask('t1')]), /no CHECK constraint/);
  });
});

describe('M12 meeting suggestions: the creators verify their inputs against the scheduler, not the caller', () => {
  it('re-reads each task: a stale or forged copy changes nothing; the current runtime record is what is suggested', () => {
    const { store, fail } = batchWith(['t1', 't2', 't3']);
    const t1 = fail('t1', 'review_rejected', 'finding:comment_removed');
    const forged = { ...t1, failureCategory: 'integration_conflict', stateReason: 'a model says so', state: 'ESCALATED' } as TaskRow;
    fail('t2', 'forbidden_mutation', 'edited go.mod');
    const staleCopy = { ...store.requireTask('t2'), failureCategory: 'coding_attempts_exhausted' } as TaskRow; // the caller's copy claims a technical failure
    store.db.prepare("UPDATE tasks SET state = 'READY', failure_category = NULL WHERE id = 't3'").run(); // resumed since the caller looked
    const out = suggest(store, [forged, staleCopy, store.requireTask('t3')]);
    assert.deepEqual(out.created.map((s) => [s.refs.taskId, s.meetingType, s.category]), [['t1', 'review_escalation', 'review_rejected']]);
    assert.equal(out.created[0].reason, 't1 is ESCALATED [review_rejected]: finding:comment_removed', 'the scheduler\'s record, not the caller\'s');
    assert.match(out.skipped.find((k) => k.taskId === 't2')!.why, /operator decision/);
    assert.match(out.skipped.find((k) => k.taskId === 't3')!.why, /no longer a dead end/);
  });

  it('a task that is not in the named batch is refused outright, and nothing is written', () => {
    const { store, fail } = batchWith(['t1']);
    store.createBatch(plan(makeRepo(), [workerTask('other1')], { batchId: 'b2', project: 'quota' }));
    store.db.prepare("UPDATE tasks SET state = 'ESCALATED', failure_category = 'coding_attempts_exhausted' WHERE id = 'other1'").run();
    assert.throws(() => suggest(store, [fail('t1', 'coding_attempts_exhausted', 'r'), store.requireTask('other1')]), /task other1 is not a task of batch b1/);
    assert.throws(() => suggest(store, [{ id: 'ghost' } as TaskRow]), /task ghost is not a task of batch b1/);
    assert.equal(listSuggestions(store).length, 0, 'the transaction rolled back, including the valid task');
  });

  it('the objective must be pinned for exactly this batch and be ESCALATED now', () => {
    const { store, fail } = batchWith(['t1']);
    const t = fail('t1', 'coding_attempts_exhausted', 'r');
    assert.throws(() => suggestForDeadTasks(store, { objectiveId: 'unpinned', batchId: 'b1', tasks: [t], actor: 'a' }), /no pinned lifecycle for batch b1/);
    store.createBatch(plan(makeRepo(), [workerTask('x1')], { batchId: 'b2', project: 'quota' }));
    pinObjective(store, 'obj2', 'b2', 'ESCALATED');
    assert.throws(() => suggestForDeadTasks(store, { objectiveId: 'obj2', batchId: 'b1', tasks: [t], actor: 'a' }), /no pinned lifecycle for batch b1/, 'another objective\'s pin does not vouch for this batch');
    store.db.prepare("UPDATE objective_lifecycle SET phase = 'EXECUTING' WHERE objective_id = 'obj1'").run();
    assert.throws(() => suggest(store, [t]), /obj1 is EXECUTING, not ESCALATED/, 'an operator resumed it in the meantime');
    assert.equal(listSuggestions(store).length, 0);
  });

  it('an acceptance failure needs the recorded NOT_ACCEPTED verdict and its evidence hash; the reason is the recorded one', () => {
    const { store } = batchWith(['t1']);
    const reject = (over: Partial<{ objectiveId: string; evidenceHash: string }> = {}) => suggestForRejectedObjective(store, { objectiveId: 'obj1', batchId: 'b1', evidenceHash: 'f'.repeat(64), actor: 'a', ...over });
    assert.throws(() => reject(), /obj1 is ESCALATED, not NOT_ACCEPTED/);
    store.db.prepare("UPDATE objective_lifecycle SET phase = 'ACCEPTING' WHERE objective_id = 'obj1'").run();
    new LifecycleStore(store).transition('obj1', 'NOT_ACCEPTED', { actor: 'lifecycle-acceptance', expectFrom: 'ACCEPTING', reason: 'oracle_rejected: candidate fails TestBudget', detail: { evidenceHash: 'f'.repeat(64) } });
    assert.throws(() => reject({ evidenceHash: '0'.repeat(64) }), /evidence hash does not match/);
    assert.throws(() => reject({ objectiveId: 'nope' }), /no pinned lifecycle/);
    const [s] = reject().created;
    assert.equal(s.reason, 'objective obj1 is NOT_ACCEPTED by its pinned oracle: oracle_rejected: candidate fails TestBudget');
  });
});


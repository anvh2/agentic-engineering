import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveCapacity, type DelegationCapacity } from '../../runtime/execution/delegation-capacity.ts';
import type { TaskSpecInput } from '../../runtime/scheduler/types.ts';
import { runObjectiveLifecycle } from './driver.ts';
import { GOOD, TASK_TESTS, goRunner, goTask, harness, standardTasks, type Harness } from './__testing__/fixture.ts';
import { verifyReview } from './verified-review.ts';

/**
 * M9.0: the delegation capacity policy and the complete-evidence review, end to end through the existing scheduler, verified
 * review and lifecycle driver (no new path). The fake provider always claims PASS; only the runtime's own evidence decides.
 */

const solutions = { pad: [GOOD.pad], title: [GOOD.title], describe: [GOOD.describe] };
const withPadCapacity = (capacity: DelegationCapacity, provider?: string): TaskSpecInput[] => [
  { ...goTask('pad', { file: 'pad.go', test: TASK_TESTS.pad, provider }), capacity },
  ...standardTasks().filter((t) => t.id !== 'pad'),
];
const padCalls = (h: Harness) => h.provider.calls.filter((c) => c.taskId.startsWith('pad')).length;

/** Stands in for a PASS-time gate that saw nothing (as the 4,000-byte-truncated gate could): the verified review must not rely on it. */
function blindGate(h: Harness): void {
  h.worktrees.inspect = async () => ({ findings: [], diff: '', changedAllowedFiles: ['pad.go'], newlyChangedPaths: ['pad.go'], changedLines: {}, capacity: resolveCapacity(undefined) });
}

describe('M9.0 delegation capacity: hard limit', () => {
  it('a change over maxChangedLinesPerTask is ESCALATED at PASS time, once: no retry, no correction, and the objective stops for a human', async () => {
    const h = harness({ solutions, tasks: withPadCapacity({ warnChangedLinesPerFile: 1, maxChangedLinesPerTask: 2 }) });
    await h.pin();
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    const pad = h.store.requireTask('pad');
    assert.equal(pad.state, 'ESCALATED');
    assert.equal(pad.failureCategory, 'review_gate_blocked');
    assert.match(pad.stateReason!, /capacity_exceeded/);
    const result = pad.result as { capacity: { source: string; maxChangedLinesPerTask: number }; changedLines: Record<string, number> };
    assert.equal(result.capacity.source, 'task');
    assert.equal(result.capacity.maxChangedLinesPerTask, 2);
    assert.ok(result.changedLines['pad.go'] > 2);
    assert.equal(padCalls(h), 1, 'the worker ran exactly once');
    assert.equal(h.store.getTask('pad-fix1'), undefined, 'a hard limit never becomes a repair');
    assert.equal(out.verdict, 'ESCALATED');
    assert.match(out.stops.join('\n'), /pad is ESCALATED \[review_gate_blocked\].*capacity_exceeded/);
  });

  it('at the hard limit the same change goes through to an ACCEPTED objective', async () => {
    const probe = harness({ solutions });
    await probe.scheduler.run({ batchId: 'obj1' });
    const lines = (probe.store.requireTask('pad').result as { changedLines: Record<string, number> }).changedLines['pad.go'];
    const h = harness({ solutions, tasks: withPadCapacity({ warnChangedLinesPerFile: lines, maxChangedLinesPerTask: lines }) });
    await h.pin();
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ACCEPTED', JSON.stringify(out.stops));
  });
});

describe('M9.0 delegation capacity: quality warning', () => {
  it('too_large on the local provider is REPAIR_REQUIRED and repaired only inside the existing correction budget', async () => {
    const h = harness({ solutions, tasks: withPadCapacity({ warnChangedLinesPerFile: 2, maxChangedLinesPerTask: 100 }), maxReviewCorrections: 1 });
    await h.pin();
    await h.scheduler.run({ batchId: 'obj1' });
    assert.equal(h.store.requireTask('pad').state, 'REVIEW_PENDING');
    const v = await verifyReview({ store: h.store, worktrees: h.worktrees, run: goRunner }, 'pad');
    assert.equal(v.verdict, 'REPAIR_REQUIRED');
    assert.deepEqual(v.reasons, ['finding:too_large']);
    assert.match(v.feedback!, /task policy's warnChangedLinesPerFile of 2/);
    assert.equal(v.evidence.capacity.source, 'task');

    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ESCALATED', 'the same size again exhausts the budget of 1 and stops');
    assert.equal(padCalls(h), 2, 'initial run + exactly the one budgeted correction');
  });

  it('too_large on a paid provider waits for the operator: the policy never authorizes a paid retry by itself', async () => {
    const h = harness({ solutions, tasks: withPadCapacity({ warnChangedLinesPerFile: 2, maxChangedLinesPerTask: 100 }, 'codex'), allowProviders: ['codex'] });
    await h.pin();
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'AWAITING_OPERATOR');
    assert.equal(out.reason, 'repair_needs_operator_authorization');
    assert.equal(padCalls(h), 1);
    assert.equal(h.store.getTask('pad-fix1'), undefined);
  });
});

describe('M9.0 verified review re-derives from the complete committed diff', () => {
  it('records complete evidence and the default policy on a normal approval', async () => {
    const h = harness({ solutions });
    await h.scheduler.run({ batchId: 'obj1' });
    const v = await verifyReview({ store: h.store, worktrees: h.worktrees, run: goRunner }, 'pad');
    assert.equal(v.verdict, 'APPROVE');
    for (const name of ['complete_evidence', 'committed_diff_security', 'delegation_capacity']) assert.equal(v.checks.find((c) => c.name === name)?.ok, true, name);
    assert.equal(v.evidence.capacity.source, 'default');
    assert.ok(v.evidence.diffBytes! > 0);
    assert.ok(v.evidence.changedLines['pad.go'] > 0);
  });

  it('a malicious line beyond 4 KB of committed diff is ESCALATED even when the PASS-time findings were empty', async () => {
    const filler = Array.from({ length: 150 }, (_, i) => `// note ${i}: harmless looking padding to push the payload past the old cut-off`).join('\n');
    const h = harness({ solutions: { ...solutions, pad: [`${GOOD.pad}\n${filler}\nvar _ = "child_process"\n`] }, tasks: withPadCapacity({ warnChangedLinesPerFile: 2_000, maxChangedLinesPerTask: 2_000 }) });
    blindGate(h);
    await h.scheduler.run({ batchId: 'obj1' });
    assert.equal(h.store.requireTask('pad').state, 'REVIEW_PENDING', 'the blind gate let it through');
    const v = await verifyReview({ store: h.store, worktrees: h.worktrees, run: goRunner }, 'pad');
    assert.equal(v.verdict, 'ESCALATE');
    assert.ok(v.evidence.diffBytes! > 4_000);
    assert.ok(v.reasons.includes('committed_diff_security'), v.reasons.join());
    assert.match(v.checks.find((c) => c.name === 'committed_diff_security')!.detail, /child_process/);
  });

  it('a commit over the hard limit is ESCALATED at review even when the PASS-time gate missed it', async () => {
    const h = harness({ solutions, tasks: withPadCapacity({ warnChangedLinesPerFile: 1, maxChangedLinesPerTask: 2 }) });
    blindGate(h);
    await h.scheduler.run({ batchId: 'obj1' });
    const v = await verifyReview({ store: h.store, worktrees: h.worktrees, run: goRunner }, 'pad');
    assert.equal(v.verdict, 'ESCALATE');
    assert.ok(v.reasons.includes('delegation_capacity'), v.reasons.join());
  });

  it('a committed change it cannot read as text (binary) is ESCALATED as incomplete evidence, and nothing is judged on it', async () => {
    const h = harness({ solutions: { ...solutions, pad: ['package fmtkit\n\x00\x01\x02\n'] } });
    blindGate(h);
    await h.scheduler.run({ batchId: 'obj1' });
    const v = await verifyReview({ store: h.store, worktrees: h.worktrees, run: goRunner }, 'pad');
    assert.equal(v.verdict, 'ESCALATE');
    assert.ok(v.reasons.includes('complete_evidence'), v.reasons.join());
    assert.equal(v.checks.find((c) => c.name === 'allowed_files')!.detail, 'not judged: the change set is incomplete');
    assert.equal(v.evidence.independentVerification, null, 'no verifier run on untrustworthy evidence');
  });
});

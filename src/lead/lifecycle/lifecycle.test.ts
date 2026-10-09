import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { StoreError } from '../../runtime/scheduler/store.ts';
import { git } from '../../runtime/scheduler/test-helpers.ts';
import { cancelObjective, REVIEWER, resumeObjective, runObjectiveLifecycle } from './driver.ts';
import { verifyPinnedOracle } from './oracle.ts';
import { GOOD, VACUOUS_ORACLE, harness, standardTasks } from './__testing__/fixture.ts';

const solutions = { pad: [GOOD.pad], title: [GOOD.title], describe: [GOOD.describe] };
const kinds = (h: ReturnType<typeof harness>) => h.lifecycle.events('obj1').map((e) => (e.kind === 'phase' ? `phase:${e.toPhase}` : e.kind));
const inOrder = (all: string[], expected: string[]) => {
  let at = -1;
  for (const e of expected) {
    const i = all.indexOf(e, at + 1);
    assert.ok(i > at, `expected "${e}" after position ${at} in [${all.join(', ')}]`);
    at = i;
  }
};

describe('M8.5 lifecycle: happy path', () => {
  it('task execution -> verified review -> integration -> independent acceptance, in dependency order, ends ACCEPTED', async () => {
    const h = harness({ solutions });
    const mainBefore = git(h.repo, 'rev-parse', 'main');
    await h.pin();
    const oracleBefore = h.lifecycle.require('obj1').oracle;

    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ACCEPTED', JSON.stringify(out.stops));
    assert.equal(out.reason, 'accepted');
    for (const id of ['pad', 'title', 'describe']) assert.equal(h.store.requireTask(id).state, 'DONE');

    // dependency ordering: describe was claimed only after pad and title were integrated, and its worktree contained their work
    const events = h.store.events();
    const done = (id: string) => events.find((e) => e.taskId === id && e.to === 'DONE')!.seq;
    const claimed = events.find((e) => e.taskId === 'describe' && e.to === 'CLAIMED')!.seq;
    assert.ok(done('pad') < claimed && done('title') < claimed, 'describe is claimed after both dependencies are DONE');
    const call = h.provider.calls.find((c) => c.taskId === 'describe')!;
    assert.match(call.sawFiles['pad.go'], /strings\.Repeat/);
    assert.match(call.sawFiles['title.go'], /strings\.ToUpper/);

    // every review was decided from a verified verdict, through the existing review decision
    for (const id of ['pad', 'title', 'describe']) {
      const t = h.store.requireTask(id);
      const review = h.store.latestReview(id)!;
      assert.equal(review.decision, 'APPROVED');
      assert.equal(review.reviewer, REVIEWER);
      const verdicts = t.artifacts.verifiedReviews as { verdict: string; evidence: { independentVerification: { exitCode: number }[]; headCommit: string; claimOwner: string } }[];
      assert.equal(verdicts.length, 1);
      assert.equal(verdicts[0].verdict, 'APPROVE');
      assert.equal(verdicts[0].evidence.independentVerification[0].exitCode, 0, 'the runtime re-ran the verifier itself');
      assert.equal(verdicts[0].evidence.headCommit, t.headCommit);
      assert.ok(verdicts[0].evidence.claimOwner, 'the claim owner comes from the audit trail');
    }

    // integration: commits recorded, on the integration branch only, in plan order, main untouched
    const acc = out.acceptance!;
    const tip = git(h.repo, 'rev-parse', 'lead-integration/obj1');
    assert.equal(acc.integration.tip, tip);
    assert.equal(git(h.repo, 'rev-parse', 'main'), mainBefore);
    assert.equal(git(h.repo, 'status', '--porcelain'), '');
    for (const t of acc.integration.tasks) {
      assert.ok(t.integratedCommit && git(h.repo, 'merge-base', '--is-ancestor', t.integratedCommit, tip) === '', `${t.taskId} integrated commit is on the integration branch`);
      assert.ok(t.runIds.length >= 1);
    }
    const merges = git(h.repo, 'log', '--merges', '--format=%s', 'lead-integration/obj1').split('\n').reverse();
    assert.deepEqual(merges.map((m) => m.split(':')[0]), ['integrate pad', 'integrate title', 'integrate describe']);

    // acceptance evidence
    assert.equal(acc.verdict, 'ACCEPTED');
    assert.equal(acc.candidate!.commit, tip);
    assert.equal(acc.candidate!.passed, true);
    assert.deepEqual(acc.candidate!.commands.map((c) => [c.command.join(' '), c.exitCode]), [['go vet ./...', 0], ['go test -count=1 ./...', 0]]);
    for (const c of acc.candidate!.commands) {
      assert.match(c.outputSha256, /^[0-9a-f]{64}$/);
      assert.equal(typeof c.durationMs, 'number');
    }
    const neg = acc.negativeControl as { commit: string; passed: boolean; conclusive: boolean; commands: { exitCode: number }[] };
    assert.equal(neg.commit, git(h.repo, 'rev-parse', 'refs/lead/base/obj1'), 'the negative control ran on the batch base');
    assert.equal(neg.passed, false);
    assert.equal(neg.conclusive, true);
    assert.notEqual(neg.commands.at(-1)!.exitCode, 0);
    assert.match(acc.evidenceHash, /^[0-9a-f]{64}$/);

    // the oracle is exactly what was pinned, and was pinned before any worker ran
    assert.deepEqual(h.lifecycle.require('obj1').oracle, oracleBefore);
    assert.equal((await verifyPinnedOracle(oracleBefore)).ok, true);
    assert.equal(acc.oracle.pinnedBeforeFirstClaim, true);
    assert.equal(acc.oracle.specHash, oracleBefore.specHash);

    // the audit trail tells the whole story, in order
    inOrder(kinds(h), ['pin', 'phase:EXECUTING', 'execution', 'review', 'integration', 'review', 'integration', 'phase:ACCEPTING', 'phase:ACCEPTED']);
    const lc = h.lifecycle.require('obj1');
    assert.equal(lc.phase, 'ACCEPTED');
    assert.equal((lc.result as { acceptance: { evidenceHash: string } }).acceptance.evidenceHash, acc.evidenceHash);

    // a finished objective is not run again
    const calls = h.provider.calls.length;
    assert.equal((await runObjectiveLifecycle(h.deps, 'obj1')).verdict, 'ACCEPTED');
    assert.equal(h.provider.calls.length, calls);
  });
});

describe('M8.5 lifecycle: crash recovery and single driver', () => {
  it('a driver that dies while the oracle runs leaves ACCEPTING; running again finishes it without redoing any work', async () => {
    const h = harness({ solutions });
    await h.pin();
    h.hooks.beforeAcceptanceCommit = () => {
      throw new Error('simulated crash');
    };
    await assert.rejects(runObjectiveLifecycle(h.deps, 'obj1'), /simulated crash/);
    assert.equal(h.lifecycle.require('obj1').phase, 'ACCEPTING');
    assert.equal(h.store.getTask('pad')!.state, 'DONE');
    const calls = h.provider.calls.length;
    h.hooks.beforeAcceptanceCommit = undefined;
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ACCEPTED');
    assert.equal(h.provider.calls.length, calls, 'no worker ran again');
  });

  it('only one driver runs an objective at a time', async () => {
    const h = harness({ solutions });
    await h.pin();
    assert.ok(h.store.acquireLock('lifecycle:obj1', 'other-driver:1', 60_000));
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'IN_PROGRESS');
    assert.equal(out.reason, 'driver_locked');
    assert.equal(h.provider.calls.length, 0);
    assert.equal(h.lifecycle.require('obj1').phase, 'PINNED');
    h.store.releaseLock('lifecycle:obj1', 'other-driver:1');
    assert.equal((await runObjectiveLifecycle(h.deps, 'obj1')).verdict, 'ACCEPTED');
    assert.equal(h.store.acquireLock('lifecycle:obj1', 'x', 1000), true, 'the lock is released when the driver ends');
  });
});

describe('M8.5 lifecycle: review rejection and bounded repair', () => {
  it('a worker that reports PASS on wrong code is rejected by the independent verifier, repaired once, then accepted', async () => {
    const h = harness({ solutions: { ...solutions, pad: [GOOD.padWrong, GOOD.pad] } });
    await h.pin();
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ACCEPTED', JSON.stringify(out.stops));

    const first = h.store.requireTask('pad');
    assert.equal(first.state, 'REVIEW_REJECTED');
    assert.equal(first.supersededBy, 'pad-fix1');
    const [verdict] = first.artifacts.verifiedReviews as { verdict: string; feedback: string; evidence: { workerSelfReport: { exitCode: number }; independentVerification: { exitCode: number }[] } }[];
    assert.equal(verdict.verdict, 'REPAIR_REQUIRED');
    assert.equal(verdict.evidence.workerSelfReport.exitCode, 0, 'the worker claimed success');
    assert.notEqual(verdict.evidence.independentVerification[0].exitCode, 0, 'the runtime disagreed');
    assert.match(verdict.feedback, /PadLeft/);

    const fix = h.store.requireTask('pad-fix1');
    assert.equal(fix.state, 'DONE');
    assert.equal(fix.correctionOf, 'pad');
    assert.match(fix.spec.request!.contract.objective, /REJECTED in review/);
    assert.match(fix.spec.request!.contract.objective, /PadLeft/, 'the verifier output reached the correction as feedback');
    assert.equal(h.provider.calls.filter((c) => c.taskId.startsWith('pad')).length, 2);
    assert.equal(h.store.requireTask('describe').state, 'DONE', 'dependents followed the correction');
    assert.ok(kinds(h).includes('repair'));
    const prov = (out.acceptance!.integration.tasks).find((t) => t.taskId === 'pad-fix1')!;
    assert.ok(prov.integratedCommit);
  });

  it('repair is bounded by the existing correction budget: after it the task is ESCALATED and nothing more runs', async () => {
    const h = harness({ solutions: { ...solutions, pad: [GOOD.padWrong] }, maxReviewCorrections: 2 });
    await h.pin();
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ESCALATED');
    assert.equal(out.reason, 'task_dead_end');
    assert.equal(h.provider.calls.filter((c) => c.taskId.startsWith('pad')).length, 3, 'initial attempt + exactly 2 corrections');
    const last = h.store.requireTask('pad-fix2');
    assert.equal(last.state, 'ESCALATED');
    assert.match(last.stateReason ?? '', /budget/);
    assert.equal(h.store.getTask('pad-fix3'), undefined, 'no third correction');
    assert.equal(h.store.requireTask('describe').state, 'BLOCKED');
    assert.equal(h.provider.calls.some((c) => c.taskId === 'describe'), false, 'a dependent of a dead end never runs');
    assert.match(out.stops.join('\n'), /partial integration: title/);
    assert.equal(git(h.repo, 'log', '--merges', '--format=%s', 'lead-integration/obj1').split('\n').filter(Boolean).length, 1, 'only title was integrated');

    // a stop waits for a human: running again changes nothing and calls no worker
    const calls = h.provider.calls.length;
    assert.equal((await runObjectiveLifecycle(h.deps, 'obj1')).verdict, 'ESCALATED');
    assert.equal(h.provider.calls.length, calls);
    assert.equal(h.lifecycle.require('obj1').phase, 'ESCALATED');
  });
});

describe('M8.5 lifecycle: stale epochs', () => {
  it('a result written under an old claim epoch is refused by the fence and never reaches review', async () => {
    const h = harness({ solutions });
    h.store.promote();
    const claim = (worker: string) => h.store.claim({ workerId: worker, languages: ['go'], leaseMs: 1, maxActive: 3, batchId: 'obj1' })!;
    const first = claim('w1');
    assert.equal(first.task.id, 'pad');
    h.store.transition('pad', 'CODING', { actor: 'w1', expectFrom: 'CLAIMED', fence: first.fence });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(h.store.reapExpired().requeued, ['pad']);
    const second = h.store.claim({ workerId: 'w2', languages: ['go'], leaseMs: 60_000, maxActive: 3, batchId: 'obj1' })!;
    assert.equal(second.task.id, 'pad');
    assert.equal(second.fence.epoch, first.fence.epoch + 1);
    h.store.transition('pad', 'CODING', { actor: 'w2', expectFrom: 'CLAIMED', fence: second.fence });

    // the zombie of epoch 1 finishes late and tries to complete
    await assert.rejects(
      h.scheduler.complete('pad', first.fence, { runId: 'zombie', status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0, verifier: { command: ['go', 'test'], exitCode: 0 } }, Date.now()),
      (err: unknown) => err instanceof StoreError && err.code === 'stale_owner',
    );
    const t = h.store.requireTask('pad');
    assert.equal(t.state, 'CODING');
    assert.equal(t.leaseOwner, 'w2');
    assert.equal(h.store.latestReview('pad'), undefined, 'no review request was created from the stale result');
  });

  it('a review whose audit trail does not match the current epoch is ESCALATED, and the verifier is not even run', async () => {
    const h = harness({ solutions });
    await h.pin();
    await h.scheduler.run({ batchId: 'obj1' });
    assert.equal(h.store.requireTask('pad').state, 'REVIEW_PENDING');
    h.store.db.prepare('UPDATE tasks SET claim_epoch = claim_epoch + 1 WHERE id = ?').run('pad'); // an epoch the audit trail never saw
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    const pad = h.store.requireTask('pad');
    assert.equal(pad.state, 'ESCALATED');
    assert.equal(pad.failureCategory, 'escalated_by_reviewer');
    const [v] = pad.artifacts.verifiedReviews as { verdict: string; reasons: string[]; evidence: { independentVerification: unknown } }[];
    assert.equal(v.verdict, 'ESCALATE');
    assert.ok(v.reasons.includes('epoch_and_lease_evidence'));
    assert.equal(v.evidence.independentVerification, null);
    assert.equal(out.verdict, 'ESCALATED');
  });
});

describe('M8.5 lifecycle: integration failures', () => {
  it('a merge conflict is escalated with evidence, the integration branch is restored, and independent tasks still integrate', async () => {
    const h = harness({ solutions });
    await h.pin();
    let injected = false;
    h.hooks.beforeIntegration = async () => {
      if (injected) return;
      injected = true;
      // a foreign change lands on the integration branch after review and before integration: add/modify conflict on pad.go
      const iw = await h.worktrees.integrationWorktree(h.store.getBatch('obj1')!);
      writeFileSync(join(iw.path, 'pad.go'), 'package fmtkit\n\n// PadLeft pads s on the left with spaces to width.\nfunc PadLeft(s string, width int) string {\n\treturn "foreign"\n}\n');
      git(iw.path, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-am', 'foreign change');
    };
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ESCALATED');
    assert.equal(out.reason, 'task_dead_end');
    const pad = h.store.requireTask('pad');
    assert.equal(pad.state, 'ESCALATED');
    assert.equal(pad.failureCategory, 'integration_conflict');
    const integ = pad.artifacts.integration as { conflict: { files: string[]; integrationTip: string }; preSha: string };
    assert.deepEqual(integ.conflict.files, ['pad.go']);
    assert.equal(integ.conflict.integrationTip, integ.preSha);
    assert.equal(h.store.requireTask('title').state, 'DONE', 'an independent task is unaffected by the failed one');
    assert.equal(h.store.requireTask('describe').state, 'BLOCKED');
    const merged = git(h.repo, 'log', '--merges', '--format=%s', 'lead-integration/obj1').split('\n').filter(Boolean);
    assert.equal(merged.length, 1, 'pad was never merged');
    assert.match(merged[0], /integrate title/);
    assert.match(out.stops.join('\n'), /partial integration: title/);
    assert.equal(git(h.repo, 'status', '--porcelain'), '');
    const audit = h.lifecycle.events('obj1').find((e) => e.kind === 'integration' && e.detail?.category === 'integration_conflict')!;
    assert.deepEqual(audit.detail!.conflictFiles, ['pad.go']);
  });
});

describe('M8.5 lifecycle: independent acceptance', () => {
  it('an oracle failure is NOT_ACCEPTED even though every task passed its own tests and review', async () => {
    const h = harness({ solutions: { ...solutions, pad: [GOOD.padBytes] } });
    await h.pin();
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'NOT_ACCEPTED');
    assert.equal(out.reason, 'oracle_failed');
    for (const id of ['pad', 'title', 'describe']) assert.equal(h.store.requireTask(id).state, 'DONE', 'task-level success is not objective acceptance');
    const acc = out.acceptance!;
    assert.equal(acc.candidate!.passed, false);
    const failing = acc.candidate!.commands.at(-1)!;
    assert.equal(failing.command.join(' '), 'go test -count=1 ./...');
    assert.equal(failing.exitCode, 1);
    assert.match(failing.outputTail, /case 0/);
    assert.equal((acc.negativeControl as { passed: boolean }).passed, false, 'the control still failed as it must');
    assert.equal(h.lifecycle.require('obj1').phase, 'NOT_ACCEPTED');
    assert.equal(kinds(h).includes('phase:ACCEPTED'), false);
    assert.equal((await runObjectiveLifecycle(h.deps, 'obj1')).verdict, 'NOT_ACCEPTED', 'final: not run again');
  });

  it('an oracle that also passes on the untouched base proves nothing: NOT_ACCEPTED (negative_control_passed)', async () => {
    const h = harness({ solutions, oracle: VACUOUS_ORACLE });
    await h.pin();
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'NOT_ACCEPTED');
    assert.equal(out.reason, 'negative_control_passed');
    assert.equal(out.acceptance!.candidate!.passed, true);
    assert.equal((out.acceptance!.negativeControl as { passed: boolean }).passed, true);
  });

  it('a negative control declared not applicable is allowed only with a reason, and is recorded as skipped', async () => {
    const bad = harness({ solutions, negativeControl: { mode: 'not_applicable', reason: ' ' } });
    await assert.rejects(bad.pin(), /needs a reason/);
    const h = harness({ solutions, negativeControl: { mode: 'not_applicable', reason: 'greenfield fixture: nothing exists to fail on' } });
    await h.pin();
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ACCEPTED');
    assert.deepEqual(out.acceptance!.negativeControl, { skipped: 'greenfield fixture: nothing exists to fail on' });
  });

  it('an oracle edited after the pin is never run: ESCALATED (oracle_tampered)', async () => {
    const h = harness({ solutions });
    await h.pin();
    h.hooks.beforeIntegration = () => {
      writeFileSync(join(h.oracleDir, 'acceptance_test.go'), VACUOUS_ORACLE); // someone makes the oracle easier mid-run
    };
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ESCALATED');
    assert.equal(out.reason, 'oracle_tampered');
    assert.equal(out.acceptance!.candidate, null, 'nothing was run against a modified oracle');
    assert.equal(out.acceptance!.oracle.unchanged, false);
    assert.equal(out.acceptance!.oracle.mismatches[0].file, 'acceptance_test.go');
    assert.notEqual(out.acceptance!.oracle.mismatches[0].now, out.acceptance!.oracle.mismatches[0].pinned);
  });

  it('a file at an oracle path in the repository stops acceptance (oracle_path_occupied) instead of being silently overwritten', async () => {
    const h = harness({ solutions });
    writeFileSync(join(h.repo, 'acceptance_test.go'), VACUOUS_ORACLE);
    git(h.repo, 'add', '-A');
    git(h.repo, 'commit', '-q', '-m', 'someone put a file where the oracle will go');
    await h.pin();
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ESCALATED');
    assert.equal(out.reason, 'oracle_path_occupied');
  });

  it('the oracle must be pinned before any worker runs and must live outside everything a worker can reach', async () => {
    const late = harness({ solutions });
    await late.scheduler.run({ batchId: 'obj1' });
    await assert.rejects(late.pin(), /oracle_pin_too_late/);

    const h = harness({ solutions });
    writeFileSync(join(h.repo, 'inside_test.go'), VACUOUS_ORACLE);
    await assert.rejects(h.pin({ dir: h.repo, files: ['inside_test.go'] }), /oracle_not_isolated/);
    const iw = h.worktrees.root;
    await assert.rejects(h.pin({ dir: iw, files: ['x'] }), /oracle_not_isolated|does not exist/);
    await assert.rejects(h.pin({ commands: [['sh', '-c', 'true']] }), /not allow-listed/);
    await assert.rejects(h.pin({ commands: [['npx', 'jest']] }), /--no-install/);
    await assert.rejects(h.pin({ files: ['../escape.go'] }), /without \.\./);
    await assert.rejects(h.pin({ files: [] }), /at least one file/);
    assert.equal(h.lifecycle.get('obj1'), undefined, 'a refused pin registers nothing');
    await h.pin();
    await assert.rejects(h.pin(), /already has a lifecycle/);
  });
});

describe('M8.5 lifecycle: cancellation during transitions', () => {
  it('a cancel that lands between a review verdict and its decision wins: nothing is approved or integrated', async () => {
    const h = harness({ solutions });
    h.deps.executor = { cancel: async () => ({ run: 'terminal' as const, runStatus: 'canceled' }) };
    await h.pin();
    let cancelled: Awaited<ReturnType<typeof cancelObjective>> | undefined;
    h.hooks.beforeDecision = async () => {
      if (cancelled) return;
      cancelled = await cancelObjective(h.deps, 'obj1', { actor: 'operator', reason: 'changed my mind' });
    };
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'CANCELLED');
    assert.equal(cancelled!.clean, true);
    assert.equal(h.lifecycle.require('obj1').phase, 'CANCELLED');
    for (const t of h.store.listTasks({ batchId: 'obj1' })) assert.ok(['CANCELLED', 'BLOCKED'].includes(t.state) || t.state === 'BACKLOG' || t.state === 'CANCELLED', `${t.id} is ${t.state}`);
    assert.equal(h.store.listTasks({ batchId: 'obj1', states: ['APPROVED', 'INTEGRATING', 'DONE'] }).length, 0, 'the verdict was discarded');
    assert.equal(h.store.latestReview('pad')?.decision ?? null, null);
    assert.ok(kinds(h).includes('review_discarded'));
    assert.equal(git(h.repo, 'log', '--merges', '--format=%s', 'lead-integration/obj1').trim(), '');
    assert.ok(cancelled!.tasks.some((t) => t.outcome === 'cancelled' && t.run === 'stopped'), 'the run of a cancelled task was confirmed stopped');
  });

  it('the lifecycle phase alone is a fence: with the task untouched, a verdict that arrives after CANCELLED is still not applied', async () => {
    const h = harness({ solutions });
    await h.pin();
    let flipped = false;
    h.hooks.beforeDecision = () => {
      if (flipped) return;
      flipped = true;
      h.lifecycle.transition('obj1', 'CANCELLED', { actor: 'operator', reason: 'phase only, no task cancelled' });
    };
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'CANCELLED');
    assert.equal(h.store.requireTask('pad').state, 'REVIEW_PENDING', 'the task was left exactly as the worker produced it');
    assert.equal(h.store.latestReview('pad')!.decision, null, 'no decision was recorded');
    assert.equal(h.store.listTasks({ batchId: 'obj1', states: ['APPROVED', 'INTEGRATING', 'DONE'] }).length, 0);
    assert.ok(kinds(h).includes('review_discarded'));
  });

  it('a cancel during integration stops it before anything is merged', async () => {
    const h = harness({ solutions });
    await h.pin();
    h.hooks.beforeIntegration = async () => {
      await cancelObjective(h.deps, 'obj1', { actor: 'operator', reason: 'stop before merge' });
    };
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'CANCELLED');
    assert.equal(h.store.listTasks({ batchId: 'obj1', states: ['DONE', 'INTEGRATING'] }).length, 0);
    assert.equal(git(h.repo, 'log', '--merges', '--format=%s', 'lead-integration/obj1').trim(), '');
  });

  it('a cancel while the oracle runs keeps its result as evidence only: the objective is CANCELLED, never ACCEPTED', async () => {
    const h = harness({ solutions });
    await h.pin();
    h.hooks.beforeAcceptanceCommit = async (record) => {
      assert.equal(record.verdict, 'ACCEPTED', 'the oracle itself did pass');
      await cancelObjective(h.deps, 'obj1', { actor: 'operator', reason: 'cancel at the last moment' });
    };
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'CANCELLED');
    assert.equal(h.lifecycle.require('obj1').phase, 'CANCELLED');
    const discarded = h.lifecycle.events('obj1').find((e) => e.kind === 'acceptance_discarded')!;
    assert.equal(discarded.detail!.wouldHaveBeen, 'ACCEPTED');
    assert.equal(kinds(h).includes('phase:ACCEPTED'), false);
    assert.equal(h.lifecycle.require('obj1').result?.reason, 'cancelled');
  });

  it('cancelling a finished objective is a no-op and cancelling twice is safe', async () => {
    const h = harness({ solutions });
    await h.pin();
    await runObjectiveLifecycle(h.deps, 'obj1');
    const r = await cancelObjective(h.deps, 'obj1', { actor: 'operator', reason: 'too late' });
    assert.equal(r.alreadyFinal, true);
    assert.equal(h.lifecycle.require('obj1').phase, 'ACCEPTED');

    const h2 = harness({ solutions });
    await h2.pin();
    await cancelObjective(h2.deps, 'obj1', { actor: 'operator', reason: 'first' });
    const again = await cancelObjective(h2.deps, 'obj1', { actor: 'operator', reason: 'second' });
    assert.equal(again.lifecycle.phase, 'CANCELLED');
    await assert.rejects(cancelObjective(h2.deps, 'obj1', { actor: 'operator', reason: ' ' }), /needs a reason/);
    assert.equal((await runObjectiveLifecycle(h2.deps, 'obj1')).verdict, 'CANCELLED');
    assert.equal(h2.provider.calls.length, 0, 'a cancelled objective runs no worker');
  });
});

describe('M8.5 lifecycle: cloud-provider authorization boundaries', () => {
  it('a cloud task is not run unless the operator allowed the provider: no worker call, ESCALATED', async () => {
    const h = harness({ solutions, tasks: standardTasks({ pad: 'codex' }) });
    await h.pin();
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ESCALATED');
    assert.equal(h.provider.calls.some((c) => c.taskId === 'pad'), false, 'the provider was never called');
    const pad = h.store.requireTask('pad');
    assert.equal(pad.state, 'RUNTIME_FAILURE');
    assert.equal(pad.failureCategory, 'provider_not_authorized');
  });

  it('a repair on a cloud provider waits for explicit operator authorization, spends exactly what was authorized, and is audited', async () => {
    const h = harness({ solutions: { ...solutions, pad: [GOOD.padWrong, GOOD.pad] }, tasks: standardTasks({ pad: 'codex' }), allowProviders: ['codex'] });
    await h.pin();
    const first = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(first.verdict, 'AWAITING_OPERATOR');
    assert.equal(first.reason, 'repair_needs_operator_authorization');
    assert.match(first.stops.join('\n'), /lead lifecycle authorize obj1 pad/);
    assert.equal(h.store.getTask('pad-fix1'), undefined, 'no correction (no second paid call) was created');
    assert.equal(h.store.requireTask('pad').state, 'REVIEW_PENDING', 'the rejected result is still awaiting a decision');
    assert.equal(h.provider.calls.filter((c) => c.taskId.startsWith('pad')).length, 1);

    // still waiting: nothing happens by itself
    assert.equal((await runObjectiveLifecycle(h.deps, 'obj1')).verdict, 'AWAITING_OPERATOR');
    assert.equal(h.provider.calls.filter((c) => c.taskId.startsWith('pad')).length, 1);

    // an authorization for another task, or without a reason, does not help
    assert.throws(() => h.lifecycle.authorize('obj1', { kind: 'repair', taskId: 'pad', actor: 'op', reason: ' ' }), /needs a reason/);
    h.lifecycle.authorize('obj1', { kind: 'repair', taskId: 'title', actor: 'op', reason: 'unrelated' });
    assert.throws(() => resumeObjective(h.lifecycle, 'obj1', { actor: 'op', reason: ' ' }), /needs a reason/);
    resumeObjective(h.lifecycle, 'obj1', { actor: 'op', reason: 'trying' });
    assert.equal((await runObjectiveLifecycle(h.deps, 'obj1')).verdict, 'AWAITING_OPERATOR', 'an authorization for title does not cover pad');
    assert.equal(h.store.getTask('pad-fix1'), undefined);

    h.lifecycle.authorize('obj1', { kind: 'repair', taskId: 'pad', uses: 1, actor: 'op', reason: 'one more codex attempt is worth it' });
    resumeObjective(h.lifecycle, 'obj1', { actor: 'op', reason: 'authorized one repair of pad' });
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ACCEPTED', JSON.stringify(out.stops));
    assert.equal(h.provider.calls.filter((c) => c.taskId.startsWith('pad')).length, 2, 'exactly the one authorized repair');
    const lc = h.lifecycle.require('obj1');
    assert.equal(lc.authorizations.find((a) => a.taskId === 'pad')!.remaining, 0, 'the authorization is spent');
    inOrder(kinds(h), ['repair_awaiting_operator', 'authorization', 'phase:EXECUTING', 'authorization_used', 'repair', 'phase:ACCEPTED']);
    assert.equal(h.lifecycle.consumeAuthorization('obj1', 'repair', 'pad', 'x'), false, 'a spent authorization cannot be reused');
  });

  it('a free local provider is repaired without any authorization', async () => {
    const h = harness({ solutions: { ...solutions, pad: [GOOD.padWrong, GOOD.pad] } });
    await h.pin();
    assert.equal((await runObjectiveLifecycle(h.deps, 'obj1')).verdict, 'ACCEPTED');
    assert.equal(kinds(h).includes('authorization_used'), false);
  });
});

describe('M8.5 lifecycle: production runner', () => {
  it('the production sandbox runner executes argv under the OS sandbox (skipped when none is available)', async (t) => {
    const { sandboxStatus } = await import('../../runtime/sandbox/sandbox.ts');
    const { sandboxRunner } = await import('./exec.ts');
    const { tempDir } = await import('../../runtime/scheduler/test-helpers.ts');
    if (!(await sandboxStatus()).available) return t.skip('no OS sandbox');
    const r = await sandboxRunner(120_000)(['go', 'version'], tempDir('lc-sbx-'));
    assert.equal(r.exitCode, 0, r.output);
    assert.match(r.output, /^go version/);
  });
});

// Opt-in because every command then starts with a cold Go build cache inside the sandbox (minutes). It proves the whole lifecycle
// also holds under the production runner: AGENTIC_LIFECYCLE_SANDBOX_E2E=1 node --test src/lead/lifecycle/lifecycle.test.ts
describe('M8.5 lifecycle: whole objective under the OS sandbox', { skip: process.env.AGENTIC_LIFECYCLE_SANDBOX_E2E !== '1' }, () => {
  it('ends ACCEPTED when review, integration and acceptance all run through the sandbox runner', async () => {
    const { sandboxRunner } = await import('./exec.ts');
    const h = harness({ solutions });
    h.deps.run = sandboxRunner(600_000);
    await h.pin();
    const out = await runObjectiveLifecycle(h.deps, 'obj1');
    assert.equal(out.verdict, 'ACCEPTED', JSON.stringify({ stops: out.stops, candidate: out.acceptance?.candidate?.commands }));
    assert.equal((out.acceptance!.negativeControl as { passed: boolean }).passed, false);
  });
});

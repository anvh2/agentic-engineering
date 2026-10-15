import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ApprovalError, DesignApprovalStore, createApprovalVerifier, issueApproval, revokeApproval, type ApprovalCheck, type DesignContent } from './design-approval.ts';
import { LEAD_KEY, TestAuthority, approveCredential, leadGrant, revokeCredential } from './__testing__/approval-fixture.ts';
import { SchedulerStore } from '../scheduler/store.ts';
import { plan, tempDir, workerTask } from '../scheduler/test-helpers.ts';

/**
 * The approval is atomic with respect to worker claims. Two SchedulerStore connections on ONE database file stand in for two
 * scheduler processes. Interleavings are driven by hooks inside the (synchronous) authority, i.e. exactly where the earlier
 * implementation had already read "the task has not started" but had not yet written the approval - no timers, no threads.
 * busyTimeoutMs is 0 so a blocked writer fails immediately instead of waiting.
 */

const design: DesignContent = { hld: 'The scheduler owns capacity.', lld: 'Never exceed two permits.' };
const other: DesignContent = { hld: 'The scheduler owns capacity.', lld: 'Never exceed three permits.' };
const FILES = ['src/a.js'];
let clock = 5_000_000;
let a: SchedulerStore; // the approving process
let b: SchedulerStore; // the scheduler process
let authority: HookAuthority;

/** The test authority, plus a hook that runs while the authority is being consulted (inside issueApproval / revokeApproval). */
class HookAuthority extends TestAuthority {
  hook?: () => void;
  override authenticate(credential: string, digest: string) {
    this.hook?.();
    return super.authenticate(credential, digest);
  }
}

const claimTry = (s: SchedulerStore) => {
  try {
    const claim = s.claim({ workerId: 'worker-1', languages: ['go', 'js'], leaseMs: 60_000, maxActive: 8 });
    return claim ? ('claimed' as const) : ('nothing-to-claim' as const);
  } catch (err) {
    return /database is locked|SQLITE_BUSY/i.test((err as Error).message) ? ('blocked' as const) : (`error: ${(err as Error).message}` as const);
  }
};
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'no error';
  } catch (e) {
    return e instanceof ApprovalError ? e.code : `other: ${(e as Error).message}`;
  }
};
const issue = (s: SchedulerStore, d: DesignContent = design, credential = approveCredential(s, 'lead-1', LEAD_KEY, 'obj1', 'a', d)) =>
  issueApproval({ store: s, authority }, { objectiveId: 'obj1', taskId: 'a', design: d, credential });
const check = (approvalRef: string, d: DesignContent = design): ApprovalCheck => ({ approvalRef, design: d, taskId: 'a', allowedFiles: FILES });
const rows = (s: SchedulerStore) => (s.db.prepare('SELECT COUNT(*) AS n FROM design_approvals').get() as { n: number }).n;
const kinds = (s: SchedulerStore) => new DesignApprovalStore(s).events().map((e) => e.kind);

beforeEach(() => {
  const path = join(tempDir('approval-atomic-'), 'sched.db');
  a = new SchedulerStore(path, { now: () => clock, busyTimeoutMs: 0 });
  a.createBatch(plan('/repo', [workerTask('a', { files: FILES })], { batchId: 'obj1' }));
  a.promote();
  b = new SchedulerStore(path, { now: () => clock, busyTimeoutMs: 0 });
  new DesignApprovalStore(a);
  new DesignApprovalStore(b);
  authority = new HookAuthority().enroll('lead-1', LEAD_KEY, leadGrant());
});

describe('approval vs worker claim', () => {
  it('a claim attempted between the "not started" check and the commit is blocked until the approval commits, so no late approval can exist', () => {
    let during: ReturnType<typeof claimTry> | undefined;
    authority.hook = () => { during = claimTry(b); };
    const { approvalId } = issue(a);
    authority.hook = undefined;
    assert.equal(during, 'blocked', 'the scheduler connection could not claim while the approval transaction held the write lock');
    assert.equal(a.requireTask('a').claims, 0);
    // The approval committed first, so the claim that follows is legitimate and the approval still verifies.
    assert.equal(claimTry(b), 'claimed');
    assert.equal(createApprovalVerifier({ store: b, authority })(check(approvalId)).ok, true);
  });

  it('a claim that committed BEFORE the approval makes the approval impossible, and leaves no trace', () => {
    assert.equal(claimTry(b), 'claimed');
    assert.equal(codeOf(() => issue(a)), 'task_started');
    assert.equal(rows(a), 0);
    assert.deepEqual(kinds(a), []);
  });

  it('the claim is seen even by an approval whose credential and design were prepared before the claim (no stale authorization)', () => {
    const credential = approveCredential(a, 'lead-1', LEAD_KEY, 'obj1', 'a', design);
    assert.equal(claimTry(b), 'claimed');
    assert.equal(codeOf(() => issue(a, design, credential)), 'task_started');
    assert.equal(rows(a), 0);
  });

  it('lock contention fails closed as approval_conflict: nothing written, and the same request succeeds once the lock is free', () => {
    const credential = approveCredential(a, 'lead-1', LEAD_KEY, 'obj1', 'a', design);
    b.transact(() => {
      assert.equal(codeOf(() => issue(a, design, credential)), 'approval_conflict');
    });
    assert.equal(rows(a), 0);
    assert.deepEqual(kinds(a), []);
    assert.equal(issue(a, design, credential).record.revision, 1);
  });
});

describe('revision allocation and idempotency', () => {
  it('two approvals prepared for the same revision cannot both be recorded; the loser fails closed and a fresh request supersedes', () => {
    const forD1 = approveCredential(a, 'lead-1', LEAD_KEY, 'obj1', 'a', design);
    const forD2 = approveCredential(a, 'lead-1', LEAD_KEY, 'obj1', 'a', other); // also prepared for revision 1
    const first = issue(a, design, forD1);
    assert.equal(first.record.revision, 1);
    assert.equal(codeOf(() => issue(b, other, forD2)), 'not_authenticated', 'revision 1 is taken; a credential for revision 1 no longer authenticates anything');
    assert.equal(rows(a), 1);
    const second = issue(b, other); // fresh credential for the next revision
    assert.equal(second.record.revision, 2);
    assert.equal(rows(a), 2);
    assert.equal(createApprovalVerifier({ store: a, authority })(check(first.approvalId)).ok, false, 'superseded');
    assert.equal(createApprovalVerifier({ store: a, authority })(check(second.approvalId, other)).ok, true);
  });

  it('the database itself refuses a second approval for an allocated revision', () => {
    const { record } = issue(a);
    assert.throws(() => new DesignApprovalStore(b).insert({ ...record, approverId: 'someone-else' }, undefined, 'someone-else'), /UNIQUE/);
    assert.equal(rows(a), 1);
  });

  it('the same design is idempotent across connections: one record, one audit event, no new revision', () => {
    const first = issue(a);
    const again = issue(b);
    assert.equal(again.approvalId, first.approvalId);
    assert.equal(rows(a), 1);
    assert.deepEqual(kinds(a), ['issued']);
  });
});

describe('rollback', () => {
  it('a failure after the approval row is written rolls back the row, the supersession and the audit event together', () => {
    const v1 = issue(a);
    a.db.exec("CREATE TRIGGER boom BEFORE INSERT ON design_approval_events BEGIN SELECT RAISE(ABORT, 'audit write failed'); END;");
    assert.throws(() => issue(a, other), /audit write failed/);
    a.db.exec('DROP TRIGGER boom');
    assert.equal(rows(a), 1, 'no partial approval row');
    assert.deepEqual(kinds(a), ['issued'], 'no misleading audit event');
    assert.equal(createApprovalVerifier({ store: a, authority })(check(v1.approvalId)).ok, true, 'the earlier approval was not superseded by the failed attempt');
    assert.equal(issue(a, other).record.revision, 2, 'no revision number was consumed');
  });

  it('a failed revocation leaves the approval valid and writes no audit event', () => {
    const { approvalId } = issue(a);
    a.db.exec("CREATE TRIGGER boom BEFORE INSERT ON design_approval_events BEGIN SELECT RAISE(ABORT, 'audit write failed'); END;");
    assert.throws(() => revokeApproval({ store: a, authority }, { approvalId, credential: revokeCredential('lead-1', LEAD_KEY, approvalId), reason: 'r' }), /audit write failed/);
    a.db.exec('DROP TRIGGER boom');
    assert.equal(createApprovalVerifier({ store: a, authority })(check(approvalId)).ok, true);
    assert.deepEqual(kinds(a), ['issued']);
  });
});

describe('revocation under concurrency', () => {
  it('a second revoker racing the first cannot add a second "revoked" audit event', () => {
    const { approvalId } = issue(a);
    let racer: string | undefined;
    authority.hook = () => {
      authority.hook = undefined;
      racer = codeOf(() => revokeApproval({ store: b, authority }, { approvalId, credential: revokeCredential('lead-1', LEAD_KEY, approvalId), reason: 'racer' }));
    };
    revokeApproval({ store: a, authority }, { approvalId, credential: revokeCredential('lead-1', LEAD_KEY, approvalId), reason: 'first' });
    assert.equal(racer, 'approval_conflict', 'the racer could not write while the first revocation held the lock');
    assert.deepEqual(kinds(a), ['issued', 'revoked']);
  });

  it('revoking twice (sequentially) is idempotent and audited once; the store reports who actually revoked', () => {
    const { approvalId } = issue(a);
    const store = new DesignApprovalStore(a);
    assert.equal(store.revoke(approvalId, 'lead-1', 'one'), true);
    assert.equal(store.revoke(approvalId, 'lead-1', 'two'), false);
    revokeApproval({ store: a, authority }, { approvalId, credential: revokeCredential('lead-1', LEAD_KEY, approvalId), reason: 'three' });
    assert.deepEqual(kinds(a), ['issued', 'revoked']);
  });

  it('an approval and its revocation are visible across connections', () => {
    const { approvalId } = issue(a);
    const viaB = createApprovalVerifier({ store: b, authority });
    assert.equal(viaB(check(approvalId)).ok, true);
    revokeApproval({ store: a, authority }, { approvalId, credential: revokeCredential('lead-1', LEAD_KEY, approvalId), reason: 'unsound' });
    const verdict = viaB(check(approvalId));
    assert.equal(verdict.ok, false);
    assert.equal((verdict as { code: string }).code, 'approval_revoked');
  });
});

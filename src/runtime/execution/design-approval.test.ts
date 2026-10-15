import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalError, DesignApprovalStore, createApprovalVerifier, denyAllApprovals, issueApproval, revokeApproval, type ApprovalCheck, type DelegatedAuthority, type DesignContent } from './design-approval.ts';
import { LEAD_KEY, TestAuthority, approveCredential, leadGrant, revokeCredential } from './__testing__/approval-fixture.ts';
import { makeStore, plan, workerTask } from '../scheduler/test-helpers.ts';
import type { SchedulerStore } from '../scheduler/store.ts';

/** Deterministic forgery / tampering / scope / revocation coverage for runtime-owned design approvals. */

const design = { hld: 'The scheduler owns capacity.', lld: 'Never exceed two permits.', adr: ['No Oracle access.'] };
let clock = 1_000_000;
let store: SchedulerStore;
let authority: TestAuthority;

const withRisk = (id: string, risk: 'low' | 'medium' | 'high', files: string[]) => {
  const t = workerTask(id, { files }) as ReturnType<typeof workerTask> & { request: { assessment: { risk: string } } };
  t.request.assessment.risk = risk;
  return t;
};

beforeEach(() => {
  clock = 1_000_000;
  store = makeStore(() => clock);
  store.createBatch(plan('/repo', [
    workerTask('a', { files: ['src/a.js'] }),
    workerTask('b', { files: ['lib/b.js'] }),
    workerTask('far', { files: ['srcx/far.js'] }),
    withRisk('hot', 'high', ['src/hot.js']),
    workerTask('ts', { files: ['src/t.ts'] }),
  ], { batchId: 'obj1' }));
  store.createBatch(plan('/repo', [workerTask('other', { files: ['src/other.js'] })], { batchId: 'obj2' }));
  authority = new TestAuthority().enroll('lead-1', LEAD_KEY, leadGrant());
});

const issue = (taskId = 'a', d: DesignContent = design, o: { principal?: string; key?: string; objective?: string; auth?: TestAuthority; ttlMs?: number; revision?: number } = {}) => {
  const objectiveId = o.objective ?? 'obj1';
  return issueApproval({ store, authority: o.auth ?? authority }, { objectiveId, taskId, design: d, credential: approveCredential(store, o.principal ?? 'lead-1', o.key ?? LEAD_KEY, objectiveId, taskId, d, o.revision), ttlMs: o.ttlMs });
};
const verifier = () => createApprovalVerifier({ store, authority });
const check = (approvalRef: string, o: Partial<ApprovalCheck> = {}): ApprovalCheck => ({ approvalRef, design, taskId: 'a', allowedFiles: ['src/a.js'], ...o });
const codeOf = (fn: () => unknown) => { try { fn(); return 'no error'; } catch (e) { return e instanceof ApprovalError ? e.code : `other: ${(e as Error).message}`; } };
const fails = (verdict: ReturnType<ReturnType<typeof verifier>>, code: string) => { assert.equal(verdict.ok, false); assert.equal((verdict as { code: string }).code, code, JSON.stringify(verdict)); };

describe('issuing and verifying a design approval', () => {
  it('binds design fingerprint, revision, approver, role, grant, scope, task, objective and files; verifies for exactly that design', () => {
    const { approvalId, record } = issue();
    assert.match(approvalId, /^da-[a-f0-9]{32}$/);
    assert.deepEqual({ objectiveId: record.objectiveId, taskId: record.taskId, revision: record.revision, approverId: record.approverId, role: record.role, grantId: record.grantId, language: record.language, allowedFiles: record.allowedFiles }, { objectiveId: 'obj1', taskId: 'a', revision: 1, approverId: 'lead-1', role: 'engineering-lead', grantId: 'grant-lead-1', language: 'js', allowedFiles: ['src/a.js'] });
    assert.match(record.designFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(record.scope, leadGrant().scope, 'the authority held at approval time is part of the record');
    const verdict = verifier()(check(approvalId));
    assert.equal(verdict.ok, true);
    assert.deepEqual((verdict as { approval: unknown }).approval, { approvalId, revision: 1, designFingerprint: record.designFingerprint, approverId: 'lead-1', role: 'engineering-lead', grantId: 'grant-lead-1', approvedAt: clock });
    assert.deepEqual(new DesignApprovalStore(store).events().map((e) => e.kind), ['issued']);
  });

  it('is idempotent for the same design and a new revision for a changed one', () => {
    const first = issue();
    assert.equal(issue().approvalId, first.approvalId);
    const second = issue('a', { ...design, lld: 'Never exceed three permits.' });
    assert.notEqual(second.approvalId, first.approvalId);
    assert.equal(second.record.revision, 2);
  });

  it('the production default verifies nothing', () => {
    const { approvalId } = issue();
    fails(denyAllApprovals(check(approvalId)), 'authority_unconfigured');
  });
});

describe('forgery', () => {
  it('an arbitrary or look-alike approvalRef is not an approval', () => {
    issue();
    for (const ref of ['ADR-014@abc123', '', 'da-', `da-${'0'.repeat(32)}`, `da-${'f'.repeat(32)}`, 'approved', '../da-x']) fails(verifier()(check(ref)), 'approval_unknown');
  });

  it('an approval for one task cannot be presented for another, even with the same design', () => {
    const { approvalId } = issue('a');
    fails(verifier()(check(approvalId, { taskId: 'b', allowedFiles: ['lib/b.js'] })), 'task_mismatch');
  });

  it('credentials are bound to the exact request: wrong key, unknown principal, garbage, and a credential for a different design all fail', () => {
    assert.equal(codeOf(() => issue('a', design, { key: 'not-the-lead-key' })), 'not_authenticated');
    assert.equal(codeOf(() => issue('a', design, { principal: 'mallory', key: LEAD_KEY })), 'not_authenticated');
    assert.equal(codeOf(() => issueApproval({ store, authority }, { objectiveId: 'obj1', taskId: 'a', design, credential: 'lead-1.deadbeef' })), 'not_authenticated');
    const other = { ...design, hld: 'a different design' };
    const credentialForOther = approveCredential(store, 'lead-1', LEAD_KEY, 'obj1', 'a', other);
    assert.equal(codeOf(() => issueApproval({ store, authority }, { objectiveId: 'obj1', taskId: 'a', design, credential: credentialForOther })), 'not_authenticated', 'replaying a credential for another design');
    const credentialForTaskB = approveCredential(store, 'lead-1', LEAD_KEY, 'obj1', 'b', design);
    assert.equal(codeOf(() => issueApproval({ store, authority }, { objectiveId: 'obj1', taskId: 'a', design, credential: credentialForTaskB })), 'not_authenticated', 'replaying a credential for another task');
    assert.equal(new DesignApprovalStore(store).latestRevision('obj1', 'a'), undefined, 'nothing was written');
  });

  it('an old credential cannot be replayed to revert a design to an earlier revision', () => {
    const v1 = approveCredential(store, 'lead-1', LEAD_KEY, 'obj1', 'a', design);
    issue();
    issue('a', { ...design, lld: 'v2' });
    assert.equal(codeOf(() => issueApproval({ store, authority }, { objectiveId: 'obj1', taskId: 'a', design, credential: v1 })), 'not_authenticated');
  });

  it('a record written around the issuer (fabricated row) does not verify', () => {
    const { approvalId, record } = issue();
    const fabricated = JSON.stringify({ ...record, approverId: 'someone-else' });
    store.db.exec('DROP TRIGGER design_approvals_no_rewrite');
    store.db.prepare('INSERT INTO design_approvals (approval_id, objective_id, task_id, revision, record, record_sha256) VALUES (?,?,?,?,?,?)').run(`da-${'a'.repeat(32)}`, 'obj1', 'b', 1, fabricated, 'bad');
    fails(verifier()(check(`da-${'a'.repeat(32)}`)), 'approval_tampered');
    assert.equal(verifier()(check(approvalId)).ok, true, 'the genuine one is unaffected');
  });
});

describe('tampering', () => {
  it('any change to the attached HLD, LLD or ADR, or to the task files, invalidates the approval', () => {
    const { approvalId } = issue();
    fails(verifier()(check(approvalId, { design: { ...design, hld: 'edited' } })), 'design_mismatch');
    fails(verifier()(check(approvalId, { design: { ...design, lld: 'edited' } })), 'design_mismatch');
    fails(verifier()(check(approvalId, { design: { ...design, adr: [] } })), 'design_mismatch');
    fails(verifier()(check(approvalId, { design: { ...design, adr: [...design.adr, 'extra'] } })), 'design_mismatch');
    fails(verifier()(check(approvalId, { allowedFiles: ['src/a.js', 'src/more.js'] })), 'task_mismatch');
  });

  it('the database refuses to rewrite or delete an approval or its audit trail', () => {
    const { approvalId } = issue();
    assert.throws(() => store.db.prepare('UPDATE design_approvals SET record = ? WHERE approval_id = ?').run('{}', approvalId), /immutable/);
    assert.throws(() => store.db.prepare('UPDATE design_approvals SET task_id = ? WHERE approval_id = ?').run('b', approvalId), /immutable/);
    assert.throws(() => store.db.prepare('DELETE FROM design_approvals WHERE approval_id = ?').run(approvalId), /cannot be deleted/);
    assert.throws(() => store.db.exec("UPDATE design_approval_events SET kind = 'x'"), /append-only/);
    assert.throws(() => store.db.exec('DELETE FROM design_approval_events'), /append-only/);
  });

  it('an edit that gets around the triggers is still detected at verification', () => {
    const { approvalId, record } = issue();
    store.db.exec('DROP TRIGGER design_approvals_no_rewrite');
    const widened = JSON.stringify({ ...record, scope: { ...record.scope, pathPrefixes: ['/'], maxRisk: 'high' } });
    store.db.prepare('UPDATE design_approvals SET record = ? WHERE approval_id = ?').run(widened, approvalId);
    fails(verifier()(check(approvalId)), 'approval_tampered');
  });

  it('a task whose persisted allowed files changed after approval no longer verifies', () => {
    const { approvalId } = issue();
    const row = store.requireTask('a');
    const spec = { ...row.spec, request: { ...row.spec.request!, contract: { ...row.spec.request!.contract, allowedFiles: ['src/a.js', 'src/extra.js'] } } };
    store.db.prepare('UPDATE tasks SET spec = ? WHERE id = ?').run(JSON.stringify(spec), 'a');
    fails(verifier()(check(approvalId)), 'task_mismatch');
  });
});

describe('delegated authority is enforced deterministically', () => {
  const enrollOther = (grant: DelegatedAuthority) => new TestAuthority().enroll('lead-1', LEAD_KEY, grant);
  const code = (grant: DelegatedAuthority, taskId = 'a', objective = 'obj1') => codeOf(() => issue(taskId, design, { auth: enrollOther(grant), objective }));

  it('refuses an objective, language, path or risk outside the grant', () => {
    assert.equal(code(leadGrant(), 'other', 'obj2'), 'out_of_scope', 'objective not in the grant');
    assert.equal(code(leadGrant({ scope: { ...leadGrant().scope, languages: ['go'] } })), 'out_of_scope', 'language');
    assert.equal(code(leadGrant(), 'b'), 'out_of_scope', 'lib/b.js is not under src/ or calc/');
    assert.equal(code(leadGrant(), 'far'), 'out_of_scope', 'srcx/ is not under src/ (no string-prefix confusion)');
    assert.equal(code(leadGrant(), 'hot'), 'out_of_scope', 'high risk exceeds maxRisk low');
    assert.equal(code(leadGrant({ scope: { ...leadGrant().scope, maxRisk: 'high' } }), 'hot'), 'no error');
    assert.equal(code(leadGrant({ scope: { ...leadGrant().scope, pathPrefixes: ['../'] } })), 'out_of_scope', 'a traversal prefix authorizes nothing');
    assert.equal(code(leadGrant({ scope: { ...leadGrant().scope, pathPrefixes: [] } })), 'out_of_scope', 'an empty scope authorizes nothing');
  });

  it('only the engineering-lead role with the approve action can approve; a role claimed by the caller changes nothing', () => {
    assert.equal(code(leadGrant({ role: 'reviewer' })), 'not_permitted');
    assert.equal(code(leadGrant({ role: 'worker' })), 'not_permitted');
    assert.equal(code(leadGrant({ actions: ['revoke'] })), 'not_permitted');
    assert.equal(code(leadGrant({ actions: [] })), 'not_permitted');
  });

  it('refuses a grant outside its validity window or already withdrawn', () => {
    assert.equal(code(leadGrant({ notAfter: clock })), 'grant_inactive');
    assert.equal(code(leadGrant({ notBefore: clock + 1 })), 'grant_inactive');
    assert.equal(code(leadGrant({ revokedAt: clock - 1 })), 'grant_inactive');
  });

  it('a design for a TypeScript task is refused: TypeScript stays non-delegatable', () => {
    assert.equal(code(leadGrant({ scope: { ...leadGrant().scope, languages: ['go', 'js'] } }), 'ts'), 'unsupported_language');
  });

  it('refuses a task that does not exist or belongs to another objective', () => {
    assert.equal(codeOf(() => issue('nope')), 'task_unknown');
    assert.equal(codeOf(() => issue('other', design)), 'task_mismatch', 'task other is in obj2, the request names obj1');
  });

  it('refuses invalid designs', () => {
    assert.equal(codeOf(() => issue('a', { hld: ' ', lld: 'x' })), 'invalid_design');
    assert.equal(codeOf(() => issue('a', { hld: 'x', lld: '' })), 'invalid_design');
    assert.equal(codeOf(() => issue('a', { hld: 'x'.repeat(12_001), lld: 'x' })), 'invalid_design');
    assert.equal(codeOf(() => issue('a', { hld: 'x', lld: 'y', adr: [' '] })), 'invalid_design');
  });

  it('a worker cannot approve its own task: not at issue time and not at verification time', () => {
    store.db.prepare("UPDATE tasks SET assigned_worker = 'lead-1' WHERE id = 'a'").run();
    assert.equal(codeOf(() => issue()), 'self_approval');
    store.db.prepare('UPDATE tasks SET assigned_worker = NULL WHERE id = ?').run('a');
    const { approvalId } = issue();
    store.db.prepare("UPDATE tasks SET assigned_worker = 'lead-1' WHERE id = 'a'").run();
    fails(verifier()(check(approvalId)), 'self_approval');
  });

  it('a design cannot be approved after a worker already started (no retroactive approval)', () => {
    store.db.prepare('UPDATE tasks SET claims = 1 WHERE id = ?').run('a');
    assert.equal(codeOf(() => issue()), 'task_started');
    store.transition('b', 'CANCELLED', { actor: 't' });
    assert.equal(codeOf(() => issue('b')), 'task_started');
  });

  it('an independent reviewer principal cannot approve, supersede or revoke', () => {
    const { approvalId } = issue();
    const reviewer = new TestAuthority().enroll('reviewer-1', 'rk', leadGrant({ grantId: 'grant-rev', role: 'reviewer' }));
    assert.equal(codeOf(() => issue('a', { ...design, lld: 'rewritten by reviewer' }, { auth: reviewer, principal: 'reviewer-1', key: 'rk' })), 'not_permitted');
    assert.equal(codeOf(() => revokeApproval({ store, authority: reviewer }, { approvalId, credential: revokeCredential('reviewer-1', 'rk', approvalId), reason: 'no' })), 'not_permitted');
    assert.equal(verifier()(check(approvalId)).ok, true, 'the approved design is untouched');
  });
});

describe('revocation, supersession and expiry', () => {
  it('revoking an approval stops it authorizing; revoking is audited and idempotent', () => {
    const { approvalId } = issue();
    revokeApproval({ store, authority }, { approvalId, credential: revokeCredential('lead-1', LEAD_KEY, approvalId), reason: 'design found unsound' });
    fails(verifier()(check(approvalId)), 'approval_revoked');
    revokeApproval({ store, authority }, { approvalId, credential: revokeCredential('lead-1', LEAD_KEY, approvalId), reason: 'again' });
    assert.deepEqual(new DesignApprovalStore(store).events(approvalId).map((e) => `${e.kind}:${e.actor}`), ['issued:lead-1', 'revoked:lead-1']);
    assert.equal(codeOf(() => revokeApproval({ store, authority }, { approvalId: `da-${'b'.repeat(32)}`, credential: 'x', reason: 'r' })), 'approval_unknown');
  });

  it('revocation needs an authenticated, in-scope, permitted principal and a reason', () => {
    const { approvalId } = issue();
    const attempt = (auth: TestAuthority, cred: string, reason = 'r') => codeOf(() => revokeApproval({ store, authority: auth }, { approvalId, credential: cred, reason }));
    assert.equal(attempt(authority, revokeCredential('lead-1', 'wrong', approvalId)), 'not_authenticated');
    assert.equal(attempt(authority, revokeCredential('lead-1', LEAD_KEY, `da-${'c'.repeat(32)}`)), 'not_authenticated', 'a credential for another approval');
    assert.equal(attempt(authority, revokeCredential('lead-1', LEAD_KEY, approvalId), ' '), 'invalid_design');
    const wrongScope = new TestAuthority().enroll('lead-1', LEAD_KEY, leadGrant({ scope: { ...leadGrant().scope, objectiveIds: ['obj2'] } }));
    assert.equal(attempt(wrongScope, revokeCredential('lead-1', LEAD_KEY, approvalId)), 'out_of_scope');
    assert.equal(verifier()(check(approvalId)).ok, true);
  });

  it('withdrawing or narrowing the grant takes effect on the next verification, without touching the record', () => {
    const { approvalId } = issue();
    authority.grants.get('grant-lead-1')!.scope.maxRisk = 'low';
    authority.grants.get('grant-lead-1')!.scope.pathPrefixes = ['calc/'];
    fails(verifier()(check(approvalId)), 'out_of_scope');
    authority.grants.set('grant-lead-1', leadGrant({ revokedAt: clock }));
    fails(verifier()(check(approvalId)), 'grant_inactive');
    authority.grants.delete('grant-lead-1');
    fails(verifier()(check(approvalId)), 'grant_unknown');
  });

  it('an approval expires, and cannot outlive its grant', () => {
    const { approvalId, record } = issue('a', design, { ttlMs: 60_000 });
    assert.equal(record.expiresAt, clock + 60_000);
    assert.equal(verifier()(check(approvalId)).ok, true);
    clock += 60_000;
    fails(verifier()(check(approvalId)), 'approval_expired');
    const capped = issue('b' as string, design, { auth: new TestAuthority().enroll('lead-1', LEAD_KEY, leadGrant({ notAfter: clock + 10, scope: { ...leadGrant().scope, pathPrefixes: ['lib/'] } })), ttlMs: 999_999 });
    assert.equal(capped.record.expiresAt, clock + 10);
  });

  it('a newer revision supersedes the older: only the latest approved design verifies', () => {
    const v1 = issue();
    const v2 = issue('a', { ...design, lld: 'Never exceed three permits.' });
    fails(verifier()(check(v1.approvalId)), 'approval_superseded');
    assert.equal(verifier()(check(v2.approvalId, { design: { ...design, lld: 'Never exceed three permits.' } })).ok, true);
    fails(verifier()(check(v2.approvalId)), 'design_mismatch', );
  });

  it('after a revocation the same design can be approved again as a new revision', () => {
    const v1 = issue();
    revokeApproval({ store, authority }, { approvalId: v1.approvalId, credential: revokeCredential('lead-1', LEAD_KEY, v1.approvalId), reason: 'redo' });
    const v2 = issue();
    assert.equal(v2.record.revision, 2);
    assert.notEqual(v2.approvalId, v1.approvalId);
    fails(verifier()(check(v1.approvalId)), 'approval_revoked');
    assert.equal(verifier()(check(v2.approvalId)).ok, true);
  });
});

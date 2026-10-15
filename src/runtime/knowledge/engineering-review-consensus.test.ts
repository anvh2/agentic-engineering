import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FINDING_DOMAIN, VERIFICATION_DOMAIN, consolidateReviewFindings, decideReview, type FindingPayload, type VerificationPayload } from './engineering-review-consensus.ts';
import { signStatement } from './trust.ts';
import { keyringOf, testIdentity } from './__testing__/keys.ts';

const sec = testIdentity('k-security', 'security-agent', ['reviewer']);
const code = testIdentity('k-code', 'code-agent', ['reviewer']);
const codex = testIdentity('k-codex', 'codex-verifier', ['verifier']);
const other = testIdentity('k-other', 'other-verifier', ['verifier']);
const dual = testIdentity('k-dual', 'dual-agent', ['reviewer', 'verifier']);
const keyring = keyringOf(sec, code, codex, other, dual);
const ctx = { keyring, reviewId: 'review-1', now: 1000 };

const finding = (who: typeof sec, over: Partial<FindingPayload> = {}) => signStatement<FindingPayload>(who.privateKeyPem, who.keyId, FINDING_DOMAIN,
  { reviewId: 'review-1', role: 'security', path: 'src/auth.go', severity: 'HIGH', evidence: 'bypass via empty token', description: 'auth bypass', ...over });
const verify = (who: typeof sec, key: string, verdict: VerificationPayload['verdict'], over: Partial<VerificationPayload> = {}) =>
  signStatement<VerificationPayload>(who.privateKeyPem, who.keyId, VERIFICATION_DOMAIN, { reviewId: 'review-1', findingKey: key, verdict, evidence: 'reproduced independently', ...over });

test('duplicate evidence merges across authenticated reviewers and keeps the strictest severity', () => {
  const { findings, rejected } = consolidateReviewFindings([finding(sec, { severity: 'MEDIUM' }), finding(code, { severity: 'CRITICAL', role: 'code', evidence: 'bypass  via empty token' })], ctx);
  assert.equal(rejected.length, 0);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, 'CRITICAL');
  assert.deepEqual(findings[0]!.reviewerIds, ['code-agent', 'security-agent']);
  assert.equal(findings[0]!.status, 'needs-verification');
});

test('F-04 a plain string claiming to be the verifier clears nothing: unsigned and wrongly keyed statements are rejected', () => {
  const { findings } = consolidateReviewFindings([finding(sec, { severity: 'CRITICAL' })], ctx);
  const key = findings[0]!.key;
  const forged = { domain: VERIFICATION_DOMAIN, keyId: 'k-codex', payload: { reviewId: 'review-1', findingKey: key, verdict: 'refuted', evidence: 'trust me' }, signature: 'A'.repeat(86) + '==' };
  const d = decideReview(findings, [forged as never], ctx);
  assert.equal(d.canApprove, false);
  assert.equal(d.rejected[0]!.reason, 'signature mismatch');
  // an attacker holding only a REVIEWER key cannot verify
  const asReviewer = verify(code, key, 'refuted');
  assert.equal(decideReview(findings, [asReviewer], ctx).canApprove, false);
});

test('an independent authenticated refutation clears a severe finding; a confirmation blocks; no verification leaves it unresolved', () => {
  const { findings } = consolidateReviewFindings([finding(sec)], ctx);
  const key = findings[0]!.key;
  assert.deepEqual(decideReview(findings, [], ctx).unresolved, [key]);
  assert.equal(decideReview(findings, [verify(codex, key, 'refuted')], ctx).canApprove, true);
  const confirmed = decideReview(findings, [verify(codex, key, 'confirmed')], ctx);
  assert.deepEqual([confirmed.canApprove, confirmed.blocking], [false, [key]]);
  assert.equal(decideReview(findings, [verify(codex, key, 'inconclusive')], ctx).canApprove, false);
});

test('fail closed on disagreement: one independent confirmation outweighs any number of refutations', () => {
  const { findings } = consolidateReviewFindings([finding(sec)], ctx);
  const key = findings[0]!.key;
  const d = decideReview(findings, [verify(codex, key, 'refuted'), verify(other, key, 'confirmed')], ctx);
  assert.equal(d.canApprove, false);
  assert.deepEqual(d.blocking, [key]);
});

test('self-verification is impossible, including via a second key of the same principal', () => {
  const second = testIdentity('k-sec-2', 'security-agent', ['verifier']);
  const ring = keyringOf(sec, second, codex);
  const c = { ...ctx, keyring: ring };
  const { findings } = consolidateReviewFindings([finding(sec)], c);
  const key = findings[0]!.key;
  assert.equal(decideReview(findings, [verify(second, key, 'refuted')], c).canApprove, false, 'same principal, different key');
  const both = consolidateReviewFindings([finding(dual)], ctx);
  assert.equal(decideReview(both.findings, [verify(dual, both.findings[0]!.key, 'refuted')], ctx).canApprove, false, 'reviewer and verifier in one key');
});

test('a member of a multi-reviewer finding cannot refute it', () => {
  const { findings } = consolidateReviewFindings([finding(sec), finding(dual, { severity: 'CRITICAL' })], ctx);
  assert.equal(decideReview(findings, [verify(dual, findings[0]!.key, 'refuted')], ctx).canApprove, false);
});

test('statements are bound to one review: replay from another review is rejected and blocks approval', () => {
  const stale = finding(sec, { reviewId: 'review-0' });
  const r = consolidateReviewFindings([stale, finding(code, { severity: 'LOW', evidence: 'minor nit' })], ctx);
  assert.deepEqual(r.rejected, [{ index: 0, reason: 'statement belongs to another review' }]);
  assert.equal(r.findings.length, 1);
  const d = decideReview(r.findings, [], ctx, r.rejected);
  assert.equal(d.canApprove, false, 'a dropped finding must not look like a clean review');
  const { findings } = consolidateReviewFindings([finding(sec)], ctx);
  const replayed = verify(codex, findings[0]!.key, 'refuted', { reviewId: 'review-0' });
  assert.equal(decideReview(findings, [replayed], ctx).canApprove, false);
});

test('statements cannot be re-purposed across domains (finding <-> verification)', () => {
  const asVerification = signStatement(codex.privateKeyPem, 'k-codex', FINDING_DOMAIN, { reviewId: 'review-1', findingKey: 'x', verdict: 'refuted', evidence: 'e' });
  const { findings } = consolidateReviewFindings([finding(sec)], ctx);
  assert.equal(decideReview(findings, [asVerification as never], ctx).canApprove, false);
});

test('malformed, unsafe or credential-bearing statements are rejected without throwing', () => {
  const bad = [
    finding(sec, { path: '../secret' }), finding(sec, { path: '/etc/passwd' }), finding(sec, { severity: 'SEVERE' as never }),
    finding(sec, { role: 'wizard' as never }), finding(sec, { evidence: '   ' }), finding(sec, { description: 'x'.repeat(5000) }),
    finding(sec, { evidence: 'leaked ghp_' + 'a'.repeat(36) }),
  ];
  const r = consolidateReviewFindings(bad, ctx);
  assert.equal(r.findings.length, 0);
  assert.equal(r.rejected.length, bad.length);
  assert.equal(decideReview(r.findings, [], ctx, r.rejected).canApprove, false);
});

test('low and medium findings are advisory and never need a verifier', () => {
  const r = consolidateReviewFindings([finding(sec, { severity: 'MEDIUM' })], ctx);
  assert.deepEqual(decideReview(r.findings, [], ctx), { canApprove: true, blocking: [], unresolved: [], rejected: [] });
});

test('an expired or revoked verifier key stops verifying', () => {
  const short = testIdentity('k-short', 'short-verifier', ['verifier'], { notAfter: 500 });
  const c = { ...ctx, keyring: keyringOf(sec, short) };
  const { findings } = consolidateReviewFindings([finding(sec)], c);
  assert.equal(decideReview(findings, [verify(short, findings[0]!.key, 'refuted')], c).canApprove, false);
});

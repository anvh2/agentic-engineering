import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { appendCapsuleEvent, newCapsule, signCapsuleReceipt, verifyCapsule, verifyCapsuleReceipt, RECEIPT_DOMAIN, type Capsule } from './engineering-capsule.ts';
import { signStatement } from './trust.ts';
import { keyringOf, testIdentity } from './__testing__/keys.ts';

const signer = testIdentity('k-evidence', 'runtime-evidence', ['evidence-signer']);
const reviewer = testIdentity('k-reviewer', 'reviewer', ['reviewer']);
const keyring = keyringOf(signer, reviewer);
const ctx = { now: 1000 };
const build = (runId = 'run-1', verifierExit = 0): Capsule =>
  appendCapsuleEvent(appendCapsuleEvent(appendCapsuleEvent(newCapsule(runId), 'task', { id: 't' }), 'verifier', { exit: verifierExit }), 'review', { ok: verifierExit === 0 });

test('digests are reproducible and independent of object key order', () => {
  const a = appendCapsuleEvent(newCapsule('run-2'), 'tool', { a: 1, b: { x: 1, y: 2 } });
  const b = appendCapsuleEvent(newCapsule('run-2'), 'tool', { b: { y: 2, x: 1 }, a: 1 });
  assert.equal(a.rootHash, b.rootHash);
  assert.equal(verifyCapsule(a).ok, true);
});

test('F-05 recomputing the whole chain after editing history yields a chain that verifies as integrity only, and fails the signed receipt', () => {
  const honest = build('run-3', 1);
  const receipt = signCapsuleReceipt(signer.privateKeyPem, 'k-evidence', honest);
  const forged = build('run-3', 0); // attacker rebuilds a self-consistent chain with a PASS verifier
  assert.equal(verifyCapsule(forged).ok, true, 'a hash chain alone cannot tell the difference');
  const verdict = verifyCapsuleReceipt(keyring, receipt, forged, ctx);
  assert.deepEqual(verdict, { ok: false, reason: 'capsule does not reproduce the signed root' });
  assert.equal(verifyCapsuleReceipt(keyring, receipt, honest, ctx).ok, true);
});

test('truncation, tampering, extension and substitution of the capsule are all detected against the signed receipt', () => {
  const c = build();
  const receipt = signCapsuleReceipt(signer.privateKeyPem, 'k-evidence', c);
  const truncated = { ...c, entries: c.entries.slice(0, 2), rootHash: c.entries[1]!.hash };
  assert.equal(verifyCapsule(truncated).ok, true, 'a valid prefix is a valid chain');
  assert.match((verifyCapsuleReceipt(keyring, receipt, truncated, ctx) as { reason: string }).reason, /truncated/);
  const tampered = { ...c, entries: [{ ...c.entries[0]!, payload: { id: 'evil' } }, ...c.entries.slice(1)] } as Capsule;
  assert.match((verifyCapsuleReceipt(keyring, receipt, tampered, ctx) as { reason: string }).reason, /capsule invalid/);
  const extended = appendCapsuleEvent(c, 'decision', { accept: true });
  assert.match((verifyCapsuleReceipt(keyring, receipt, extended, ctx) as { reason: string }).reason, /stale receipt/);
  assert.match((verifyCapsuleReceipt(keyring, receipt, build('run-other'), ctx) as { reason: string }).reason, /another run/);
  assert.equal(verifyCapsuleReceipt(keyring, signCapsuleReceipt(signer.privateKeyPem, 'k-evidence', extended), extended, ctx).ok, true);
});

test('only an evidence-signer key authenticates: reviewer keys, unknown keys, other domains and revoked keys are refused', () => {
  const c = build();
  const wrongRole = signStatement(reviewer.privateKeyPem, 'k-reviewer', RECEIPT_DOMAIN, { schema: 'engineering-receipt/v2', runId: c.runId, rootHash: c.rootHash, entries: c.entries.length, artifactDigest: null });
  assert.equal(verifyCapsuleReceipt(keyring, wrongRole as never, c, ctx).ok, false);
  const wrongDomain = signStatement(signer.privateKeyPem, 'k-evidence', 'knowledge.promotion/v1', { schema: 'engineering-receipt/v2', runId: c.runId, rootHash: c.rootHash, entries: c.entries.length, artifactDigest: null });
  assert.equal(verifyCapsuleReceipt(keyring, wrongDomain as never, c, ctx).ok, false);
  const stranger = testIdentity('k-stranger', 'stranger', ['evidence-signer']);
  assert.equal(verifyCapsuleReceipt(keyring, signCapsuleReceipt(stranger.privateKeyPem, 'k-stranger', c), c, ctx).ok, false);
  const revoked = keyringOf(testIdentity('k-evidence', 'runtime-evidence', ['evidence-signer'], { revokedAt: 10 }));
  assert.equal(verifyCapsuleReceipt(revoked, signCapsuleReceipt(signer.privateKeyPem, 'k-evidence', c), c, ctx).ok, false);
  assert.equal(verifyCapsuleReceipt(keyring, undefined, c, ctx).ok, false);
});

test('a receipt cannot be edited after signing', () => {
  const c = build();
  const receipt = signCapsuleReceipt(signer.privateKeyPem, 'k-evidence', c);
  const edited = { ...receipt, payload: { ...receipt.payload, entries: 1, rootHash: c.entries[0]!.hash } };
  assert.equal(verifyCapsuleReceipt(keyring, edited, c, ctx).ok, false);
});

test('artifact digest is bound by the signature', () => {
  const c = build();
  const digest = 'a'.repeat(64);
  const receipt = signCapsuleReceipt(signer.privateKeyPem, 'k-evidence', c, digest);
  assert.equal(verifyCapsuleReceipt(keyring, receipt, c, { now: 1, artifactDigest: digest }).ok, true);
  assert.equal(verifyCapsuleReceipt(keyring, receipt, c, { now: 1, artifactDigest: 'b'.repeat(64) }).ok, false);
  assert.throws(() => signCapsuleReceipt(signer.privateKeyPem, 'k-evidence', c, 'not-a-digest'), /artifact digest/);
});

test('appending refuses credentials, oversized payloads, unknown kinds, unrepresentable values and invalid capsules', () => {
  const c = newCapsule('run-4');
  assert.throws(() => appendCapsuleEvent(c, 'tool', { out: 'ghp_' + 'a'.repeat(36) }), /credential/);
  assert.throws(() => appendCapsuleEvent(c, 'tool', { big: 'x'.repeat(70_000) }), /too large/);
  assert.throws(() => appendCapsuleEvent(c, 'shell' as never, {}), /kind/);
  assert.throws(() => appendCapsuleEvent(c, 'tool', { n: NaN }), /non-finite/);
  assert.throws(() => appendCapsuleEvent({ ...build(), rootHash: 'f'.repeat(64) }, 'tool', {}), /invalid capsule/);
  assert.throws(() => newCapsule('../etc'), /run id/);
});

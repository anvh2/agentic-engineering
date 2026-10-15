import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { canonicalJson, hashValue, scanForSecrets } from './canonical.ts';
import { TrustedKeyring, signStatement, verifyStatement } from './trust.ts';
import { keyringOf, testIdentity } from './__testing__/keys.ts';

test('canonical JSON is key-order independent and refuses lossy values', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 1, c: [3, { z: 1, y: 2 }] } }), canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 1 }, b: 2 }));
  assert.equal(hashValue({ a: 1, b: undefined }), hashValue({ a: 1 }));
  for (const bad of [{ a: Number.NaN }, { a: Infinity }, { a: 1n }, { a: () => 1 }, [undefined], new Date(), new Map()]) {
    assert.throws(() => canonicalJson(bad), /canonical/, String(bad));
  }
  const cyc: Record<string, unknown> = {}; cyc.self = cyc;
  assert.throws(() => canonicalJson(cyc), /cycle/);
  // __proto__ is data, not a prototype assignment.
  const evil = JSON.parse('{"__proto__":{"polluted":true},"x":1}');
  assert.equal(canonicalJson(evil), '{"__proto__":{"polluted":true},"x":1}');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('secret canaries catch credentials in values and in keys, at any depth', () => {
  assert.deepEqual(scanForSecrets({ ok: 'hello', nest: [{ t: 'ghp_' + 'a'.repeat(36) }] }).map((f) => f.canary), ['github_token']);
  assert.equal(scanForSecrets({ ['AKIA' + 'A'.repeat(16)]: 1 }).length, 1);
  assert.equal(scanForSecrets({ note: 'plain text with no credentials' }).length, 0);
});

test('a statement verifies only for the exact domain, role, payload and a currently valid key', () => {
  const alice = testIdentity('k-alice', 'alice', ['verifier']);
  const ring = keyringOf(alice);
  const st = signStatement(alice.privateKeyPem, 'k-alice', 'review.verification/v1', { finding: 'f1', verdict: 'confirmed' });
  const ok = verifyStatement(ring, st, { domain: 'review.verification/v1', role: 'verifier', now: 10 });
  assert.deepEqual(ok.ok && ok.principalId, 'alice');
  assert.equal(verifyStatement(ring, st, { domain: 'knowledge.promote/v1', role: 'verifier', now: 10 }).ok, false, 'cross-domain replay');
  assert.equal(verifyStatement(ring, st, { domain: 'review.verification/v1', role: 'promoter', now: 10 }).ok, false, 'role');
  assert.equal(verifyStatement(ring, { ...st, payload: { finding: 'f1', verdict: 'refuted' } }, { domain: 'review.verification/v1', role: 'verifier', now: 10 }).ok, false, 'payload tamper');
  assert.equal(verifyStatement(ring, { ...st, keyId: 'k-unknown' }, { domain: 'review.verification/v1', role: 'verifier', now: 10 }).ok, false, 'unknown key');
  assert.equal(verifyStatement(ring, { ...st, signature: 'AAAA' }, { domain: 'review.verification/v1', role: 'verifier', now: 10 }).ok, false, 'garbage signature');
  assert.equal(verifyStatement(ring, undefined, { domain: 'review.verification/v1', role: 'verifier', now: 10 }).ok, false);
});

test('key validity windows and revocation are enforced at verification time', () => {
  const k = testIdentity('k-1', 'bob', ['promoter'], { notBefore: 100, notAfter: 200, revokedAt: 150 });
  const ring = keyringOf(k);
  const st = signStatement(k.privateKeyPem, 'k-1', 'knowledge.promote/v1', { digest: 'x' });
  const check = (now: number) => verifyStatement(ring, st, { domain: 'knowledge.promote/v1', role: 'promoter', now });
  assert.equal(check(99).ok, false);
  assert.equal(check(120).ok, true);
  assert.equal(check(150).ok, false, 'revoked');
  assert.equal(check(300).ok, false);
});

test('an impostor key with the same key id but a different private key does not verify', () => {
  const real = testIdentity('k-real', 'real', ['verifier']);
  const fake = testIdentity('k-real', 'real', ['verifier']);
  const forged = signStatement(fake.privateKeyPem, 'k-real', 'review.verification/v1', { a: 1 });
  assert.equal(verifyStatement(keyringOf(real), forged, { domain: 'review.verification/v1', role: 'verifier', now: 1 }).ok, false);
});

test('keyring rejects duplicate ids, non-ed25519 keys and unreadable keys', () => {
  const a = testIdentity('k-a', 'agent-a', ['verifier']);
  assert.throws(() => new TrustedKeyring([a.input, a.input]), /duplicate/);
  assert.throws(() => new TrustedKeyring([{ ...a.input, publicKeyPem: 'nope' }]), /unreadable/);
  assert.throws(() => new TrustedKeyring([{ ...a.input, roles: [] }]), /roles/);
  const rsa = require_rsa();
  assert.throws(() => new TrustedKeyring([{ ...a.input, keyId: 'k-rsa', publicKeyPem: rsa }]), /ed25519/);
});

function require_rsa(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

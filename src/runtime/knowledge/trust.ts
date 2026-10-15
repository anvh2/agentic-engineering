/**
 * Authenticated identities for evidence, review verification and knowledge promotion.
 *
 * A hash proves integrity, not authorship (docs: ECC's own capsule notes say the same). Authorship here is an Ed25519
 * signature by a key the RUNTIME trusts. Trust root = a `TrustedKeyring` constructed by the operator/runtime from keys the
 * model, the worker and the repository under change cannot write. This module generates no keys, stores no private keys and
 * reads no environment: the caller supplies them. A compromised runtime process can still sign anything, which is the same
 * trust boundary the scheduler database already has.
 *
 * Every signature is domain-separated (`domain`) and bound to the exact payload, so a statement signed for one purpose
 * (e.g. a review verification) cannot be replayed as another (e.g. a knowledge promotion).
 */
import { createPublicKey, sign, verify, createPrivateKey, type KeyObject } from 'node:crypto';
import { canonicalJson } from './canonical.ts';

export type KeyRole = 'reviewer' | 'verifier' | 'promoter' | 'evidence-signer';
const ROLES: readonly KeyRole[] = ['reviewer', 'verifier', 'promoter', 'evidence-signer'];
const KEY_ID = /^[a-z][a-z0-9._-]{1,63}$/;
const PRINCIPAL_ID = /^[a-z][a-z0-9._-]{1,63}$/;
const PREFIX = 'agentic-engineering/signed-statement/v1\n';

export interface TrustedKeyInput {
  keyId: string;
  /** The identity this key speaks for. Authenticated principal ids come from here, never from the statement. */
  principalId: string;
  publicKeyPem: string;
  roles: readonly KeyRole[];
  notBefore?: number;
  notAfter?: number;
  revokedAt?: number;
}

interface TrustedKey extends Omit<TrustedKeyInput, 'publicKeyPem' | 'roles'> { roles: readonly KeyRole[]; key: KeyObject }

export class TrustedKeyring {
  private readonly keys: ReadonlyMap<string, TrustedKey>;
  constructor(inputs: readonly TrustedKeyInput[]) {
    const map = new Map<string, TrustedKey>();
    for (const input of inputs) {
      if (!KEY_ID.test(input.keyId) || !PRINCIPAL_ID.test(input.principalId) || map.has(input.keyId)) throw new Error('trust: invalid or duplicate key id');
      if (!input.roles.length || input.roles.some((role) => !ROLES.includes(role))) throw new Error('trust: invalid key roles');
      let key: KeyObject;
      try {
        key = createPublicKey(input.publicKeyPem);
      } catch {
        throw new Error('trust: unreadable public key');
      }
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('trust: only ed25519 keys are accepted');
      for (const bound of [input.notBefore, input.notAfter, input.revokedAt]) {
        if (bound !== undefined && !Number.isFinite(bound)) throw new Error('trust: invalid validity bound');
      }
      map.set(input.keyId, Object.freeze({
        keyId: input.keyId, principalId: input.principalId, roles: Object.freeze([...input.roles]),
        notBefore: input.notBefore, notAfter: input.notAfter, revokedAt: input.revokedAt, key,
      }));
    }
    this.keys = map;
  }
  lookup(keyId: string): TrustedKey | undefined { return this.keys.get(keyId); }
  /** Distinct principals holding a key with `role` (for diagnostics only). */
  principalsWithRole(role: KeyRole): string[] {
    return [...new Set([...this.keys.values()].filter((k) => k.roles.includes(role)).map((k) => k.principalId))].sort();
  }
}

export interface SignedStatement<T = unknown> {
  domain: string;
  keyId: string;
  payload: T;
  /** base64 Ed25519 signature over the domain-separated canonical encoding. */
  signature: string;
}

const DOMAIN = /^[a-z][a-z0-9.:/_-]{2,63}$/;
const message = (domain: string, keyId: string, payload: unknown): Buffer => Buffer.from(PREFIX + canonicalJson({ domain, keyId, payload }), 'utf8');

/** Used by the runtime (and tests) that legitimately hold a private key. */
export function signStatement<T>(privateKeyPem: string, keyId: string, domain: string, payload: T): SignedStatement<T> {
  if (!DOMAIN.test(domain) || !KEY_ID.test(keyId)) throw new Error('trust: invalid domain or key id');
  const signature = sign(null, message(domain, keyId, payload), createPrivateKey(privateKeyPem)).toString('base64');
  return Object.freeze({ domain, keyId, payload, signature });
}

export type StatementVerdict<T> =
  | { ok: true; principalId: string; keyId: string; payload: T }
  | { ok: false; reason: string };

export function verifyStatement<T = unknown>(
  keyring: TrustedKeyring,
  statement: SignedStatement<T> | undefined,
  expect: { domain: string; role: KeyRole; now: number },
): StatementVerdict<T> {
  if (!statement || typeof statement !== 'object' || typeof statement.signature !== 'string' || typeof statement.keyId !== 'string') return { ok: false, reason: 'malformed statement' };
  if (statement.domain !== expect.domain) return { ok: false, reason: 'wrong domain' };
  const entry = keyring.lookup(statement.keyId);
  if (!entry) return { ok: false, reason: 'unknown key' };
  if (!entry.roles.includes(expect.role)) return { ok: false, reason: 'key lacks the required role' };
  if (entry.revokedAt !== undefined && expect.now >= entry.revokedAt) return { ok: false, reason: 'key revoked' };
  if (entry.notBefore !== undefined && expect.now < entry.notBefore) return { ok: false, reason: 'key not yet valid' };
  if (entry.notAfter !== undefined && expect.now > entry.notAfter) return { ok: false, reason: 'key expired' };
  let signature: Buffer;
  try {
    signature = Buffer.from(statement.signature, 'base64');
    if (signature.length !== 64) return { ok: false, reason: 'bad signature length' };
    if (!verify(null, message(statement.domain, statement.keyId, statement.payload), entry.key, signature)) return { ok: false, reason: 'signature mismatch' };
  } catch {
    return { ok: false, reason: 'unverifiable statement' };
  }
  return { ok: true, principalId: entry.principalId, keyId: entry.keyId, payload: statement.payload };
}

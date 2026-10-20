/**
 * Evidence capsule: an append-only, hash-linked journal of one run, plus signed receipts.
 *
 * A hash chain proves INTEGRITY only. Anyone who can rewrite the journal can recompute every link (audit F-05), and a
 * truncated prefix of a valid chain is itself a valid chain. AUTHENTICITY therefore comes from a receipt signed with an
 * `evidence-signer` key the runtime trusts (see trust.ts): the signature commits to the run id, the entry count, the root
 * hash and the artifact digest, so edits, truncation and substitution all break verification against that receipt.
 * An unsigned capsule must be reported as "integrity only", never as verified evidence.
 *
 * Design adapted from ECC `scripts/lib/eval-harness/{capsule,receipt}.js` (MIT, affaan-m/ECC at
 * b92f181b3b748d1abbc2afd94af6aa7d8c8fca29); reimplemented, not copied. Hashes use canonical JSON (key order independent).
 */
import { canonicalJson, hashValue, scanForSecrets, SHA256_PATTERN } from './canonical.ts';
import { signStatement, verifyStatement, type SignedStatement, type TrustedKeyring } from './trust.ts';

export const CAPSULE_SCHEMA = 'engineering-capsule/v2';
export const RECEIPT_SCHEMA = 'engineering-receipt/v2';
export const RECEIPT_DOMAIN = 'evidence.receipt/v1';
export const CAPSULE_KINDS = ['task', 'tool', 'verifier', 'review', 'decision', 'context'] as const;
export type CapsuleKind = typeof CAPSULE_KINDS[number];

const RUN_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const MAX_ENTRIES = 10_000;
const MAX_PAYLOAD_BYTES = 65_536;

export interface CapsuleEvent { seq: number; kind: CapsuleKind; payload: unknown; previousHash: string | null; hash: string }
export interface Capsule { schema: typeof CAPSULE_SCHEMA; runId: string; entries: readonly CapsuleEvent[]; rootHash: string | null }

const entryHash = (runId: string, e: Pick<CapsuleEvent, 'seq' | 'kind' | 'payload' | 'previousHash'>): string =>
  hashValue({ schema: CAPSULE_SCHEMA, runId, seq: e.seq, kind: e.kind, payload: e.payload, previousHash: e.previousHash });

export function newCapsule(runId: string): Capsule {
  if (!RUN_ID.test(runId)) throw new Error('capsule: invalid run id');
  return Object.freeze({ schema: CAPSULE_SCHEMA, runId, entries: Object.freeze([]), rootHash: null });
}

/** Appends one event. Payloads must be canonical-JSON representable, bounded and free of credentials. */
export function appendCapsuleEvent(c: Capsule, kind: CapsuleKind, payload: unknown): Capsule {
  // Appending checks only the link it extends (O(1)); re-hashing the whole chain on every append would be quadratic. Whole-chain
  // verification happens where authenticity is decided: verifyCapsule, receipt signing and receipt verification.
  const state = verifyTail(c);
  if (!state.ok) throw new Error(`capsule: refusing to extend invalid capsule (${state.reason})`);
  if (!CAPSULE_KINDS.includes(kind)) throw new Error('capsule: unknown event kind');
  if (c.entries.length >= MAX_ENTRIES) throw new Error('capsule: entry limit reached');
  if (Buffer.byteLength(canonicalJson(payload), 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('capsule: payload too large');
  const secrets = scanForSecrets(payload);
  if (secrets.length) throw new Error(`capsule: payload contains a credential (${secrets[0]!.canary})`);
  const material = { seq: c.entries.length, kind, payload, previousHash: c.rootHash };
  const event: CapsuleEvent = Object.freeze({ ...material, hash: entryHash(c.runId, material) });
  return Object.freeze({ ...c, entries: Object.freeze([...c.entries, event]), rootHash: event.hash });
}

function verifyTail(c: Capsule): { ok: boolean; reason: string } {
  if (!c || c.schema !== CAPSULE_SCHEMA || typeof c.runId !== 'string' || !RUN_ID.test(c.runId) || !Array.isArray(c.entries)) return { ok: false, reason: 'invalid metadata' };
  const last = c.entries.at(-1);
  if (!last) return c.rootHash === null ? { ok: true, reason: 'empty' } : { ok: false, reason: 'root mismatch' };
  try {
    if (last.seq !== c.entries.length - 1 || !CAPSULE_KINDS.includes(last.kind) || entryHash(c.runId, last) !== last.hash) return { ok: false, reason: 'entry digest mismatch' };
  } catch { return { ok: false, reason: 'unhashable entry' }; }
  return last.hash === c.rootHash ? { ok: true, reason: 'tail verified' } : { ok: false, reason: 'root mismatch' };
}

export function verifyCapsule(c: Capsule): { ok: boolean; reason: string } {
  if (!c || c.schema !== CAPSULE_SCHEMA || typeof c.runId !== 'string' || !RUN_ID.test(c.runId) || !Array.isArray(c.entries)) return { ok: false, reason: 'invalid metadata' };
  let prev: string | null = null;
  try {
    for (let i = 0; i < c.entries.length; i++) {
      const e = c.entries[i]!;
      if (e.seq !== i || e.previousHash !== prev || !CAPSULE_KINDS.includes(e.kind)) return { ok: false, reason: 'broken entry sequence' };
      if (entryHash(c.runId, e) !== e.hash) return { ok: false, reason: 'entry digest mismatch' };
      prev = e.hash;
    }
  } catch {
    return { ok: false, reason: 'unhashable entry' };
  }
  return prev === c.rootHash ? { ok: true, reason: 'verified' } : { ok: false, reason: 'root mismatch' };
}

export interface EvidenceReceipt {
  schema: typeof RECEIPT_SCHEMA;
  runId: string;
  rootHash: string | null;
  entries: number;
  artifactDigest: string | null;
}

function receiptOf(c: Capsule, artifactDigest: string | null): EvidenceReceipt {
  const verdict = verifyCapsule(c);
  if (!verdict.ok) throw new Error(`capsule: cannot receipt invalid evidence (${verdict.reason})`);
  if (artifactDigest !== null && !SHA256_PATTERN.test(artifactDigest)) throw new Error('capsule: invalid artifact digest');
  return { schema: RECEIPT_SCHEMA, runId: c.runId, rootHash: c.rootHash, entries: c.entries.length, artifactDigest };
}

/** The runtime signs the receipt with its `evidence-signer` key. Only code holding that private key can produce one. */
export function signCapsuleReceipt(privateKeyPem: string, keyId: string, c: Capsule, artifactDigest: string | null = null): SignedStatement<EvidenceReceipt> {
  return signStatement(privateKeyPem, keyId, RECEIPT_DOMAIN, receiptOf(c, artifactDigest));
}

export type ReceiptVerdict =
  | { ok: true; principalId: string; keyId: string; signedEntries: number }
  | { ok: false; reason: string };

/**
 * Verifies a signed receipt against a capsule on any machine that holds only the trusted public keys.
 * Fails on: unknown/revoked/expired key, a key without the evidence-signer role, forged or re-purposed signatures, a capsule
 * that is internally inconsistent, belongs to another run, was truncated below the signed count, differs from the signed
 * prefix, or advanced beyond it (stale receipt; sign a fresh one to cover new events).
 */
export function verifyCapsuleReceipt(keyring: TrustedKeyring, statement: SignedStatement<EvidenceReceipt> | undefined, c: Capsule, ctx: { now: number; artifactDigest?: string | null }): ReceiptVerdict {
  const signed = verifyStatement<EvidenceReceipt>(keyring, statement, { domain: RECEIPT_DOMAIN, role: 'evidence-signer', now: ctx.now });
  if (!signed.ok) return { ok: false, reason: signed.reason };
  const r = signed.payload;
  if (!r || r.schema !== RECEIPT_SCHEMA || typeof r.runId !== 'string' || !Number.isSafeInteger(r.entries) || r.entries < 0
    || (r.rootHash !== null && !SHA256_PATTERN.test(String(r.rootHash)))
    || (r.artifactDigest !== null && !SHA256_PATTERN.test(String(r.artifactDigest)))) return { ok: false, reason: 'malformed receipt' };
  const state = verifyCapsule(c);
  if (!state.ok) return { ok: false, reason: `capsule invalid: ${state.reason}` };
  if (r.runId !== c.runId) return { ok: false, reason: 'receipt belongs to another run' };
  if (c.entries.length < r.entries) return { ok: false, reason: 'capsule truncated below the signed entry count' };
  const rootAtReceipt = r.entries === 0 ? null : c.entries[r.entries - 1]!.hash;
  if (rootAtReceipt !== r.rootHash) return { ok: false, reason: 'capsule does not reproduce the signed root' };
  if (c.entries.length > r.entries) return { ok: false, reason: 'stale receipt: capsule advanced after signing' };
  if (ctx.artifactDigest !== undefined && ctx.artifactDigest !== r.artifactDigest) return { ok: false, reason: 'artifact digest mismatch' };
  return { ok: true, principalId: signed.principalId, keyId: signed.keyId, signedEntries: r.entries };
}

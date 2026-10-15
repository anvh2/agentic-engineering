/**
 * Canonical JSON, hashing and secret-canary scanning shared by every evidence and knowledge record.
 *
 * Adapted from the ideas in ECC `scripts/lib/eval-harness/canonical.js` and `envelope.js` (MIT, affaan-m/ECC at
 * b92f181b3b748d1abbc2afd94af6aa7d8c8fca29); reimplemented in TypeScript, not copied. Differences from the upstream:
 * values JSON cannot represent faithfully (NaN, Infinity, bigint, undefined in arrays, functions, symbols, cycles) are
 * REFUSED instead of being silently coerced to `null`, because a coerced value is a different value with the same hash.
 */
import { createHash } from 'node:crypto';

export const sha256Hex = (input: string | Uint8Array): string => createHash('sha256').update(input).digest('hex');
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const MAX_DEPTH = 32;

/** Recursively key-sorted, undefined-free copy. Throws on anything JSON cannot round-trip. */
export function canonicalize(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (depth > MAX_DEPTH) throw new Error('canonical: nesting too deep');
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonical: non-finite number');
      return value;
    case 'object':
      break;
    default:
      throw new Error(`canonical: unsupported ${typeof value}`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new Error('canonical: cycle');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((item) => {
      if (item === undefined) throw new Error('canonical: undefined array element');
      return canonicalize(item, depth + 1, seen);
    });
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) throw new Error('canonical: only plain objects are allowed');
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const item = (obj as Record<string, unknown>)[key];
      if (item === undefined) continue;
      // Keys are data (including "__proto__"): define, never assign through a setter.
      Object.defineProperty(out, key, { value: canonicalize(item, depth + 1, seen), enumerable: true, writable: true, configurable: true });
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
export const hashValue = (value: unknown): string => sha256Hex(canonicalJson(value));

/** Credentials must never enter a durable evidence record. A match anywhere in a string is a hard refusal. */
export const SECRET_CANARIES: readonly { readonly name: string; readonly pattern: RegExp }[] = Object.freeze([
  { name: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'openai_style_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'slack_token', pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'stripe_key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'bearer_header', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'env_assignment', pattern: /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)\s*=\s*\S{8,}/i },
]);

export interface SecretFinding { canary: string; path: string }

export function scanForSecrets(value: unknown, trail = '$', findings: SecretFinding[] = [], depth = 0): SecretFinding[] {
  if (depth > MAX_DEPTH) return findings;
  if (typeof value === 'string') {
    for (const canary of SECRET_CANARIES) if (canary.pattern.test(value)) findings.push({ canary: canary.name, path: trail });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecrets(item, `${trail}[${index}]`, findings, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      // The key itself can carry a secret just as well as the value.
      scanForSecrets(key, `${trail}.<key>`, findings, depth + 1);
      scanForSecrets(item, `${trail}.${key}`, findings, depth + 1);
    }
  }
  return findings;
}

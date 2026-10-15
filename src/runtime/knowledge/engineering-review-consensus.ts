/**
 * Deterministic aggregation of specialist review findings and independent verification of the severe ones.
 *
 * Reviewer prose is advisory. What this module adds on top of prose is IDENTITY: every finding and every verification is a
 * statement signed with a key from the runtime's `TrustedKeyring`, bound to one review id. Principal ids are taken from the
 * keyring, never from the statement, so a model that writes "verifierId: codex" in its output gains nothing (F-04). A model
 * cannot sign: the harness adapter that captured its output signs on the runtime's behalf.
 *
 * Rules enforced here, all fail-closed:
 *  - HIGH/CRITICAL findings need an independent verification before the review can approve;
 *  - a verifier must hold the `verifier` role and must not be any principal that authored (or co-authored) the finding;
 *  - any authenticated independent `confirmed` blocks, even if another verifier `refuted`;
 *  - an unauthenticated, malformed, expired, wrong-review or replayed-from-another-review statement is reported in `rejected`
 *    and the review cannot approve while any exist (a dropped finding must never look like a clean review).
 */
import { hashValue, scanForSecrets } from './canonical.ts';
import { verifyStatement, type SignedStatement, type TrustedKeyring } from './trust.ts';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type FindingRole = 'code' | 'language' | 'security' | 'tests' | 'reliability' | 'database' | 'docs' | 'performance';
export const FINDING_DOMAIN = 'review.finding/v1';
export const VERIFICATION_DOMAIN = 'review.verification/v1';

export interface FindingPayload { reviewId: string; role: FindingRole; path: string; severity: Severity; evidence: string; description: string }
export interface VerificationPayload { reviewId: string; findingKey: string; verdict: 'confirmed' | 'refuted' | 'inconclusive'; evidence: string }

export interface ConsolidatedFinding {
  key: string;
  path: string;
  evidence: string;
  severity: Severity;
  /** Authenticated principal ids (from the keyring) of everyone who reported this finding. */
  reviewerIds: readonly string[];
  roles: readonly FindingRole[];
  status: 'needs-verification' | 'advisory';
}
export interface RejectedStatement { index: number; reason: string }
export interface ReviewContext { keyring: TrustedKeyring; reviewId: string; now: number }

const RANK: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const ROLES: readonly string[] = ['code', 'language', 'security', 'tests', 'reliability', 'database', 'docs', 'performance'];
const REVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TEXT = 4000;

function validFinding(p: FindingPayload, reviewId: string): string | undefined {
  if (!p || typeof p !== 'object') return 'malformed payload';
  if (p.reviewId !== reviewId) return 'statement belongs to another review';
  if (!ROLES.includes(p.role) || !Object.hasOwn(RANK, p.severity)) return 'unknown role or severity';
  for (const text of [p.path, p.evidence, p.description]) if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return 'missing or oversized text';
  const path = p.path.replaceAll('\\', '/');
  if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\0')) return 'unsafe path';
  if (scanForSecrets(p).length) return 'statement contains a credential';
  return undefined;
}

export function consolidateReviewFindings(statements: readonly SignedStatement<FindingPayload>[], ctx: ReviewContext): { findings: readonly ConsolidatedFinding[]; rejected: readonly RejectedStatement[] } {
  if (!REVIEW_ID.test(ctx.reviewId)) throw new Error('review: invalid review id');
  const rejected: RejectedStatement[] = [];
  const groups = new Map<string, { payload: FindingPayload; principal: string }[]>();
  statements.forEach((statement, index) => {
    const verdict = verifyStatement<FindingPayload>(ctx.keyring, statement, { domain: FINDING_DOMAIN, role: 'reviewer', now: ctx.now });
    if (!verdict.ok) return void rejected.push({ index, reason: verdict.reason });
    const bad = validFinding(verdict.payload, ctx.reviewId);
    if (bad) return void rejected.push({ index, reason: bad });
    const p = verdict.payload;
    const key = hashValue([p.path.replaceAll('\\', '/'), p.evidence.trim().replace(/\s+/g, ' ')]);
    groups.set(key, [...(groups.get(key) ?? []), { payload: p, principal: verdict.principalId }]);
  });
  const findings = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const max = group.reduce((a, b) => (RANK[a.payload.severity] >= RANK[b.payload.severity] ? a : b)).payload;
    return Object.freeze({
      key, path: max.path.replaceAll('\\', '/'), evidence: max.evidence, severity: max.severity,
      reviewerIds: Object.freeze([...new Set(group.map((g) => g.principal))].sort()),
      roles: Object.freeze([...new Set(group.map((g) => g.payload.role))].sort()),
      status: RANK[max.severity] >= RANK.HIGH ? ('needs-verification' as const) : ('advisory' as const),
    });
  });
  return Object.freeze({ findings: Object.freeze(findings), rejected: Object.freeze(rejected) });
}

export interface ReviewDecision {
  canApprove: boolean;
  /** Findings an independent verifier confirmed. */
  blocking: readonly string[];
  /** Severe findings nobody independent has refuted or confirmed yet. */
  unresolved: readonly string[];
  /** Statements that failed authentication or validation. Any entry here blocks approval. */
  rejected: readonly RejectedStatement[];
}

export function decideReview(
  findings: readonly ConsolidatedFinding[],
  verifications: readonly SignedStatement<VerificationPayload>[],
  ctx: ReviewContext,
  priorRejected: readonly RejectedStatement[] = [],
): ReviewDecision {
  const rejected: RejectedStatement[] = [...priorRejected];
  const byKey = new Map<string, { principal: string; verdict: VerificationPayload['verdict'] }[]>();
  verifications.forEach((statement, index) => {
    const verdict = verifyStatement<VerificationPayload>(ctx.keyring, statement, { domain: VERIFICATION_DOMAIN, role: 'verifier', now: ctx.now });
    if (!verdict.ok) return void rejected.push({ index, reason: verdict.reason });
    const p = verdict.payload;
    if (!p || p.reviewId !== ctx.reviewId) return void rejected.push({ index, reason: 'statement belongs to another review' });
    if (!['confirmed', 'refuted', 'inconclusive'].includes(p.verdict) || typeof p.evidence !== 'string' || !p.evidence.trim() || p.evidence.length > MAX_TEXT || typeof p.findingKey !== 'string') return void rejected.push({ index, reason: 'malformed verification' });
    if (scanForSecrets(p).length) return void rejected.push({ index, reason: 'statement contains a credential' });
    byKey.set(p.findingKey, [...(byKey.get(p.findingKey) ?? []), { principal: verdict.principalId, verdict: p.verdict }]);
  });
  const blocking: string[] = [];
  const unresolved: string[] = [];
  for (const f of findings) {
    if (f.status === 'advisory') continue;
    const independent = (byKey.get(f.key) ?? []).filter((v) => !f.reviewerIds.includes(v.principal));
    if (independent.some((v) => v.verdict === 'confirmed')) blocking.push(f.key);
    else if (independent.some((v) => v.verdict === 'refuted')) continue;
    else unresolved.push(f.key);
  }
  return Object.freeze({ canApprove: !blocking.length && !unresolved.length && !rejected.length, blocking, unresolved, rejected });
}

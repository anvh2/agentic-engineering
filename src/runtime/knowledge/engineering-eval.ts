/**
 * Deterministic evaluation of bounded engineering providers and of ECC-derived mechanisms.
 *
 * Evaluators ingest RUNTIME-SIGNED trial evidence, never model- or caller-reported success. A trial counts as accepted only
 * when it is derived from: a passing runtime verifier, an `accepted` verdict from a reviewer who is a DIFFERENT principal
 * from the worker, and no security violation. The `accepted` flag is computed here; it cannot be asserted (audit F-09).
 *
 * Nothing in this module launches a provider or executes a command. Fixture verifier commands are validated against the
 * language adapter ceiling so a manifest can never smuggle in an uncontrolled command; the runtime verifier still re-validates
 * argv when a fixture is actually executed.
 *
 * Concepts adapted from ECC's `agent-eval` skill and `scripts/lib/eval-harness` (MIT, affaan-m/ECC at
 * b92f181b3b748d1abbc2afd94af6aa7d8c8fca29): pinned fixtures, repeated trials, pass@k vs pass^k, receipts; reimplemented.
 */
import { LANGUAGE_ADAPTERS } from '../execution/language-adapters.ts';
import { JS_VERIFY_FLAGS } from '../execution/delegation.ts';
import { SHA256_PATTERN, scanForSecrets } from './canonical.ts';
import { signStatement, verifyStatement, type SignedStatement, type TrustedKeyring } from './trust.ts';

export const TRIAL_DOMAIN = 'eval.trial/v1';
export type Arm = 'baseline' | 'integrated';

/** What the runtime's evidence-signer attests for one trial. */
export interface TrialPayload {
  runId: string;
  arm: Arm;
  fixtureId: string;
  fixtureCommit: string;
  providerId: string;
  repetition: number;
  /** Exit status of the RUNTIME verifier, not of anything the worker said. */
  verifierPassed: boolean;
  reviewVerdict: 'accepted' | 'rejected' | 'none';
  workerPrincipal: string;
  reviewerPrincipal: string | null;
  securityViolation: boolean;
  /** The worker claimed success but the verifier or reviewer disagreed. */
  falsePass: boolean;
  elapsedMs: number;
  attempts: number;
  inferenceCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Bytes of engineering context injected into the prompt (skills, rules, ADRs). */
  contextBytes: number;
  /** Root hash of the run's evidence capsule, tying the trial to its journal. */
  capsuleRoot: string | null;
}

export interface Trial extends TrialPayload { accepted: boolean; signerPrincipal: string }
export type RejectedTrial = Readonly<{ index: number; reason: string }>;

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const nonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const nullableNonNegative = (v: unknown): boolean => v === null || nonNegative(v);

export function signTrial(privateKeyPem: string, keyId: string, payload: TrialPayload): SignedStatement<TrialPayload> {
  return signStatement(privateKeyPem, keyId, TRIAL_DOMAIN, payload);
}

function payloadProblem(p: TrialPayload): string | undefined {
  if (!p || typeof p !== 'object') return 'malformed trial';
  if (![p.runId, p.fixtureId, p.providerId, p.workerPrincipal].every((s) => typeof s === 'string' && ID.test(s))) return 'invalid identifier';
  if (p.arm !== 'baseline' && p.arm !== 'integrated') return 'invalid arm';
  if (typeof p.fixtureCommit !== 'string' || !/^[a-f0-9]{40}$/.test(p.fixtureCommit)) return 'invalid fixture commit';
  if (!Number.isSafeInteger(p.repetition) || p.repetition < 0 || !Number.isSafeInteger(p.attempts) || p.attempts < 1
    || !Number.isSafeInteger(p.inferenceCalls) || p.inferenceCalls < 0) return 'invalid counters';
  if (typeof p.verifierPassed !== 'boolean' || typeof p.securityViolation !== 'boolean' || typeof p.falsePass !== 'boolean') return 'invalid flags';
  if (!['accepted', 'rejected', 'none'].includes(p.reviewVerdict)) return 'invalid review verdict';
  if (p.reviewerPrincipal !== null && (typeof p.reviewerPrincipal !== 'string' || !ID.test(p.reviewerPrincipal))) return 'invalid reviewer';
  if (p.reviewVerdict !== 'none' && p.reviewerPrincipal === null) return 'review verdict without a reviewer';
  if (!nonNegative(p.elapsedMs) || !nonNegative(p.contextBytes) || !nullableNonNegative(p.inputTokens) || !nullableNonNegative(p.outputTokens) || !nullableNonNegative(p.costUsd)) return 'invalid measurements';
  if (p.capsuleRoot !== null && !SHA256_PATTERN.test(String(p.capsuleRoot))) return 'invalid capsule root';
  if (scanForSecrets(p).length) return 'trial contains a credential';
  return undefined;
}

/** The only definition of "accepted". Self-review never counts. */
export const isAccepted = (p: TrialPayload): boolean =>
  p.verifierPassed && p.reviewVerdict === 'accepted' && p.reviewerPrincipal !== null && p.reviewerPrincipal !== p.workerPrincipal && !p.securityViolation;

/**
 * Verifies and de-duplicates signed trials. Invalid, unsigned, mis-keyed, replayed or duplicated statements are REPORTED in
 * `rejected` (never silently dropped) and contribute nothing to any score.
 */
export function ingestTrials(statements: readonly SignedStatement<TrialPayload>[], keyring: TrustedKeyring, now: number): { trials: readonly Trial[]; rejected: readonly RejectedTrial[] } {
  const trials: Trial[] = [];
  const rejected: RejectedTrial[] = [];
  const seen = new Set<string>();
  statements.forEach((statement, index) => {
    const verdict = verifyStatement<TrialPayload>(keyring, statement, { domain: TRIAL_DOMAIN, role: 'evidence-signer', now });
    if (!verdict.ok) return void rejected.push({ index, reason: verdict.reason });
    const problem = payloadProblem(verdict.payload);
    if (problem) return void rejected.push({ index, reason: problem });
    const p = verdict.payload;
    const slot = JSON.stringify([p.arm, p.fixtureId, p.fixtureCommit, p.providerId, p.repetition]);
    if (seen.has(slot) || seen.has(`run:${p.runId}`)) return void rejected.push({ index, reason: 'duplicate or replayed trial' });
    seen.add(slot); seen.add(`run:${p.runId}`);
    trials.push(Object.freeze({ ...p, accepted: isAccepted(p), signerPrincipal: verdict.principalId }));
  });
  return Object.freeze({ trials: Object.freeze(trials), rejected: Object.freeze(rejected) });
}

/** P(at least one of k draws succeeds) given c successes in n trials (unbiased pass@k estimator). */
export function passAtK(n: number, c: number, k: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(c) || !Number.isSafeInteger(k) || n < 1 || c < 0 || c > n || k < 1 || k > n) throw new Error('eval: invalid pass@k arguments');
  if (n - c < k) return 1;
  let miss = 1;
  for (let i = 0; i < k; i++) miss *= (n - c - i) / (n - i);
  return 1 - miss;
}

/** P(all k draws succeed): the consistency metric. A flaky provider scores high pass@k and low pass^k. */
export function passPowK(n: number, c: number, k: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(c) || !Number.isSafeInteger(k) || n < 1 || c < 0 || c > n || k < 1 || k > n) throw new Error('eval: invalid pass^k arguments');
  if (c < k) return 0;
  let all = 1;
  for (let i = 0; i < k; i++) all *= (c - i) / (n - i);
  return all;
}

/** 95% Wilson score interval; honest about small samples. */
export function wilson95(successes: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 1 };
  const z = 1.96, p = successes / total, d = 1 + z * z / total;
  const centre = (p + z * z / (2 * total)) / d;
  const half = (z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))) / d;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface ProviderScore {
  providerId: string;
  arm: Arm;
  trials: number;
  accepted: number;
  firstAttemptAccepted: number;
  securityViolations: number;
  falsePasses: number;
  verificationFailures: number;
  escalations: number;
  acceptedRate: number;
  acceptedRateInterval: { low: number; high: number };
  firstAttemptRate: number;
  /** Averaged over fixtures, using k = `k`. Null when no fixture has k repetitions. */
  k: number;
  passAtK: number | null;
  passPowK: number | null;
  averageElapsedMs: number;
  averageInferenceCalls: number;
  averageContextBytes: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCostUsd: number | null;
  costPerAcceptedUsd: number | null;
  fixtures: readonly string[];
}

export function summarizeTrials(trials: readonly Trial[], options: { k?: number } = {}): readonly ProviderScore[] {
  const k = options.k ?? 1;
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('eval: invalid k');
  const groups = new Map<string, Trial[]>();
  for (const t of trials) {
    const key = JSON.stringify([t.providerId, t.arm]);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const sum = (rows: readonly Trial[], f: (t: Trial) => number | null): number | null => rows.some((t) => f(t) === null) ? null : rows.reduce((n, t) => n + f(t)!, 0);
  return Object.freeze([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => {
    const [providerId, arm] = JSON.parse(key) as [string, Arm];
    const accepted = rows.filter((t) => t.accepted).length;
    const first = rows.filter((t) => t.accepted && t.attempts === 1).length;
    const byFixture = new Map<string, Trial[]>();
    for (const t of rows) byFixture.set(t.fixtureId, [...(byFixture.get(t.fixtureId) ?? []), t]);
    const eligible = [...byFixture.values()].filter((v) => v.length >= k);
    const mean = (f: (n: number, c: number) => number): number | null =>
      eligible.length ? eligible.reduce((s, v) => s + f(v.length, v.filter((t) => t.accepted).length), 0) / eligible.length : null;
    const cost = sum(rows, (t) => t.costUsd);
    return Object.freeze({
      providerId, arm, trials: rows.length, accepted, firstAttemptAccepted: first,
      securityViolations: rows.filter((t) => t.securityViolation).length,
      falsePasses: rows.filter((t) => t.falsePass).length,
      verificationFailures: rows.filter((t) => !t.verifierPassed).length,
      escalations: rows.filter((t) => t.attempts > 1).length,
      acceptedRate: accepted / rows.length,
      acceptedRateInterval: wilson95(accepted, rows.length),
      firstAttemptRate: first / rows.length,
      k, passAtK: mean((n, c) => passAtK(n, c, k)), passPowK: mean((n, c) => passPowK(n, c, k)),
      averageElapsedMs: rows.reduce((n, t) => n + t.elapsedMs, 0) / rows.length,
      averageInferenceCalls: rows.reduce((n, t) => n + t.inferenceCalls, 0) / rows.length,
      averageContextBytes: rows.reduce((n, t) => n + t.contextBytes, 0) / rows.length,
      totalInputTokens: sum(rows, (t) => t.inputTokens), totalOutputTokens: sum(rows, (t) => t.outputTokens),
      totalCostUsd: cost, costPerAcceptedUsd: cost !== null && accepted > 0 ? cost / accepted : null,
      fixtures: Object.freeze([...byFixture.keys()].sort()),
    });
  }));
}

export interface RoutingPolicy {
  /** Providers the operator has authorized. A provider absent from this list is NEVER chosen, however well it scored. */
  authorizedProviders: readonly string[];
  minimumTrials: number;
  requireZeroSecurityViolations: boolean;
  maxCostPerAcceptedUsd?: number;
  arm?: Arm;
}

/** Advisory only: the scheduler, auth and capacity checks still decide. Returns null rather than falling back silently. */
export function chooseEvidenceBackedProvider(scores: readonly ProviderScore[], policy: RoutingPolicy): string | null {
  if (!Array.isArray(policy.authorizedProviders) || !Number.isSafeInteger(policy.minimumTrials) || policy.minimumTrials < 1
    || (policy.maxCostPerAcceptedUsd !== undefined && !nonNegative(policy.maxCostPerAcceptedUsd))) throw new Error('eval: invalid routing policy');
  const arm = policy.arm ?? 'baseline';
  const eligible = scores.filter((s) => s.arm === arm && policy.authorizedProviders.includes(s.providerId) && s.trials >= policy.minimumTrials && s.accepted > 0
    && s.falsePasses === 0
    && (!policy.requireZeroSecurityViolations || s.securityViolations === 0)
    && (policy.maxCostPerAcceptedUsd === undefined || (s.costPerAcceptedUsd !== null && s.costPerAcceptedUsd <= policy.maxCostPerAcceptedUsd)));
  eligible.sort((a, b) => b.acceptedRate - a.acceptedRate || b.firstAttemptRate - a.firstAttemptRate
    || (a.costPerAcceptedUsd ?? Infinity) - (b.costPerAcceptedUsd ?? Infinity) || a.averageElapsedMs - b.averageElapsedMs || a.providerId.localeCompare(b.providerId));
  return eligible[0]?.providerId ?? null;
}

const zeroScore = (providerId: string, arm: Arm, k: number): ProviderScore => Object.freeze({
  providerId, arm, trials: 0, accepted: 0, firstAttemptAccepted: 0, securityViolations: 0, falsePasses: 0, verificationFailures: 0, escalations: 0,
  acceptedRate: 0, acceptedRateInterval: wilson95(0, 0), firstAttemptRate: 0, k, passAtK: null, passPowK: null, averageElapsedMs: 0,
  averageInferenceCalls: 0, averageContextBytes: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, costPerAcceptedUsd: null, fixtures: Object.freeze([]),
});

export interface ComparisonPolicy {
  /** Minimum paired (fixture, repetition) observations before any verdict other than insufficient-evidence. */
  minPairs: number;
  /** Required absolute improvement in accepted rate to adopt. */
  minAcceptedRateGain: number;
  /** Maximum tolerated cost-per-accepted ratio (integrated / baseline). */
  maxCostRatio: number;
  /** Maximum tolerated growth of injected context, as a ratio of the baseline (applies when the baseline injects any context). */
  maxContextRatio: number;
  /** Absolute cap on injected context bytes per task. This is what bounds a baseline of zero, where a ratio is undefined. */
  maxContextBytes: number;
  /** Largest tolerated DROP in accepted rate. 0 means any regression rejects, whatever else improved. */
  maxAcceptedRateDrop: number;
}
export interface ArmComparison {
  providerId: string;
  pairs: number;
  baseline: ProviderScore;
  integrated: ProviderScore;
  acceptedRateDelta: number;
  firstAttemptRateDelta: number;
  costRatio: number | null;
  contextRatio: number | null;
  verdict: 'adopt' | 'reject' | 'insufficient-evidence';
  reasons: readonly string[];
}

/**
 * Promotion gate from docs/plans/ecc-selective-integration.md: no security regression and no false PASS; at least one
 * predeclared effectiveness metric improves; cost and context stay within tolerance; enough paired observations.
 * Only observations present in BOTH arms are compared, so an arm that dropped hard fixtures cannot look better.
 */
export function compareArms(trials: readonly Trial[], policy: ComparisonPolicy, options: { k?: number } = {}): readonly ArmComparison[] {
  if (!Number.isSafeInteger(policy.minPairs) || policy.minPairs < 1 || !nonNegative(policy.minAcceptedRateGain) || !nonNegative(policy.maxCostRatio) || !nonNegative(policy.maxContextRatio)
    || !nonNegative(policy.maxContextBytes) || !nonNegative(policy.maxAcceptedRateDrop) || policy.maxAcceptedRateDrop > 1) throw new Error('eval: invalid comparison policy');
  const slot = (t: Trial) => JSON.stringify([t.fixtureId, t.fixtureCommit, t.repetition]);
  const providers = [...new Set(trials.map((t) => t.providerId))].sort();
  return Object.freeze(providers.map((providerId) => {
    const rows = trials.filter((t) => t.providerId === providerId);
    const base = new Map(rows.filter((t) => t.arm === 'baseline').map((t) => [slot(t), t]));
    const paired = rows.filter((t) => t.arm === 'integrated' && base.has(slot(t)));
    const pairedSlots = new Set(paired.map(slot));
    const baseRows = [...base.values()].filter((t) => pairedSlots.has(slot(t)));
    const b = baseRows.length ? summarizeTrials(baseRows, options)[0]! : zeroScore(providerId, 'baseline', options.k ?? 1);
    const i = paired.length ? summarizeTrials(paired, options)[0]! : zeroScore(providerId, 'integrated', options.k ?? 1);
    const reasons: string[] = [];
    let verdict: ArmComparison['verdict'] = 'adopt';
    if (paired.length < policy.minPairs) { verdict = 'insufficient-evidence'; reasons.push(`only ${paired.length} paired observations, need ${policy.minPairs}`); }
    const rateDelta = paired.length ? i.acceptedRate - b.acceptedRate : 0;
    const firstDelta = paired.length ? i.firstAttemptRate - b.firstAttemptRate : 0;
    const bothCosts = b.costPerAcceptedUsd !== null && i.costPerAcceptedUsd !== null;
    const costRatio = paired.length && bothCosts && b.costPerAcceptedUsd! > 0 ? i.costPerAcceptedUsd! / b.costPerAcceptedUsd! : null;
    const ctxRatio = paired.length && b.averageContextBytes > 0 ? i.averageContextBytes / b.averageContextBytes : null;
    if (paired.length >= policy.minPairs) {
      if (i.securityViolations > b.securityViolations) reasons.push('security violations increased');
      if (i.falsePasses > b.falsePasses) reasons.push('false passes increased');
      // A gain elsewhere never buys back a regression in overall acceptance.
      if (rateDelta < -policy.maxAcceptedRateDrop) reasons.push(`accepted rate fell by ${(-rateDelta).toFixed(3)}`);
      if (ctxRatio !== null && ctxRatio > policy.maxContextRatio) reasons.push(`context grew ${ctxRatio.toFixed(2)}x`);
      if (i.averageContextBytes > policy.maxContextBytes) reasons.push(`context of ${Math.round(i.averageContextBytes)} bytes per task exceeds the cap of ${policy.maxContextBytes}`);
      if (bothCosts) {
        if (costRatio !== null && costRatio > policy.maxCostRatio) reasons.push(`cost per accepted task grew ${costRatio.toFixed(2)}x`);
        if (b.costPerAcceptedUsd === 0 && i.costPerAcceptedUsd! > 0) reasons.push('cost per accepted task grew from zero');
      } else if (!reasons.length) {
        // Unknown cost is not zero cost: an arm whose spend cannot be compared has not shown it is affordable.
        verdict = 'insufficient-evidence';
        reasons.push('cost per accepted task is unmeasured in at least one arm, so the cost gate cannot be evaluated');
      }
      if (!reasons.length && verdict === 'adopt' && rateDelta < policy.minAcceptedRateGain && firstDelta < policy.minAcceptedRateGain) reasons.push('no predeclared effectiveness metric improved');
      if (reasons.length && verdict !== 'insufficient-evidence') verdict = 'reject';
    }
    return Object.freeze({ providerId, pairs: paired.length, baseline: b, integrated: i, acceptedRateDelta: rateDelta, firstAttemptRateDelta: firstDelta, costRatio, contextRatio: ctxRatio, verdict, reasons: Object.freeze(reasons) });
  }));
}

/** A fixture manifest does not authorize a command: the runtime verifier still validates argv when it executes one. */
export interface EvalFixture {
  id: string;
  commit: string;
  language: 'go' | 'js';
  allowedFiles: readonly string[];
  expectedCriteria: readonly string[];
  /** Each entry is an argv array; validated against the adapter ceiling here and again by the runtime at execution. */
  verificationCommands: readonly (readonly string[])[];
}

/** `.`, `./...`, or a relative package path with an optional trailing `/...`; never absolute and never containing `..` segments. */
function goPackageAllowed(p: string): boolean {
  if (p === '.' || p === './...') return true;
  const base = p.endsWith('/...') ? p.slice(0, -4) : p;
  return /^[A-Za-z0-9_.\/-]+$/.test(base) && !base.startsWith('/') && base.split('/').every((part) => part !== '' && part !== '..');
}
/** A repo-relative `.go` file, or a directory (`.`, `./pkg`, `pkg/sub`): no absolute path, no `..`, no odd characters. */
function gofmtPathAllowed(p: string): boolean {
  if (p.startsWith('/') || p.split('/').includes('..') || !/^[A-Za-z0-9_.\/-]+$/.test(p)) return false;
  const last = p.split('/').filter(Boolean).at(-1) ?? '';
  return last === '.' || last.endsWith('.go') || !last.includes('.');
}

export function validateFixtureCommand(language: 'go' | 'js', argv: readonly string[]): string | undefined {
  const adapter = LANGUAGE_ADAPTERS[language];
  if (!adapter.enabled || !Array.isArray(argv) || argv.length < 2 || argv.some((a) => typeof a !== 'string' || a === '' || /[\u0000\n\r]/.test(a))) return 'invalid argv';
  if (!(adapter.policy.allowedVerificationBinaries as readonly string[]).includes(argv[0]!)) return `binary ${argv[0]} is not allow-listed`;
  if (language === 'js') {
    if (argv[1] !== '--no-install' || argv[2] !== 'jest') return 'js verifier must be npx --no-install jest';
    const rest = argv.slice(3);
    for (const a of rest.filter((x) => x.startsWith('-'))) if (!JS_VERIFY_FLAGS.has(a)) return `flag ${a} is not allow-listed`;
    const paths = rest.filter((x) => !x.startsWith('-'));
    if (!paths.length || paths.some((p) => p.startsWith('/') || p.split('/').includes('..'))) return 'js verifier needs repo-relative test paths';
    return undefined;
  }
  if (argv[0] === 'go') {
    if (argv[1] !== 'test') return 'go verifier must be go test';
    const rest = argv.slice(2);
    // Flags must be self-contained (-run=Name, never `-run Name`), so no argument can be mistaken for a package.
    const flags = rest.filter((x) => x.startsWith('-'));
    if (flags.some((f) => !/^-(?:v|race)$/.test(f) && !/^-run=[A-Za-z0-9_^$|()]+$/.test(f) && !/^-count=\d{1,3}$/.test(f) && !/^-timeout=\d{1,4}[smh]$/.test(f))) return 'go test flag is not allow-listed';
    const pkgs = rest.filter((x) => !x.startsWith('-'));
    if (!pkgs.length || !pkgs.every(goPackageAllowed)) return 'go package path is not allowed';
    return undefined;
  }
  if (argv[0] === 'gofmt') {
    // Check-only: -w would rewrite files, so only list (-l), diff (-d) and simplify (-s) are allowed, on repo-relative .go paths.
    const flags = argv.slice(1).filter((x) => x.startsWith('-')), paths = argv.slice(1).filter((x) => !x.startsWith('-'));
    if (flags.some((f) => !['-l', '-d', '-s'].includes(f))) return 'gofmt flag is not allow-listed (check-only: -l, -d, -s)';
    if (!paths.length || paths.some((p) => !gofmtPathAllowed(p))) return 'gofmt needs repo-relative .go files or directories';
    return undefined;
  }
  return 'unsupported go verifier';
}

export function validateFixtures(fixtures: readonly EvalFixture[]): void {
  const ids = new Set<string>();
  for (const f of fixtures) {
    if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(f.id) || ids.has(f.id) || !/^[a-f0-9]{40}$/.test(f.commit) || !['go', 'js'].includes(f.language)
      || !f.allowedFiles.length || !f.expectedCriteria.length || !Array.isArray(f.verificationCommands) || !f.verificationCommands.length
      || f.allowedFiles.some((p) => !p || p.startsWith('/') || p.split('/').includes('..') || p.includes('\\'))) throw new Error('eval: invalid fixture');
    for (const command of f.verificationCommands) {
      const problem = validateFixtureCommand(f.language, command);
      if (problem) throw new Error(`eval: invalid fixture ${f.id}: ${problem}`);
    }
    ids.add(f.id);
  }
}

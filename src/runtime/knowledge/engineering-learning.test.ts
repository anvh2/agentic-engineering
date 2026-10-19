import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_CANDIDATE_POLICY, DurableLearningLog, buildRollbackCandidate, calibrationReport, ingestOutcomes, lessonDigestOf, proposeCandidates, recommendActions, signOutcome, skillRunsFromOutcomes,
  type OutcomePayload,
} from './engineering-learning.ts';
import { skillHealth } from './engineering-skill-health.ts';
import { DurableEngineeringKnowledge, keyringPromotionAuthority } from './engineering-knowledge-store.ts';
import { EngineeringKnowledgeCatalog } from './engineering-knowledge.ts';
import { signStatement } from './trust.ts';
import { keyringOf, testIdentity } from './__testing__/keys.ts';
import { grantFor } from './__testing__/promotion.ts';

const signer = testIdentity('k-ev', 'runtime-evidence', ['evidence-signer']);
const promoter = testIdentity('k-pro', 'lead', ['promoter']);
const keyring = keyringOf(signer, promoter);
const LESSON = 'Wrap errors with %w and name the operation so callers can match with errors.Is.';
let n = 0;
const payload = (over: Partial<OutcomePayload> = {}): OutcomePayload => ({
  outcomeId: `o-${++n}`, projectId: 'proj-a', taskId: `task-${n}`, lessonText: LESSON, verdict: 'accepted', runtimeVerified: true,
  workerPrincipal: 'qwen-worker', reviewerPrincipal: 'codex-reviewer', capsuleRoot: randomBytes(32).toString('hex'), skills: [], at: 1_000, ...over,
});
const sign = (over: Partial<OutcomePayload> = {}) => signOutcome(signer.privateKeyPem, 'k-ev', payload(over));
const ingest = (...over: Partial<OutcomePayload>[]) => {
  const r = ingestOutcomes(over.map((o) => sign(o)), keyring, 1);
  assert.deepEqual(r.rejected, []);
  return r.outcomes;
};
const many = (count: number, over: Partial<OutcomePayload> = {}, reviewers = ['codex-reviewer']) =>
  ingest(...Array.from({ length: count }, (_, i) => ({ ...over, reviewerPrincipal: reviewers[i % reviewers.length]! })));

test('only runtime-signed, runtime-verified, independently reviewed outcomes become observations; everything else is reported', () => {
  const unsigned = { domain: 'learning.outcome/v1', keyId: 'k-ev', payload: payload(), signature: 'A'.repeat(86) + '==' };
  const wrongRole = signStatement(promoter.privateKeyPem, 'k-pro', 'learning.outcome/v1', payload());
  const wrongDomain = signStatement(signer.privateKeyPem, 'k-ev', 'eval.trial/v1', payload());
  const dupe = payload({ taskId: 'same-task' });
  const r = ingestOutcomes([
    unsigned as never, wrongRole as never, wrongDomain as never, undefined as never,
    sign({ runtimeVerified: false }), sign({ reviewerPrincipal: 'qwen-worker' }), sign({ lessonText: '' }), sign({ capsuleRoot: 'short' }), sign({ projectId: 'Proj A' }),
    sign({ lessonText: 'token ghp_' + 'a'.repeat(36) }), sign({ skills: [{ id: 'Bad Id', revision: 'v1' }] }),
    signOutcome(signer.privateKeyPem, 'k-ev', dupe), signOutcome(signer.privateKeyPem, 'k-ev', { ...dupe, outcomeId: 'o-other' }), sign(),
  ], keyring, 1);
  assert.equal(r.outcomes.length, 2);
  assert.deepEqual(r.rejected.map((x) => x.reason), [
    'signature mismatch', 'key lacks the required role', 'wrong domain', 'malformed statement',
    'outcome was not verified by the runtime', 'reviewer is the worker', 'invalid lesson text', 'invalid capsule root', 'invalid identifier',
    'outcome contains a credential', 'invalid skills', 'duplicate observation',
  ]);
});

test('the lesson digest ignores case and whitespace so the same lesson from different tasks groups together', () => {
  assert.equal(lessonDigestOf('Wrap  errors.'), lessonDigestOf('wrap errors.\n'));
  assert.notEqual(lessonDigestOf('Wrap errors.'), lessonDigestOf('Wrap errors!'));
});

test('a lesson becomes a candidate only with enough distinct verified tasks and a pessimistic confidence above the bar', () => {
  assert.deepEqual(proposeCandidates(many(4)), [], 'below the observation minimum');
  const five = proposeCandidates(many(5));
  assert.equal(five.length, 1);
  assert.equal(five[0]!.scope, 'project');
  assert.equal(five[0]!.entry.approved, false, 'a candidate is inactive');
  assert.equal(five[0]!.entry.projectId, 'proj-a');
  assert.ok(five[0]!.confidence > 0.55 && five[0]!.confidence < 1, 'confidence is a lower bound, never 1');
  const mixed = proposeCandidates(ingest(...Array.from({ length: 8 }, (_, i) => ({ verdict: i < 4 ? ('accepted' as const) : ('rejected' as const) }))));
  assert.deepEqual(mixed, [], 'half the verified outcomes failed review');
  const bigger = proposeCandidates(many(30))[0]!.confidence;
  assert.ok(bigger > five[0]!.confidence, 'more verified evidence raises the lower bound');
});

test('frequency never promotes: many claims without verified acceptance produce nothing', () => {
  const rejected = ingest(...Array.from({ length: 50 }, () => ({ verdict: 'rejected' as const })));
  assert.deepEqual(proposeCandidates(rejected), []);
});

test('candidates are deterministic regardless of input order and carry their evidence', () => {
  const outcomes = many(6);
  const a = proposeCandidates(outcomes), b = proposeCandidates([...outcomes].reverse());
  assert.deepEqual(a.map((c) => c.entry), b.map((c) => c.entry), 'same revision and source for the same evidence set');
  assert.equal(a[0]!.evidenceRoots.length, 6);
  // A project lesson's id is scoped to its project; only a global lesson's id is the bare digest.
  const idSeed = createHash('sha256').update(a[0]!.scope === 'project' ? `lesson-id/project/v1\n${a[0]!.projectIds[0]}\n${lessonDigestOf(LESSON)}` : `lesson-id/global/v1\n${lessonDigestOf(LESSON)}`).digest('hex');
  assert.equal(a[0]!.entry.id, `lesson-${idSeed.slice(0, 12)}`);
});

test('the same lesson from two projects gets two distinct candidate ids, so promoting one can never block or retire the other', () => {
  const out = proposeCandidates([...many(5, { projectId: 'proj-a' }), ...many(5, { projectId: 'proj-b' })]);
  const projectIds = out.filter((c) => c.scope === 'project').map((c) => c.entry.id);
  assert.equal(projectIds.length, 2);
  assert.equal(new Set(out.map((c) => c.entry.id)).size, out.length, 'no two candidates share an id');
  const again = proposeCandidates([...many(5, { projectId: 'proj-a' }), ...many(5, { projectId: 'proj-b' })].reverse());
  assert.deepEqual(again.map((c) => c.entry.id).sort(), out.map((c) => c.entry.id).sort(), 'ids are stable for the same evidence within a scope');
});

test('project isolation: one project\'s evidence never yields another project\'s candidate, and a single project never yields a global one', () => {
  const a = many(5, { projectId: 'proj-a' }), b = many(3, { projectId: 'proj-b' });
  const out = proposeCandidates([...a, ...b]);
  assert.deepEqual(out.map((c) => [c.scope, c.projectIds]), [['project', ['proj-a']]]);
  const log = new DurableLearningLog(new DatabaseSync(':memory:'));
  log.record([...a, ...b]);
  assert.equal(log.forProject('proj-a').length, 5);
  assert.equal(log.forProject('proj-b').length, 3);
  assert.deepEqual(log.forProject('proj-c'), []);
  assert.deepEqual(log.projects(), ['proj-a', 'proj-b']);
});

test('global scope needs several projects that each qualify AND more than one independent reviewer', () => {
  const sameReviewer = [...many(5, { projectId: 'proj-a' }), ...many(5, { projectId: 'proj-b' })];
  assert.deepEqual(proposeCandidates(sameReviewer).map((c) => c.scope), ['project', 'project'], 'two projects but one reviewer: not independent');
  const independent = [...many(5, { projectId: 'proj-a' }, ['codex-reviewer']), ...many(5, { projectId: 'proj-b' }, ['claude-reviewer'])];
  const out = proposeCandidates(independent);
  assert.deepEqual(out.map((c) => c.scope), ['project', 'project', 'global']);
  const global = out[2]!;
  assert.deepEqual(global.projectIds, ['proj-a', 'proj-b']);
  assert.equal(global.entry.projectId, undefined);
  assert.equal(global.entry.approved, false);
  const weakSecond = [...many(5, { projectId: 'proj-a' }, ['codex-reviewer']), ...many(2, { projectId: 'proj-b' }, ['claude-reviewer'])];
  assert.ok(!proposeCandidates(weakSecond).some((c) => c.scope === 'global'), 'the second project does not qualify alone');
});

test('the learning log is durable, idempotent, append-only and rejects a conflicting rewrite', () => {
  const db = new DatabaseSync(':memory:');
  const log = new DurableLearningLog(db);
  const outcomes = many(3);
  assert.deepEqual(log.record(outcomes), { written: 3, existing: 0 });
  assert.deepEqual(log.record(outcomes), { written: 0, existing: 3 });
  assert.throws(() => log.record([{ ...outcomes[0]!, verdict: 'rejected' }]), /conflicting outcome/);
  assert.equal(log.forProject('proj-a').length, 3);
  assert.throws(() => db.exec("UPDATE engineering_learning_outcomes SET project_id='x'"), /append only/);
  assert.throws(() => db.exec('DELETE FROM engineering_learning_outcomes'), /append only/);
  const batch = [...many(1), { ...outcomes[0]!, verdict: 'rejected' as const }];
  assert.throws(() => log.record(batch), /conflicting/);
  assert.equal(log.forProject('proj-a').length, 3, 'a failed batch wrote nothing');
});

test('confidence calibration shows whether stated confidence matches later reality', () => {
  const well = calibrationReport([...Array(9).fill({ confidence: 0.9, accepted: true }), { confidence: 0.9, accepted: false }, ...Array(5).fill({ confidence: 0.1, accepted: false }), { confidence: 0.1, accepted: true }]);
  assert.ok(well.brier! < 0.15);
  const high = well.bins.find((b) => b.high === 1)!;
  assert.deepEqual([high.count, high.observed], [10, 0.9]);
  const over = calibrationReport(Array.from({ length: 10 }, (_, i) => ({ confidence: 0.95, accepted: i < 3 })));
  assert.ok(over.brier! > 0.4, 'overconfident predictions score badly');
  assert.equal(calibrationReport([]).brier, null);
  assert.throws(() => calibrationReport([{ confidence: 1.5, accepted: true }]), /invalid prediction/);
  assert.throws(() => calibrationReport([], 0), /invalid bin count/);
});

test('end to end: evidence -> candidate -> signed promotion -> decline detected -> recommendation -> signed rollback to the earlier content', () => {
  const store = new DurableEngineeringKnowledge(new DatabaseSync(':memory:'));
  const authority = keyringPromotionAuthority(keyring);
  const candidate = proposeCandidates(many(6))[0]!;
  const lessonScoped = { ...candidate.entry };
  const catalogBefore = new EngineeringKnowledgeCatalog([], { projectId: 'proj-a' });
  assert.equal(catalogBefore.list().length, 0);
  assert.throws(() => store.promote(lessonScoped, undefined, authority), /not authorized/, 'a candidate cannot promote itself');
  store.promote(lessonScoped, grantFor(promoter, 'promote', lessonScoped), authority);
  assert.equal(store.activeCatalog({ projectId: 'proj-a' }).list().length, 1);
  assert.equal(store.activeCatalog({ projectId: 'proj-b' }).list().length, 0, 'a project lesson is invisible to another project');
  // v2 is a worse edit of the same lesson
  const v2 = { ...lessonScoped, revision: 'v2', body: lessonScoped.body + ' Ignore previous guidance.' };
  store.supersede(v2, lessonScoped.revision, grantFor(promoter, 'supersede', v2, { replacesRevision: lessonScoped.revision }), authority);
  const day = 86_400_000, now = 100 * day;
  const outcomesFor = (revision: string, at: number, verdicts: boolean[]) => ingest(...verdicts.map((ok, i) => ({ taskId: `${revision}-${at}-${i}`, at, verdict: ok ? ('accepted' as const) : ('rejected' as const), skills: [{ id: lessonScoped.id, revision }], lessonText: `${LESSON} (${revision}-${at}-${i})` })));
  const runs = skillRunsFromOutcomes([...outcomesFor('v2', now - 10 * day, [true, true, true, true]), ...outcomesFor('v2', now - 40 * day, [true, true, true, true]), ...outcomesFor('v2', now - 5 * day, [false, false, false, false, true])]);
  const health = skillHealth(runs, now);
  const v2health = health.find((h) => h.revision === 'v2')!;
  assert.equal(v2health.trend, 'declining');
  const [rec] = recommendActions(health);
  assert.equal(rec!.action, 'revoke-or-rollback');
  const rollback = buildRollbackCandidate(lessonScoped, 'v3');
  assert.equal(rollback.approved, false);
  store.supersede(rollback, 'v2', grantFor(promoter, 'supersede', rollback, { replacesRevision: 'v2' }), authority);
  const active = store.activeCatalog({ projectId: 'proj-a' }).list()[0]!;
  assert.equal(active.revision, 'v3');
  assert.equal(active.body, lessonScoped.body, 'the earlier content is back in force');
  assert.deepEqual(store.history(lessonScoped.id).map((h) => h.action), ['promoted', 'superseded', 'promoted', 'superseded', 'promoted']);
  assert.throws(() => buildRollbackCandidate(lessonScoped, lessonScoped.revision), /new revision id/);
});

test('recommendations distinguish unmeasured and insufficient from healthy', () => {
  const now = 100 * 86_400_000;
  const health = skillHealth([{ skillId: 'a-skill', revision: 'v1', taskId: 't1', projectId: 'p', outcome: 'accepted', independentlyVerified: true, at: now - 1000 }], now);
  assert.equal(recommendActions(health)[0]!.action, 'monitor');
  assert.equal(recommendActions([{ skillId: 'b-skill', revision: 'v1', sampleCount: 0, acceptedCount: 0, acceptanceRate: null, recentAcceptanceRate: null, priorAcceptanceRate: null, trend: 'unmeasured' }])[0]!.reason, 'no verified runs in the window: unmeasured, not healthy');
  assert.throws(() => proposeCandidates([], { ...DEFAULT_CANDIDATE_POLICY, minProjects: 1 }), /invalid candidate policy/);
});

/**
 * Reproductions of defects found in the ORIGINAL PR #53 head (103aa914). Each test asserts the INSECURE behaviour that
 * existed, so it passes on 103aa914 and is expected to FAIL once the defect is fixed. Kept only as audit evidence; it is not
 * part of `npm test` (the glob does not include docs/). Run: node --test docs/engineering/audit/repro-pr53-original.test.ts
 * against a checkout of 103aa914.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { DurableEngineeringKnowledge } from '../../../src/runtime/knowledge/engineering-knowledge-store.ts';
import { EngineeringKnowledgeCatalog, proposeLesson } from '../../../src/runtime/knowledge/engineering-knowledge.ts';
import { consolidateReviewFindings, decideReview } from '../../../src/runtime/knowledge/engineering-review-consensus.ts';
import { appendCapsuleEvent, newCapsule, verifyCapsule } from '../../../src/runtime/knowledge/engineering-capsule.ts';
import { inspectHook } from '../../../src/runtime/knowledge/engineering-hooks.ts';
import { summarizeTrials } from '../../../src/runtime/knowledge/engineering-eval.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const allow = { authorize: async () => ({ principalId: 'p', grantId: 'g' }) };
const lesson = (id: string, projectId: string) => proposeLesson({ id, projectId, body: 'body ' + id, outcomes: [{ taskId: 't', projectId, status: 'PASS', runtimeVerified: true, independentlyAccepted: true, evidenceHash: sha(id) }] });

test('F-02 revocation can be silently undone and audit rows rewritten', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new DurableEngineeringKnowledge(db);
  await store.promote(lesson('lesson-a', 'proj-a'), allow);
  await store.revoke('lesson-a', allow);
  db.exec("UPDATE engineering_knowledge SET revoked_at=NULL WHERE id='lesson-a'");           // trigger does not forbid this
  db.exec("UPDATE engineering_knowledge_events SET actor='someone-else', action='noop'");     // no UPDATE trigger on the audit log
  assert.equal(store.activeCatalog().resolve({ language: 'go', ids: ['lesson-a'] }).entries.length, 1);
});

test('F-03 a lesson promoted for project A is resolvable from project B', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new DurableEngineeringKnowledge(db);
  await store.promote(lesson('lesson-a', 'proj-a'), allow);
  assert.equal(store.activeCatalog().resolve({ language: 'go', ids: ['lesson-a'] }).entries.length, 1); // no project parameter exists at all
});

test('F-04 caller-asserted verifier identity clears a CRITICAL finding', () => {
  const f = consolidateReviewFindings([{ reviewerId: 'r1', role: 'security', evidence: 'x', path: 'a.go', severity: 'CRITICAL', description: 'bad' }]);
  const verdict = decideReview(f, [{ key: f[0]!.key, verifierId: 'codex', verdict: 'refuted', evidence: 'trust me' }], ['codex']);
  assert.equal(verdict.canApprove, true); // a plain string 'codex' is the only credential
});

test('F-05 hash chain is forgeable: an attacker recomputes the whole chain after editing history', () => {
  let c = newCapsule('run-1');
  c = appendCapsuleEvent(c, 'verifier', { exit: 1 });
  c = appendCapsuleEvent(c, 'review', { ok: false });
  let forged = newCapsule('run-1');
  forged = appendCapsuleEvent(forged, 'verifier', { exit: 0 });
  forged = appendCapsuleEvent(forged, 'review', { ok: true });
  assert.equal(verifyCapsule(forged).ok, true);
});

test('F-05b capsule hash depends on key order (non-canonical JSON)', () => {
  let a = newCapsule('run-2'); a = appendCapsuleEvent(a, 'tool', { a: 1, b: 2 });
  let b = newCapsule('run-2'); b = appendCapsuleEvent(b, 'tool', { b: 2, a: 1 });
  assert.notEqual(a.rootHash, b.rootHash);
});

test('F-06 promoting an unrelated lesson invalidates every previously pinned catalogDigest', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new DurableEngineeringKnowledge(db);
  await store.promote(lesson('lesson-a', 'proj-a'), allow);
  const before = store.activeCatalog().catalogDigest;
  await store.promote(lesson('lesson-b', 'proj-a'), allow);
  assert.notEqual(store.activeCatalog().catalogDigest, before);
});

test('F-07 a write-class tool event with no path passes the path allowlist', () => {
  const d = inspectHook({ sessionId: 's', seq: 0, phase: 'PreToolUse', taskId: 't', tool: 'writeFile' }, { taskId: 't', tools: ['writeFile'], paths: ['a.go'] });
  assert.equal(d.accepted, true);
});

test('F-09 evaluation trials are caller-asserted booleans with no evidence binding', () => {
  const [score] = summarizeTrials([{ fixtureId: 'f', fixtureCommit: 'a'.repeat(40), providerId: 'p', repetition: 0, accepted: true, independentReview: true, verifierPassed: true, securityViolation: false, elapsedMs: 1, attempts: 1, inputTokens: null, outputTokens: null, costUsd: null }]);
  assert.equal(score!.accepted, 1);
});

test('F-01 knowledge catalog has no production consumer (grep evidence in the findings register)', () => {
  assert.ok(new EngineeringKnowledgeCatalog([]).catalogDigest.length === 64);
});

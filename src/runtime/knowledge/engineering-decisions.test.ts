import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { routeTask } from '../execution/delegation.ts';
import { DECISION_DOMAIN, DurableDecisionLog, type DecisionAction, type DecisionGrant } from './engineering-decisions.ts';
import { pinAdr, type AdrRecord } from './engineering-continuity.ts';
import { signStatement } from './trust.ts';
import { keyringOf, testIdentity } from './__testing__/keys.ts';

const run = promisify(execFile);
const lead = testIdentity('k-lead', 'engineering-lead', ['promoter']);
const reviewer = testIdentity('k-rev', 'reviewer', ['reviewer']);
const keyring = keyringOf(lead, reviewer);
const adr = (id: string, revision: string, extra: Partial<AdrRecord> = {}): AdrRecord => ({
  id, revision, status: 'proposed', context: 'Workers share one checkout and collide.', decision: 'Isolate each worker in its own worktree.',
  alternatives: ['shared checkout', 'containers per task'], consequences: 'Needs worktree cleanup on failure.', sourceRef: `docs/adr/${id}.md`, ...extra,
});
const grant = (who: typeof lead, action: DecisionAction, record: AdrRecord, over: Partial<DecisionGrant> = {}) =>
  signStatement<DecisionGrant>(who.privateKeyPem, who.keyId, DECISION_DOMAIN, { action, id: record.id, revision: record.revision, digest: pinAdr(record).digest, nonce: randomBytes(12).toString('hex'), expiresAt: Date.now() + 60_000, ...over });
const open = () => new DurableDecisionLog(new DatabaseSync(':memory:'));

test('a record enters as proposed and is invisible to context until a signed grant accepts it', () => {
  const log = open();
  const a = adr('ADR-0001', 'r1');
  assert.throws(() => log.propose({ ...a, status: 'accepted' }), /enters the log as proposed/);
  log.propose(a);
  assert.equal(log.statusOf('ADR-0001', 'r1'), 'proposed');
  assert.equal(log.acceptedContext().text, '');
  assert.throws(() => log.accept('ADR-0001', 'r1', undefined, keyring), /not authorized/);
  assert.throws(() => log.accept('ADR-0001', 'r1', grant(reviewer, 'accept', a), keyring), /not authorized/, 'a reviewer key is not a promoter');
  assert.throws(() => log.accept('ADR-0001', 'r1', grant(lead, 'deprecate', a), keyring), /not authorized/, 'grant for another action');
  assert.throws(() => log.accept('ADR-0001', 'r1', grant(lead, 'accept', adr('ADR-0001', 'r1', { decision: 'Something else entirely.' })), keyring), /not authorized/, 'grant for different content');
  assert.throws(() => log.accept('ADR-0001', 'r1', grant(lead, 'accept', a, { expiresAt: 1 }), keyring), /not authorized/, 'expired');
  assert.equal(log.statusOf('ADR-0001', 'r1'), 'proposed');
  log.accept('ADR-0001', 'r1', grant(lead, 'accept', a), keyring);
  assert.equal(log.statusOf('ADR-0001', 'r1'), 'accepted');
  assert.match(log.acceptedContext().text, /Isolate each worker/);
  assert.deepEqual(log.history('ADR-0001').map((e) => [e.event, e.actor]), [['proposed', null], ['accepted', 'engineering-lead']]);
});

test('a grant is single-use and a revision can be accepted once', () => {
  const log = open();
  const a = adr('ADR-0001', 'r1');
  log.propose(a);
  const g = grant(lead, 'accept', a);
  log.accept('ADR-0001', 'r1', g, keyring);
  assert.throws(() => log.accept('ADR-0001', 'r1', g, keyring), /only a proposed revision/);
  const b = adr('ADR-0002', 'r1');
  log.propose(b);
  const stolen = grant(lead, 'accept', a);
  assert.throws(() => log.accept('ADR-0002', 'r1', stolen, keyring), /not authorized/, 'a grant for one record cannot accept another');
});

test('supersession is atomic: the new revision becomes the only accepted one, the old text remains readable', () => {
  const log = open();
  const v1 = adr('ADR-0001', 'r1'), v2 = adr('ADR-0001', 'r2', { decision: 'Isolate each worker in a container.', supersedes: 'ADR-0001@r1' });
  log.propose(v1); log.accept('ADR-0001', 'r1', grant(lead, 'accept', v1), keyring);
  log.propose(v2);
  assert.match(log.acceptedContext().text, /own worktree/, 'v1 stays in force until v2 is accepted');
  log.accept('ADR-0001', 'r2', grant(lead, 'accept', v2), keyring);
  assert.equal(log.statusOf('ADR-0001', 'r1'), 'superseded');
  assert.equal(log.statusOf('ADR-0001', 'r2'), 'accepted');
  const ctx = log.acceptedContext().text;
  assert.match(ctx, /in a container/);
  assert.doesNotMatch(ctx, /own worktree/);
  assert.deepEqual(log.history('ADR-0001').map((e) => `${e.revision}:${e.event}`), ['r1:proposed', 'r1:accepted', 'r2:proposed', 'r1:superseded', 'r2:accepted']);
});

test('a second accepted revision without a supersedes link, and supersession of a non-accepted record, are refused', () => {
  const log = open();
  const v1 = adr('ADR-0001', 'r1');
  log.propose(v1); log.accept('ADR-0001', 'r1', grant(lead, 'accept', v1), keyring);
  const rival = adr('ADR-0001', 'r2');
  log.propose(rival);
  assert.throws(() => log.accept('ADR-0001', 'r2', grant(lead, 'accept', rival), keyring), /already has accepted revision r1/);
  const orphan = adr('ADR-0003', 'r2', { supersedes: 'ADR-0003@r1' });
  log.propose(orphan);
  assert.throws(() => log.accept('ADR-0003', 'r2', grant(lead, 'accept', orphan), keyring), /unknown|not currently accepted/);
  assert.throws(() => log.propose(adr('ADR-0004', 'r1', { supersedes: 'ADR-0009@r1' })), /same decision/);
  assert.equal(log.statusOf('ADR-0001', 'r1'), 'accepted', 'a failed acceptance changed nothing');
});

test('deprecation removes a decision from context and needs its own grant', () => {
  const log = open();
  const a = adr('ADR-0001', 'r1');
  assert.throws(() => log.deprecate('ADR-0001', 'r1', grant(lead, 'deprecate', a), keyring), /unknown revision/);
  log.propose(a);
  assert.throws(() => log.deprecate('ADR-0001', 'r1', grant(lead, 'deprecate', a), keyring), /only an accepted/);
  log.accept('ADR-0001', 'r1', grant(lead, 'accept', a), keyring);
  log.deprecate('ADR-0001', 'r1', grant(lead, 'deprecate', a), keyring);
  assert.equal(log.acceptedContext().text, '');
  const again = adr('ADR-0001', 'r2');
  log.propose(again); log.accept('ADR-0001', 'r2', grant(lead, 'accept', again), keyring);
  assert.equal(log.statusOf('ADR-0001', 'r2'), 'accepted');
});

test('the database itself forbids rewriting or deleting decisions, events and links', () => {
  const db = new DatabaseSync(':memory:');
  const log = new DurableDecisionLog(db);
  const a = adr('ADR-0001', 'r1');
  log.propose(a); log.accept('ADR-0001', 'r1', grant(lead, 'accept', a), keyring); log.linkToTask('T-1', 'ADR-0001', 'r1');
  for (const sql of [
    "UPDATE engineering_decisions SET record_json='{}'", 'DELETE FROM engineering_decisions',
    "UPDATE engineering_decision_events SET event='proposed'", 'DELETE FROM engineering_decision_events',
    "UPDATE engineering_decision_links SET revision='r9'", 'DELETE FROM engineering_decision_links',
  ]) assert.throws(() => db.exec(sql), /immutable|append only|never deleted/, sql);
  assert.equal(log.statusOf('ADR-0001', 'r1'), 'accepted');
});

test('task traceability links only accepted revisions, pins the digest, and shows when a decision has moved on', () => {
  const log = open();
  const v1 = adr('ADR-0001', 'r1'), v2 = adr('ADR-0001', 'r2', { supersedes: 'ADR-0001@r1', decision: 'Use containers.' });
  log.propose(v1);
  assert.throws(() => log.linkToTask('T-1', 'ADR-0001', 'r1'), /only an accepted/);
  log.accept('ADR-0001', 'r1', grant(lead, 'accept', v1), keyring);
  log.linkToTask('T-1', 'ADR-0001', 'r1');
  log.linkToTask('T-1', 'ADR-0001', 'r1'); // idempotent
  assert.throws(() => log.linkToTask('../x', 'ADR-0001', 'r1'), /invalid task id/);
  assert.throws(() => log.linkToTask('T-1', 'ADR-0009', 'r1'), /unknown/);
  log.propose(v2); log.accept('ADR-0001', 'r2', grant(lead, 'accept', v2), keyring);
  assert.deepEqual(log.traceability('T-1'), [{ id: 'ADR-0001', revision: 'r1', digest: pinAdr(v1).digest, status: 'superseded' }]);
  assert.throws(() => log.linkToTask('T-1', 'ADR-0001', 'r2'), /already linked to a different revision/);
  assert.deepEqual(log.traceability('unknown-task'), []);
});

test('an accepted ADR is not an execution approval: it does not satisfy approvedDesign verification', async () => {
  const log = open();
  const a = adr('ADR-0001', 'r1');
  log.propose(a); log.accept('ADR-0001', 'r1', grant(lead, 'accept', a), keyring);
  const root = mkdtempSync(join(tmpdir(), 'adr-route-'));
  try {
    mkdirSync(join(root, 'calc'));
    writeFileSync(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    writeFileSync(join(root, 'calc', 'calc.go'), 'package calc\n');
    const git = (...args: string[]) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
    await git('init', '-q'); await git('add', '-A'); await git('commit', '-q', '-m', 'init');
    const contract = {
      taskId: 'A-1', objective: 'Implement it', allowedFiles: ['calc/calc.go'], contextFiles: [], acceptanceCriteria: ['passes'], verificationCommands: [['go', 'test', './calc']], constraints: ['tests are immutable'],
      approvedDesign: { hld: 'high level design text', lld: 'low level design text', approvalRef: 'ADR-0001@r1' },
    };
    const routed = await routeTask({ contract, assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'bounded' } } as never, root);
    assert.equal(routed.route, 'claude');
    assert.match(JSON.stringify(routed), /approved design rejected/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two connections on one database file serialize through the write lock and leave exactly one accepted revision (interleaved, not parallel)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adr-race-'));
  try {
    const file = join(dir, 'decisions.db');
    const a = new DurableDecisionLog(new DatabaseSync(file));
    const v1 = adr('ADR-0001', 'r1'), v2 = adr('ADR-0001', 'r2');
    a.propose(v1); a.propose(v2);
    const b = new DurableDecisionLog(new DatabaseSync(file));
    const outcomes = [0, 1].map((i) => {
      try { (i === 0 ? a : b).accept('ADR-0001', i === 0 ? 'r1' : 'r2', grant(lead, 'accept', i === 0 ? v1 : v2), keyring); return 'accepted'; } catch (e) { return (e as Error).message; }
    });
    assert.equal(outcomes.filter((o) => o === 'accepted').length, 1, JSON.stringify(outcomes));
    const accepted = ['r1', 'r2'].filter((rev) => a.statusOf('ADR-0001', rev) === 'accepted');
    assert.equal(accepted.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

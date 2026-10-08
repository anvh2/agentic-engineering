import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SchedulerStore, StoreError } from '../runtime/scheduler/store.ts';
import { makeStore, plan, tempDir, workerTask } from '../runtime/scheduler/test-helpers.ts';
import { takeOverEscalated } from './review.ts';
import { recoverRuntimeFailure } from './recovery.ts';

const claimOpts = (workerId: string) => ({ workerId, languages: ['js' as const], leaseMs: 60_000, maxActive: 3 });

/** a (maxClaims 1) fails at runtime having spent its only claim; b depends on a. */
function exhausted() {
  const store = makeStore();
  store.createBatch(plan('/r', [workerTask('a', { maxClaims: 1 }), workerTask('b', { dependsOn: ['a'] })]));
  store.promote();
  const c = store.claim(claimOpts('w'))!;
  store.transition('a', 'CODING', { actor: 'w', fence: c.fence });
  store.transition('a', 'RUNTIME_FAILURE', { actor: 'w', fence: c.fence, reason: 'model runtime failed', patch: { failureCategory: 'runtime_unavailable' } });
  store.promote();
  return store;
}

describe('audited recovery of an exhausted RUNTIME_FAILURE', () => {
  it('starts from the dead end the CLI could not leave: retry refused, dependents blocked', () => {
    const store = exhausted();
    assert.equal(store.requireTask('a').claims, 1);
    assert.equal(store.requireTask('b').state, 'BLOCKED');
    assert.equal(store.dependencyStatus(store.requireTask('b')).status, 'failed');
  });

  it('retry raises the budget, requeues the task, and releases its dependents', () => {
    const store = exhausted();
    const r = recoverRuntimeFailure(store, 'a', { actor: 'anvh', reason: 'model server was restarted; infrastructure fault, not the task', action: { kind: 'retry' } });
    assert.deepEqual([r.task.state, r.grantedClaims, r.task.spec.maxClaims, r.task.claims], ['READY', 1, 2, 1]);
    assert.equal(store.requireTask('b').state, 'BACKLOG', 'b waits for a again instead of staying blocked');
    assert.equal(store.dependencyStatus(store.requireTask('b')).status, 'waiting');
    assert.ok(store.claim(claimOpts('w2')), 'a can be claimed again');

    const row = store.requireTask('a');
    assert.equal(row.failureCategory, null);
    assert.equal(row.runtimeRequeues, 1);
    const log = store.events('a');
    assert.ok(log.some((e) => e.actor === 'anvh' && /claim budget raised 1 -> 2: model server was restarted/.test(e.reason ?? '')), 'the grant is in the audit log');
    assert.ok(log.some((e) => e.to === 'READY' && e.actor === 'anvh' && /runtime failure retried: model server/.test(e.reason ?? '')), 'the requeue is in the audit log');
    assert.deepEqual((row.artifacts.recoveries as { action: string; actor: string }[]).map((x) => [x.action, x.actor]), [['grant_claims', 'anvh'], ['retry', 'anvh']]);
  });

  it('escalate hands the task to the Lead, who can take it over; the dependents stay blocked', () => {
    const store = exhausted();
    const r = recoverRuntimeFailure(store, 'a', { reason: 'second model failure in a row', action: { kind: 'escalate' } });
    assert.deepEqual([r.task.state, r.task.failureCategory], ['ESCALATED', 'runtime_failure_escalated']);
    assert.equal(r.grantedClaims, 0);
    assert.equal(takeOverEscalated(store, 'a', 'Lead implements it').state, 'READY');
    assert.equal(store.requireTask('a').executor, 'claude');
  });

  it('does not grant a budget that is not spent, unless asked to; --grant N is explicit', () => {
    const store = makeStore();
    store.createBatch(plan('/r', [workerTask('a', { maxClaims: 3 })]));
    store.promote();
    const c = store.claim(claimOpts('w'))!;
    store.transition('a', 'CODING', { actor: 'w', fence: c.fence });
    store.transition('a', 'RUNTIME_FAILURE', { actor: 'w', fence: c.fence, reason: 'x' });
    const r = recoverRuntimeFailure(store, 'a', { reason: 'transient', action: { kind: 'retry' } });
    assert.deepEqual([r.grantedClaims, r.task.spec.maxClaims], [0, 3]);
    const again = makeStore();
    again.createBatch(plan('/r', [workerTask('a', { maxClaims: 3 })]));
    again.promote();
    const c2 = again.claim(claimOpts('w'))!;
    again.transition('a', 'CODING', { actor: 'w', fence: c2.fence });
    again.transition('a', 'RUNTIME_FAILURE', { actor: 'w', fence: c2.fence, reason: 'x' });
    assert.equal(recoverRuntimeFailure(again, 'a', { reason: 'give it more room', action: { kind: 'retry', grantClaims: 2 } }).task.spec.maxClaims, 5);
  });

  it('refuses without a reason, for tasks in other states, and past the hard claim limit', () => {
    const store = exhausted();
    assert.throws(() => recoverRuntimeFailure(store, 'a', { reason: '  ', action: { kind: 'retry' } }), /needs a reason/);
    assert.throws(() => recoverRuntimeFailure(store, 'b', { reason: 'x', action: { kind: 'retry' } }), /only a RUNTIME_FAILURE task/);
    assert.equal(store.requireTask('a').state, 'RUNTIME_FAILURE', 'refusals change nothing');
  });
});

describe('claim refunds and grants respect the hard limit', () => {
  it('grantClaims caps at the schema maximum and refuses a task already at it', () => {
    const store = makeStore();
    store.createBatch(plan('/r', [workerTask('a', { maxClaims: 10 })]));
    store.promote();
    for (let i = 0; i < 10; i++) {
      const c = store.claim(claimOpts('w'))!;
      store.transition('a', 'CODING', { actor: 'w', fence: c.fence });
      store.transition('a', 'RUNTIME_FAILURE', { actor: 'w', fence: c.fence, reason: 'x' });
      if (i < 9) store.transition('a', 'READY', { actor: 'h', reason: 'retry' });
    }
    assert.equal(store.requireTask('a').claims, 10);
    assert.throws(() => store.grantClaims('a', 1, 'h', 'r'), (e: unknown) => e instanceof StoreError && /hard limit is 10/.test(e.message));
  });
});

describe('lead recover (CLI)', () => {
  it('recovers through the real command and requires a reason', () => {
    const dir = tempDir('recover-cli-');
    const dbPath = join(dir, 'sched.db');
    const store = new SchedulerStore(dbPath);
    store.createBatch(plan('/r', [workerTask('a', { maxClaims: 1 })]));
    store.promote();
    const c = store.claim(claimOpts('w'))!;
    store.transition('a', 'CODING', { actor: 'w', fence: c.fence });
    store.transition('a', 'RUNTIME_FAILURE', { actor: 'w', fence: c.fence, reason: 'model runtime failed' });
    store.close();

    const lead = join(fileURLToPath(new URL('../../scripts/lead.ts', import.meta.url)));
    const run = (...args: string[]) => {
      try {
        return { code: 0, out: execFileSync('node', ['--disable-warning=ExperimentalWarning', lead, ...args], { env: { ...process.env, AGENTIC_SCHED_DB: dbPath, AGENTIC_SCHED_ROOT: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (err) {
        const e = err as { status: number; stderr: string };
        return { code: e.status, out: e.stderr };
      }
    };
    const noReason = run('recover', 'a');
    assert.equal(noReason.code, 1);
    assert.match(noReason.out, /--reason/);
    assert.match(run('retry', 'a').out, /lead recover a --reason/);
    const ok = run('recover', 'a', '--reason', 'host was asleep');
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /a -> READY \(claim budget raised by 1 to 2\)/);
    const after = new SchedulerStore(dbPath);
    try {
      assert.equal(after.requireTask('a').state, 'READY');
    } finally {
      after.close();
    }
  });
});

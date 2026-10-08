import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_LEASE_REFUNDS, StoreError, SchedulerStore } from './store.ts';
import { makeRepo, makeStore, plan, tempDir, workerTask } from './test-helpers.ts';
import { TASK_STATES, TRANSITIONS, canTransition } from './types.ts';

const claimOpts = (workerId: string, extra = {}) => ({ workerId, languages: ['js', 'go'], leaseMs: 1000, maxActive: 10, ...extra });

describe('state machine', () => {
  it('defines an edge list for every state, and DONE/CANCELLED are terminal', () => {
    for (const s of TASK_STATES) assert.ok(TRANSITIONS[s], s);
    assert.deepEqual(TRANSITIONS.DONE, []);
    assert.deepEqual(TRANSITIONS.CANCELLED, []);
    assert.equal(canTransition('REVIEW_PENDING', 'DONE'), false, 'review must not jump to DONE');
    assert.equal(canTransition('VERIFYING', 'APPROVED'), false, 'a worker cannot approve its own work');
  });

  it('rejects illegal transitions and records an audit event for legal ones', () => {
    const store = makeStore();
    store.createBatch(plan('/repo', [workerTask('a')]));
    assert.throws(() => store.transition('a', 'DONE', { actor: 't' }), (e: any) => e instanceof StoreError && e.code === 'illegal_transition');
    store.promote();
    const t = store.transition('a', 'CANCELLED', { actor: 'human', reason: 'no longer needed' });
    assert.equal(t.state, 'CANCELLED');
    const events = store.events('a');
    assert.deepEqual(events.map((e) => `${e.from}->${e.to}`), ['null->BACKLOG', 'BACKLOG->READY', 'READY->CANCELLED']);
    assert.equal(events.at(-1)!.reason, 'no longer needed');
    assert.throws(() => store.transition('a', 'READY', { actor: 't' }), /not allowed/);
  });

  it('enforces expectFrom (stale reads cannot clobber a newer state)', () => {
    const store = makeStore();
    store.createBatch(plan('/repo', [workerTask('a')]));
    store.promote();
    assert.throws(() => store.transition('a', 'CANCELLED', { actor: 't', expectFrom: 'BACKLOG' }), (e: any) => e.code === 'state_mismatch');
  });

  it('validates plans: unknown deps, cycles, duplicate ids, worker tasks without a request', () => {
    const store = makeStore();
    assert.throws(() => store.createBatch(plan('/r', [workerTask('a', { dependsOn: ['zzz'] })])), /unknown task zzz/);
    assert.throws(() => store.createBatch(plan('/r', [workerTask('a', { dependsOn: ['b'] }), workerTask('b', { dependsOn: ['a'] })])), /cycle/);
    assert.throws(() => store.createBatch(plan('/r', [workerTask('a'), workerTask('a')])), /duplicate task id/);
    assert.throws(() => store.createBatch(plan('/r', [{ id: 'x', title: 'x', executor: 'worker' }])), /needs a request/);
    assert.throws(() => store.createBatch(plan('/r', [{ id: 'x', title: 'x', executor: 'claude' }])), /needs a keptReason/);
    store.createBatch(plan('/r', [workerTask('ok')]));
    assert.throws(() => store.createBatch(plan('/r', [workerTask('ok2')])), /already exists/, 'plans are append-only per batch id');
  });
});

describe('dependencies, priority, ownership', () => {
  it('promotes only tasks whose dependencies are DONE and claims by priority', () => {
    const store = makeStore();
    store.createBatch(plan('/r', [workerTask('low', { priority: 10 }), workerTask('high', { priority: 90 }), workerTask('child', { priority: 99, dependsOn: ['low'] })]));
    const p = store.promote();
    assert.deepEqual(p.ready.sort(), ['high', 'low']);
    assert.equal(store.requireTask('child').state, 'BACKLOG');
    assert.equal(store.claim(claimOpts('w1'))!.task.id, 'high');
    assert.equal(store.claim(claimOpts('w2'))!.task.id, 'low');
    assert.equal(store.claim(claimOpts('w3')), undefined, 'child stays unclaimable until low is DONE');
  });

  it('never promotes on REVIEW_PENDING/APPROVED: a dependency must be integrated (DONE)', () => {
    const store = makeStore();
    store.createBatch(plan('/r', [workerTask('dep'), workerTask('child', { dependsOn: ['dep'] })]));
    store.promote();
    const c = store.claim(claimOpts('w'))!;
    store.transition('dep', 'CODING', { actor: 'w', fence: c.fence });
    store.transition('dep', 'VERIFYING', { actor: 'w', fence: c.fence });
    store.transition('dep', 'REVIEW_PENDING', { actor: 'w', fence: c.fence });
    store.transition('dep', 'APPROVED', { actor: 'lead' });
    store.promote();
    assert.equal(store.requireTask('child').state, 'BACKLOG');
    store.transition('dep', 'INTEGRATING', { actor: 'int' });
    store.transition('dep', 'DONE', { actor: 'int' });
    assert.deepEqual(store.promote().ready, ['child']);
  });

  it('blocks dependents of a failed dependency and unblocks them when it recovers', () => {
    const store = makeStore();
    store.createBatch(plan('/r', [workerTask('dep'), workerTask('child', { dependsOn: ['dep'] }), workerTask('grandchild', { dependsOn: ['child'] })]));
    store.promote();
    const c = store.claim(claimOpts('w'))!;
    store.transition('dep', 'ESCALATED', { actor: 'w', fence: c.fence, reason: 'exhausted' });
    assert.deepEqual(store.promote().blocked.sort(), ['child', 'grandchild'], 'blocking cascades through the whole chain');
    assert.equal(store.requireTask('child').failureCategory, 'dependency_failed');
    store.transition('dep', 'READY', { actor: 'human' });
    const p = store.promote();
    assert.ok(p.unblocked.includes('child'));
  });

  it('serializes tasks that own overlapping files until the first is integrated', () => {
    const store = makeStore();
    store.createBatch(plan('/r', [workerTask('a', { files: ['src/shared.js'] }), workerTask('b', { files: ['src/shared.js'] }), workerTask('c', { files: ['src/other.js'] })]));
    store.promote();
    assert.equal(store.claim(claimOpts('w1'))!.task.id, 'a');
    assert.equal(store.claim(claimOpts('w2'))!.task.id, 'c', 'b overlaps a, so the disjoint task is picked');
    assert.equal(store.claim(claimOpts('w3')), undefined);
  });

  it('respects worker language capability and maxActive and maxTasksPerBatch', () => {
    const store = makeStore();
    store.createBatch(plan('/r', [workerTask('go1', { files: ['a.go'] }), workerTask('js1'), workerTask('js2')]));
    store.promote();
    assert.equal(store.claim(claimOpts('w', { languages: ['js'] }))!.task.id, 'js1');
    assert.equal(store.claim(claimOpts('w', { languages: ['js'], maxActive: 1 })), undefined, 'maxActive counts leased tasks');
    assert.equal(store.claim(claimOpts('w', { languages: ['go'] }))!.task.id, 'go1');
    assert.equal(store.claim(claimOpts('w', { languages: ['js'], maxTasksPerBatch: 2 })), undefined, 'batch budget (2) already spent');
  });

  it('never claims claude-kept tasks', () => {
    const store = makeStore();
    store.createBatch(plan('/r', [{ id: 'k', title: 'k', executor: 'claude', keptReason: 'migration', ownedFiles: ['db.sql'] }]));
    store.promote();
    assert.equal(store.claim(claimOpts('w')), undefined);
  });
});

describe('atomic claims', () => {
  it('two connections racing for one READY task: exactly one wins', () => {
    const dir = tempDir();
    const path = join(dir, 's.db');
    const a = new SchedulerStore(path);
    const b = new SchedulerStore(path);
    a.createBatch(plan('/r', [workerTask('only')]));
    a.promote();
    const results = [a.claim(claimOpts('A')), b.claim(claimOpts('B'))];
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(a.requireTask('only').claims, 1);
    assert.equal(a.requireTask('only').claimEpoch, 1);
  });

  it('four OS processes draining 8 tasks: every task claimed exactly once', async () => {
    const dir = tempDir();
    const path = join(dir, 's.db');
    const store = new SchedulerStore(path);
    store.createBatch(plan('/r', Array.from({ length: 8 }, (_, i) => workerTask(`t${i}`))));
    store.promote();
    const child = join(fileURLToPath(new URL('.', import.meta.url)), 'claim-child.ts');
    const run = (id: string) =>
      new Promise<string[]>((resolve, reject) => {
        const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', child, path, id], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child ${id} exit ${code}: ${err}`))));
      });
    const won = (await Promise.all(['p1', 'p2', 'p3', 'p4'].map(run))).flat();
    assert.equal(won.length, 8);
    assert.equal(new Set(won).size, 8, `duplicate claims: ${won.join(',')}`);
    assert.ok(store.listTasks().every((t) => t.state === 'CLAIMED' && t.claims === 1));
  });
});

describe('leases and fencing', () => {
  it('an expired lease returns the task to READY; the stale worker can no longer write (fencing)', () => {
    let now = 1_000_000;
    const store = makeStore(() => now);
    store.createBatch(plan('/r', [workerTask('a')]));
    store.promote();
    const first = store.claim(claimOpts('w1', { leaseMs: 1000 }))!;
    store.transition('a', 'CODING', { actor: 'w1', fence: first.fence });
    now += 500;
    assert.equal(store.heartbeat('a', first.fence, 1000), true, 'heartbeat extends a live lease');
    assert.deepEqual(store.reapExpired().requeued, []);
    now += 2000; // worker died: no heartbeat
    assert.deepEqual(store.reapExpired().requeued, ['a']);
    assert.equal(store.requireTask('a').state, 'READY');
    assert.equal(store.heartbeat('a', first.fence, 1000), false);

    const second = store.claim(claimOpts('w2', { leaseMs: 1000 }))!;
    assert.equal(second.fence.epoch, 2);
    // the zombie worker finishes late: its write is rejected and the new owner's state is untouched
    assert.throws(() => store.transition('a', 'VERIFYING', { actor: 'w1', fence: first.fence }), (e: any) => e.code === 'stale_owner' || e.code === 'illegal_transition');
    assert.equal(store.requireTask('a').state, 'CLAIMED');
    assert.equal(store.requireTask('a').leaseOwner, 'w2');
  });

  it('lease expiry gives the claim back MAX_LEASE_REFUNDS times (a stalled host is not the task\'s fault), then the budget bounds requeues: RUNTIME_FAILURE', () => {
    let now = 1;
    const store = makeStore(() => now);
    store.createBatch(plan('/r', [workerTask('a', { maxClaims: 2 })]));
    store.promote();
    const expire = () => {
      assert.ok(store.claim(claimOpts('w', { leaseMs: 10 })));
      now += 100;
      return store.reapExpired();
    };
    for (let i = 1; i <= MAX_LEASE_REFUNDS; i++) {
      assert.deepEqual(expire().requeued, ['a']);
      const t = store.requireTask('a');
      assert.deepEqual([t.state, t.claims, t.artifacts.leaseExpiries], ['READY', 0, i], `refund ${i}`);
      assert.match(store.events('a').at(-1)!.reason ?? '', new RegExp(`claim refunded ${i}/${MAX_LEASE_REFUNDS}`));
    }
    // refunds are spent: expiries now count like any other claim
    assert.deepEqual(expire().requeued, ['a']);
    assert.equal(store.requireTask('a').claims, 1);
    assert.deepEqual(expire().exhausted, ['a']);
    const t = store.requireTask('a');
    assert.deepEqual([t.state, t.failureCategory, t.claims], ['RUNTIME_FAILURE', 'lease_expired', 2]);
    assert.equal(store.claim(claimOpts('w')), undefined);
  });

  it('a finished lease cannot be reaped: completion beats expiry', () => {
    let now = 1;
    const store = makeStore(() => now);
    store.createBatch(plan('/r', [workerTask('a')]));
    store.promote();
    const c = store.claim(claimOpts('w', { leaseMs: 10 }))!;
    store.transition('a', 'CODING', { actor: 'w', fence: c.fence });
    store.transition('a', 'VERIFYING', { actor: 'w', fence: c.fence });
    store.transition('a', 'REVIEW_PENDING', { actor: 'w', fence: c.fence });
    now += 1000;
    assert.deepEqual(store.reapExpired(), { requeued: [], exhausted: [] });
    assert.equal(store.requireTask('a').state, 'REVIEW_PENDING');
  });

  it('a completed task is never claimed again', () => {
    const store = makeStore();
    store.createBatch(plan('/r', [workerTask('a')]));
    store.promote();
    const c = store.claim(claimOpts('w'))!;
    for (const to of ['CODING', 'VERIFYING', 'REVIEW_PENDING'] as const) store.transition('a', to, { actor: 'w', fence: c.fence });
    for (const to of ['APPROVED', 'INTEGRATING', 'DONE'] as const) store.transition('a', to, { actor: 'x' });
    assert.equal(store.claim(claimOpts('w')), undefined);
    assert.throws(() => store.transition('a', 'READY', { actor: 'x' }), /not allowed/);
    assert.equal(store.requireTask('a').claims, 1);
  });
});

describe('persistence', () => {
  it('state survives closing and reopening the database (scheduler restart)', () => {
    const dir = tempDir();
    const path = join(dir, 's.db');
    const s1 = new SchedulerStore(path);
    s1.createBatch(plan(makeRepo(), [workerTask('a')]));
    s1.promote();
    const c = s1.claim(claimOpts('w1'))!;
    s1.recordRun('a', c.fence, 'mastra-run-1');
    s1.close();
    const s2 = new SchedulerStore(path);
    const t = s2.requireTask('a');
    assert.equal(t.state, 'CLAIMED');
    assert.equal(t.runId, 'mastra-run-1');
    assert.deepEqual(t.runIds, ['mastra-run-1']);
    assert.ok(s2.events('a').length >= 3);
  });
});

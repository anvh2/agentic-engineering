import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../runtime/scheduler/test-helpers.ts';
import { commandPolicyProblems, canonicalJson, linkDependencyPaths } from './exec.ts';
import { LIFECYCLE_PHASES, LIFECYCLE_TRANSITIONS, LifecycleError, type PinnedOracle } from './store.ts';
import { GOOD, harness } from './__testing__/fixture.ts';

const solutions = { pad: [GOOD.pad], title: [GOOD.title], describe: [GOOD.describe] };

describe('M8.5 lifecycle store', () => {
  it('phase changes go through one writer, are conditional on the observed phase, and final phases never change', async () => {
    const h = harness({ solutions });
    await h.pin();
    const lc = h.lifecycle;
    assert.equal(lc.require('obj1').phase, 'PINNED');
    assert.throws(() => lc.transition('obj1', 'ACCEPTED', { actor: 'x' }), (e: unknown) => e instanceof LifecycleError && e.code === 'illegal_transition', 'PINNED -> ACCEPTED is not an edge');
    assert.throws(() => lc.transition('obj1', 'EXECUTING', { actor: 'x', expectFrom: 'ACCEPTING' }), (e: unknown) => e instanceof LifecycleError && e.code === 'phase_mismatch');
    lc.transition('obj1', 'EXECUTING', { actor: 'x', expectFrom: 'PINNED' });
    lc.transition('obj1', 'CANCELLED', { actor: 'x', reason: 'stop' });
    for (const to of LIFECYCLE_PHASES) assert.throws(() => lc.transition('obj1', to, { actor: 'x' }), LifecycleError, `CANCELLED -> ${to}`);
    assert.deepEqual(LIFECYCLE_TRANSITIONS.ACCEPTED, []);
    assert.deepEqual(LIFECYCLE_TRANSITIONS.NOT_ACCEPTED, []);
    // ACCEPTED is reachable only from ACCEPTING
    for (const [from, to] of Object.entries(LIFECYCLE_TRANSITIONS)) if (to.includes('ACCEPTED')) assert.equal(from, 'ACCEPTING');
  });

  it('the audit trail is append-only, ordered, and survives a final phase', async () => {
    const h = harness({ solutions });
    await h.pin();
    h.lifecycle.transition('obj1', 'EXECUTING', { actor: 'a', expectFrom: 'PINNED', reason: 'go' });
    h.lifecycle.transition('obj1', 'CANCELLED', { actor: 'b', reason: 'stop' });
    h.lifecycle.audit('obj1', 'late', 'acceptance_discarded', 'late evidence after the end');
    const events = h.lifecycle.events('obj1');
    assert.deepEqual(events.map((e) => [e.kind, e.toPhase]), [['pin', 'PINNED'], ['phase', 'EXECUTING'], ['phase', 'CANCELLED'], ['acceptance_discarded', 'CANCELLED']]);
    assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq));
    assert.throws(() => h.lifecycle.authorize('obj1', { kind: 'repair', taskId: 'pad', actor: 'x', reason: 'r' }), /nothing can be authorized/);
  });

  it('adds its own tables only: the scheduler schema is untouched', async () => {
    const h = harness({ solutions });
    const tables = (h.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    assert.ok(tables.includes('objective_lifecycle') && tables.includes('objective_lifecycle_events'));
    const cols = (h.store.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('claim_epoch') && !cols.includes('phase'));
    const oracle: PinnedOracle = { dir: '/x', files: {}, commands: [], negativeControl: { mode: 'required' }, specHash: 'h', pinnedAt: 1, pinnedBy: 't' };
    assert.throws(() => h.lifecycle.create({ objectiveId: 'o', batchId: 'missing-batch', oracle, baseCommit: 'c', actor: 't' }), /FOREIGN KEY/, 'a lifecycle needs a real batch');
  });

  it('authorizations are bounded, per task root, spent one use at a time', async () => {
    const h = harness({ solutions });
    await h.pin();
    assert.throws(() => h.lifecycle.authorize('obj1', { kind: 'repair', taskId: 'pad', uses: 9, actor: 'x', reason: 'r' }), /1 to 3/);
    h.lifecycle.authorize('obj1', { kind: 'repair', taskId: 'pad', uses: 2, actor: 'op', reason: 'two tries' });
    assert.equal(h.lifecycle.consumeAuthorization('obj1', 'repair', 'title', 'x'), false);
    assert.equal(h.lifecycle.consumeAuthorization('obj1', 'repair', 'pad', 'x'), true);
    assert.equal(h.lifecycle.consumeAuthorization('obj1', 'repair', 'pad', 'x'), true);
    assert.equal(h.lifecycle.consumeAuthorization('obj1', 'repair', 'pad', 'x'), false);
  });

  it('the command policy allows toolchain argv only', () => {
    assert.deepEqual(commandPolicyProblems(['go', 'test', './...']), []);
    assert.deepEqual(commandPolicyProblems(['gofmt', '-l', '.']), []);
    assert.deepEqual(commandPolicyProblems(['npx', '--no-install', 'jest']), []);
    assert.deepEqual(commandPolicyProblems(['node', 'check.mjs']), []);
    for (const bad of [['sh', '-c', 'x'], ['bash'], ['curl', 'http://x'], ['git', 'push'], ['npx', 'jest'], ['node', '-e', '1'], ['go', 'run', 'x.go'], ['go', 'get', 'x'], []]) assert.ok(commandPolicyProblems(bad).length > 0, JSON.stringify(bad));
  });

  it('canonical JSON does not depend on key order', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 1, c: [2, { z: 1, y: 2 }] } }), canonicalJson({ a: { c: [2, { y: 2, z: 1 }], d: 1 }, b: 1 }));
  });

  it('dependency directories are linked into exports like into worktrees, and only repo-relative ones', async () => {
    const repo = tempDir('lc-link-repo-');
    const tree = tempDir('lc-link-tree-');
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), '1');
    await linkDependencyPaths(repo, tree, ['node_modules', 'absent']);
    assert.equal(lstatSync(join(tree, 'node_modules')).isSymbolicLink(), true);
    await assert.rejects(linkDependencyPaths(repo, tree, ['../escape']), /without \.\./);
    await assert.rejects(linkDependencyPaths(repo, tree, ['/etc']), /repo-relative/);
  });
});

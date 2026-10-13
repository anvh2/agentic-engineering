import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ModelCapacity, holderRunId, permitHolder } from './model-capacity.ts';

/**
 * Run ownership of model permits (M10.1 F2). A task id is not an execution: the permit names the run that owns it, and a
 * cancel confirmation asks about that run only, failing closed when ownership cannot be read.
 */

const db = () => join(mkdtempSync(join(tmpdir(), 'run-ownership-')), 'cap.db');
const cap = (path: string, resource = 'ollama', options: { now?: () => number } = {}) => new ModelCapacity(path, { resource, permits: 4, ...options });

describe('permit holders name the run that owns them', () => {
  it('round-trips any run id, including ones with delimiters, spaces, percent signs and unicode', () => {
    for (const runId of ['run-1', 'r:1', 'r%3A1', 'a b/c', 'T', 'pid', 'fake:model', 'ünï', 'x'.repeat(200)]) {
      const holder = permitHolder({ label: 'gemini:pro', taskId: 'T', runId, pid: 42 });
      assert.equal(holderRunId(holder), runId, holder);
    }
  });

  it('without a run id the holder is the legacy format, whose owner nobody can establish', () => {
    assert.equal(permitHolder({ label: 'qwen', taskId: 'T', pid: 7 }), 'qwen:T:pid7');
    assert.equal(permitHolder({ label: 'qwen', taskId: 'T', runId: '', pid: 7 }), 'qwen:T:pid7');
    assert.equal(holderRunId('qwen:T:pid7'), undefined);
  });

  it('a marker that cannot be read is unknown ownership, never another run', () => {
    for (const holder of ['x:T:pid1:run=', 'x:T:pid1:run=%E0%A4%A', 'x:T:pid1:run=a:b', 'x:T:pid1:junk', 'x:T:pid1:run=%', 'no-pid-at-all', '']) {
      assert.equal(holderRunId(holder), undefined, JSON.stringify(holder));
    }
  });

  it('run ids that differ only by encoding stay different', () => {
    assert.notEqual(holderRunId(permitHolder({ label: 'x', taskId: 'T', runId: 'r:1', pid: 1 })), holderRunId(permitHolder({ label: 'x', taskId: 'T', runId: 'r%3A1', pid: 1 })));
  });
});

describe('engagedBy(tag, { runId })', () => {
  it('keeps this run\'s entries and unknown ones, drops other runs\', on every resource', async () => {
    const path = db();
    const codex = cap(path, 'codex');
    const gemini = cap(path, 'gemini');
    const probe = cap(path);
    const own = await codex.acquire(permitHolder({ label: 'c', taskId: 'T', runId: 'A' }), undefined, { tag: 'T' });
    const foreign = await gemini.acquire(permitHolder({ label: 'g', taskId: 'T', runId: 'B' }), undefined, { tag: 'T' });
    const legacy = await gemini.acquire('g:T:pid9', undefined, { tag: 'T' });
    const queued = gemini.enqueue(permitHolder({ label: 'g', taskId: 'T', runId: 'B' }), 'T');
    try {
      const mine = probe.engagedBy('T', { runId: 'A' });
      assert.deepEqual(mine.map((e) => [e.kind, e.run]), [['lease', 'A'], ['lease', undefined]], 'its own permit and the unreadable one; B\'s permit and B\'s queue entry are not its business');
      assert.deepEqual(probe.engagedBy('T', { runId: 'B' }).map((e) => [e.kind, e.run]), [['lease', 'B'], ['lease', undefined], ['waiter', 'B']]);
      assert.deepEqual(probe.engagedBy('T', { runId: 'C' }).map((e) => [e.kind, e.run]), [['lease', undefined]], 'a run that holds nothing is blocked only by the permit nobody can attribute');
      assert.equal(probe.engagedBy('T').length, 4, 'the task-level probe still sees everything');
      assert.equal(probe.engagedBy('OTHER', { runId: 'A' }).length, 0);
    } finally {
      own.release();
      foreign.release();
      legacy.release();
      gemini.withdraw(queued.ticket);
    }
  });

  it('an expired entry no longer counts, a renewed one still does (injected clock)', async () => {
    const path = db();
    const clock = { t: 1_000 };
    const owner = new ModelCapacity(path, { resource: 'gemini', permits: 2, leaseMs: 100, now: () => clock.t });
    const probe = cap(path, 'ollama', { now: () => clock.t });
    const lease = owner.tryAcquire(permitHolder({ label: 'g', taskId: 'T', runId: 'A' }));
    assert.ok(lease);
    assert.equal(probe.engagedBy('T', { runId: 'A' }).length, 1);
    clock.t += 99;
    assert.equal(lease.renew(), true);
    clock.t += 99;
    assert.equal(probe.engagedBy('T', { runId: 'A' }).length, 1, 'renewed, so still live');
    clock.t += 2;
    assert.equal(probe.engagedBy('T', { runId: 'A' }).length, 0, 'not renewed since: expired');
  });
});

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * M10.1 ACCEPTANCE ORACLE v3 - pinned BEFORE any M10.1 implementation (see oracle.json for the hash, owner, reviewer, review
 * findings and the amendment lineage from v1 and v2). It states behaviour through public interfaces only and imports every module
 * under test dynamically, so on a baseline that lacks a feature each case fails by itself with a reason instead of the file
 * failing to load. The implementation may not edit this file; run-oracle.ts refuses to run it if its hash differs from oracle.json,
 * and also refuses a candidate whose pre-existing safety contract tests (oracle.json `protectedFiles`) were edited.
 *
 *   O-F2  run-scoped permit ownership: a cancel is confirmed against THE TARGET RUN, and never reports STOPPED while that run's
 *         permit or process may still be active. A permit whose owner cannot be established fails closed.
 *   O-SA  execution, integration and acceptance are separate facts; a reverted implementation is never currently accepted,
 *         neither as a task nor as an objective.
 *   O-PR  promotion can be scoped to one objective (batch) without touching unrelated objectives.
 *   O-FP / O-SM / O-RL  carried from v2 (fault points, deterministic HTTP smoke timeouts, reliability runner). The only changes are
 *         the budget of the "spawned, not ready" case and the evidence the lease-isolation scenario must carry.
 *
 * NORMATIVE CONTRACT (what an implementation must satisfy; the cases below are its executable form):
 *   F2-a  runCodingTask(task, { runId }) names the run that owns the permits and queue entries it takes, for every attempt and
 *         retry. The Mastra workflow passes the id of its own run. cancelTaskRun(...) confirms against the run it is cancelling.
 *   F2-b  A permit or queue entry owned by another run does not block this run's cancel confirmation.
 *   F2-c  A permit or queue entry that belongs to this run, or whose owner cannot be established (legacy, malformed), blocks it:
 *         the outcome is still_active, never stopped. Resource, provider and handle never decide ownership. Run ids are compared
 *         as whole values, never as substrings.
 *   F2-d  A run whose provider call outlived its abort keeps its permit until the call settles; the cancel is still_active until then.
 *   F2-e  An expired, un-renewed permit no longer blocks; a live one does. (Ownership lives IN the lease row, so a copy of the row
 *         is a copy of its owner. Case 10b alone pins the legacy holder syntax: `<label>:<taskId>:pid<digits>` followed by an
 *         optional `:run=<encodeURIComponent(runId)>`; anything else after the pid is unreadable ownership.)
 *   F2-f  engagedBy(tag) WITHOUT a run id keeps returning every permit and queue entry carrying the tag (the task-level probe).
 *   SA-a  store.recordRevert(taskId, {actor, reason, commit?}) appends a fact about a DONE task. It changes no task row and rewrites
 *         no event; it adds exactly one DONE->DONE event whose reason says "reverted". recordReinstatement(...) appends the
 *         opposing fact. Both are durable and refuse what they cannot honestly record (blank reason, task not DONE, already
 *         reverted / never reverted).
 *   SA-b  store.projection(taskId) -> { execution: {state, finishedAt}, integration: {state: 'integrated'|'reverted'|'not_integrated',
 *         history[{kind, actor, reason, commit, at}]}, accepted }. accepted is true only for a DONE task whose implementation is
 *         currently integrated.
 *   SA-c  A reverted dependency does not satisfy its dependents (dependencyStatus is not 'ready', nothing can claim the dependent);
 *         reinstatement restores them. Metrics count only implementations that are still integrated and report the revert.
 *   SA-d  An objective whose lifecycle phase is ACCEPTED keeps that recorded phase and events, but `lead lifecycle status` says that
 *         a required task has since been reverted, and acceptance cannot be run while a required task is reverted.
 *   PR-a  store.promote(actor, { batchId }) evaluates that batch and every task that depends on it, directly or transitively, and
 *         nothing else; an empty or unknown batch id is an error, never "global". promote() with no scope keeps its global behaviour.
 *         `lead plan` promotes only the batch it created.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const mod = (rel: string) => import(join(ROOT, rel));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- shared harness ---------------------------------------------------------------------------------------------------------------

const CASE = { timeout: 120_000 };
const timeoutAfter = (ms: number, what: string) =>
  new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms).unref();
  });
const waitFor = async (cond: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(15);
  }
};

const STUB = 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n';
const TEST_SRC = 'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif got := Double(3); got != 6 {\n\t\tt.Fatalf("Double(3) = %d, want 6", got)\n\t}\n}\n';

function makeRepo(): string {
  const root = tmp('m10-1-oracle-repo-');
  mkdirSync(join(root, 'calc'));
  writeFileSync(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
  writeFileSync(join(root, 'calc', 'calc.go'), STUB);
  writeFileSync(join(root, 'calc', 'calc_test.go'), TEST_SRC);
  return root;
}

const codingTask = (taskId: string) => ({
  taskId,
  objective: 'Implement Double',
  allowedFiles: ['calc/calc.go'],
  contextFiles: ['calc/calc_test.go'],
  acceptanceCriteria: ['TestDouble passes'],
  verificationCommands: [['go', 'test', '-count=1', './calc']],
  constraints: ['tests are immutable'],
});

interface LiveRun {
  /** Resolves when the runner returned (the run is over as far as the runner is concerned). */
  done: Promise<unknown>;
  /** Resolves once the model call has begun, i.e. the run holds its permit. */
  entered: Promise<void>;
  /** The cancellation the Mastra run's abort signal delivers. */
  abort(): void;
  /** Lets a call that ignores its abort end (a process finally exiting) or makes a blocked call fail fast. */
  release(): void;
  calls(): number;
  /** True once `onPermit` ran (the permit was really granted through capacity.acquire). */
  permitSeen(): boolean;
}

/**
 * One execution of the REAL runner against a model double that blocks until released. `honorAbort: false` is a provider process
 * that ignores the abort (the call outlives the cancellation). `onPermit` runs right after the permit is granted. `failFirst`
 * makes the first model call fail at once, so the runner's own runtime retry takes a SECOND permit for the same run.
 */
async function startRun(o: { taskId?: string; runId: string; capacity: unknown; honorAbort?: boolean; onPermit?: (abort: () => void) => void; failFirst?: boolean; label?: string }): Promise<LiveRun> {
  const { runCodingTask } = await mod('src/runtime/execution/coding-task-runner.ts');
  const ctl = new AbortController();
  let calls = 0;
  let permitSeen = false;
  let enter!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  let released = false;
  const rejecters: (() => void)[] = [];
  const worker = {
    async generate(_prompt: string, opts: { abortSignal?: AbortSignal }) {
      calls += 1;
      if (o.failFirst && calls === 1) throw new Error('transient model failure');
      enter();
      await new Promise<void>((_resolve, reject) => {
        if (released) return reject(new Error('model call released'));
        rejecters.push(() => reject(new Error('model call released')));
        if (o.honorAbort !== false) {
          if (opts.abortSignal?.aborted) return reject(new Error('aborted'));
          opts.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }
      });
      return { text: 'unreachable', finishReason: 'stop', steps: [{}] };
    },
  };
  // onPermit: act right after the permit is granted (a cancellation landing between the grant and the call)
  const capacity = o.onPermit
    ? new Proxy(o.capacity as object, {
        get(target, prop, receiver) {
          if (prop !== 'acquire') return Reflect.get(target, prop, receiver);
          return async (...a: unknown[]) => {
            const lease = await (target as { acquire(...a: unknown[]): Promise<unknown> }).acquire(...a);
            permitSeen = true;
            o.onPermit!(() => ctl.abort(new Error('cancelled right after the permit')));
            return lease;
          };
        },
      })
    : o.capacity;
  const done = runCodingTask(codingTask(o.taskId ?? 'T'), {
    repoRoot: makeRepo(),
    worker,
    capacity,
    runId: o.runId,
    signal: ctl.signal,
    modelLabel: o.label ?? 'fake:model',
    maxAttempts: 1,
    runtimeRetryDelayMs: 0,
    abortGraceMs: 100,
    modelTimeoutMs: 120_000,
  });
  done.catch(() => {});
  return {
    done,
    entered,
    abort: () => ctl.abort(new Error('cancelled by the oracle')),
    release: () => {
      released = true;
      for (const r of rejecters.splice(0)) r();
    },
    calls: () => calls,
    permitSeen: () => permitSeen,
  };
}

/** Waits for the run to hold its permit; fails with the run's own result if it ended first (never hangs). */
async function ready(run: LiveRun, what = 'the run to hold its model permit'): Promise<void> {
  await Promise.race([
    run.entered,
    run.done.then(
      (r) => {
        throw new Error(`${what}: the run ended before the model call: ${JSON.stringify(r).slice(0, 300)}`);
      },
      (e) => {
        throw new Error(`${what}: the run threw before the model call: ${(e as Error).message}`);
      },
    ),
    timeoutAfter(20_000, what),
  ]);
}

/** What the scheduler does: cancel ONE run of a task and confirm it against the machine-wide capacity probe. */
async function cancelRun(probe: unknown, o: { runId: string; taskId?: string; provider?: string; graceMs?: number }) {
  const { cancelTaskRun } = await mod('src/runtime/scheduler/cancel.ts');
  const { SchedulerStore } = await mod('src/runtime/scheduler/store.ts');
  const taskId = o.taskId ?? 'T';
  return cancelTaskRun({
    store: new SchedulerStore(':memory:'),
    executor: { cancel: async () => ({ run: 'terminal', runStatus: 'canceled' }) },
    capacity: probe,
    task: { id: taskId, runId: o.runId, spec: { request: o.provider ? { provider: o.provider, contract: { taskId } } : undefined } } as never,
    actor: 'oracle',
    reason: 'oracle',
    graceMs: o.graceMs ?? 250,
    pollMs: 20,
  });
}

async function handles(resources: string[], permits = 1) {
  const { capacityFor } = await mod('src/runtime/capacity/model-capacity.ts');
  const db = join(tmp('m10-1-oracle-cap-'), 'capacity.db');
  const by: Record<string, any> = {};
  for (const r of resources) by[r] = capacityFor({ resource: r, defaultPermits: permits }, db);
  return { db, by, probe: capacityFor(undefined, db) }; // probe = the scheduler's single machine-wide handle (the default resource)
}

const finish = async (...runs: LiveRun[]) => {
  for (const r of runs) {
    r.abort();
    r.release();
  }
  await Promise.all(runs.map((r) => r.done.catch(() => {})));
};

/** Every column of the live lease rows of a resource, as stored (ownership included, whatever columns the implementation has). */
function leaseRows(db: string, resource: string): Record<string, any>[] {
  const d = new DatabaseSync(db);
  try {
    return d.prepare('SELECT * FROM leases WHERE resource = ?').all(resource) as Record<string, any>[];
  } finally {
    d.close();
  }
}
/** Re-creates a lease row exactly (a holder that crashed: it never renews), with a new id and the given expiry. */
function replayLease(db: string, row: Record<string, any>, expiresAt: number): void {
  const copy: Record<string, any> = { ...row, id: randomUUID(), acquired_at: expiresAt - 1_000, expires_at: expiresAt };
  const cols = Object.keys(copy);
  const d = new DatabaseSync(db);
  try {
    d.exec('PRAGMA busy_timeout = 5000');
    d.prepare(`INSERT INTO leases (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => copy[c]));
  } finally {
    d.close();
  }
}

describe('O-F2 run-scoped permit ownership', () => {
  it('1. same task id, different runs: each run is confirmed against its own permit only', CASE, async () => {
    const { by, probe } = await handles(['codex', 'gemini']);
    const a = await startRun({ runId: 'run-A', capacity: by.codex });
    const b = await startRun({ runId: 'run-B', capacity: by.gemini });
    await Promise.all([ready(a), ready(b)]);
    try {
      const idle = await cancelRun(probe, { runId: 'run-C' });
      assert.equal(idle.outcome, 'stopped', `a run that holds nothing is not blocked by two other runs of the same task: ${JSON.stringify(idle)}`);
      const ra = await cancelRun(probe, { runId: 'run-A' });
      assert.equal(ra.outcome, 'still_active');
      assert.equal(ra.engaged.length, 1, 'exactly its own permit');
      const rb = await cancelRun(probe, { runId: 'run-B' });
      assert.equal(rb.outcome, 'still_active');
      assert.equal(rb.engaged.length, 1);
    } finally {
      await finish(a, b);
    }
    assert.equal((await cancelRun(probe, { runId: 'run-A' })).outcome, 'stopped', 'once the run is over its permit is gone');
  });

  it('2. same task id, different providers: a codex run does not block a gemini cancel, and the reverse', CASE, async () => {
    const { by, probe } = await handles(['codex', 'gemini']);
    const codex = await startRun({ runId: 'run-codex', capacity: by.codex, label: 'codex:gpt' });
    const gemini = await startRun({ runId: 'run-gemini', capacity: by.gemini, label: 'gemini:pro' });
    await Promise.all([ready(codex), ready(gemini)]);
    try {
      codex.abort();
      await codex.done;
      assert.equal((await cancelRun(probe, { runId: 'run-codex', provider: 'codex' })).outcome, 'stopped', 'the gemini run still holds its permit, which is not codex\'s');
      assert.equal((await cancelRun(probe, { runId: 'run-gemini', provider: 'gemini' })).outcome, 'still_active', 'the gemini run\'s own permit blocks its own confirmation');
    } finally {
      await finish(codex, gemini);
    }
    const again = await startRun({ runId: 'run-codex-2', capacity: by.codex });
    const other = await startRun({ runId: 'run-gemini-2', capacity: by.gemini });
    await Promise.all([ready(again), ready(other)]);
    try {
      other.abort();
      await other.done;
      assert.equal((await cancelRun(probe, { runId: 'run-gemini-2', provider: 'gemini' })).outcome, 'stopped', 'the reverse direction');
      assert.equal((await cancelRun(probe, { runId: 'run-codex-2', provider: 'codex' })).outcome, 'still_active');
    } finally {
      await finish(again, other);
    }
  });

  it('3. same task id, same provider: a sibling run\'s permit AND queue entry never block, a run\'s own always do', CASE, async () => {
    const { by, probe } = await handles(['gemini']);
    const a = await startRun({ runId: 'run-A', capacity: by.gemini });
    await ready(a);
    // B shares the resource and the task id and has to queue behind A (one permit)
    const b = await startRun({ runId: 'run-B', capacity: by.gemini });
    await waitFor(() => by.gemini.queue().length === 1, 'run B to be queued behind run A');
    try {
      // A and B's queue entry are both present now; each cancel sees only its own
      const ra = await cancelRun(probe, { runId: 'run-A', provider: 'gemini' });
      assert.equal(ra.outcome, 'still_active', 'A\'s own permit');
      assert.equal(ra.engaged.length, 1, `B's queue entry is not A's: ${JSON.stringify(ra.engaged)}`);
      assert.equal(ra.engaged[0].kind, 'lease');
      const idle = await cancelRun(probe, { runId: 'run-C', provider: 'gemini' });
      assert.equal(idle.outcome, 'stopped', `neither A's permit nor B's queue entry belongs to an idle run: ${JSON.stringify(idle)}`);
      const rb = await cancelRun(probe, { runId: 'run-B', provider: 'gemini' });
      assert.equal(rb.outcome, 'still_active', 'B\'s own queue entry is engaged');
      assert.equal(rb.engaged.length, 1, `A's permit is not B's: ${JSON.stringify(rb.engaged)}`);
      assert.equal(rb.engaged[0].kind, 'waiter');
      b.abort();
      await b.done;
      await waitFor(() => by.gemini.queue().length === 0, 'run B to leave the queue');
      const rb2 = await cancelRun(probe, { runId: 'run-B', provider: 'gemini' });
      assert.equal(rb2.outcome, 'stopped', `B left the queue; A's permit on the same resource and task id is not B's: ${JSON.stringify(rb2)}`);
    } finally {
      await finish(a, b);
    }
  });

  it('4. missing or default provider: a task with no provider is confirmed on its own permit, not a foreign one', CASE, async () => {
    const { by, probe } = await handles(['codex']);
    const own = await startRun({ runId: 'run-default', capacity: probe }); // no provider anywhere: the local model's resource
    const foreign = await startRun({ runId: 'run-codex', capacity: by.codex });
    await Promise.all([ready(own), ready(foreign)]);
    try {
      assert.equal((await cancelRun(probe, { runId: 'run-default' })).outcome, 'still_active', 'its own permit');
      assert.equal((await cancelRun(probe, { runId: 'run-default', provider: 'ollama' })).outcome, 'still_active', 'spelled out, the default provider is the same');
      own.abort();
      await own.done;
      const r = await cancelRun(probe, { runId: 'run-default' });
      assert.equal(r.outcome, 'stopped', `only a foreign codex permit remains: ${JSON.stringify(r)}`);
      assert.equal((await cancelRun(probe, { runId: 'run-codex', provider: 'codex' })).outcome, 'still_active');
    } finally {
      await finish(own, foreign);
    }
  });

  it('5. injected handle / resource mismatch can neither hide the target\'s permit nor adopt a foreign one', CASE, async () => {
    const { by, probe } = await handles(['codex', 'gemini']);
    const target = await startRun({ runId: 'run-T', capacity: by.codex }); // actually runs on codex ...
    const foreign = await startRun({ runId: 'run-F', capacity: by.gemini });
    await Promise.all([ready(target), ready(foreign)]);
    try {
      // ... although the task says it is a gemini task (mis-identified provider): the permit is still the target's
      const wrongProvider = await cancelRun(probe, { runId: 'run-T', provider: 'gemini' });
      assert.equal(wrongProvider.outcome, 'still_active', `a provider mismatch must not produce STOPPED: ${JSON.stringify(wrongProvider)}`);
      // a probe handle on yet another resource than either run still sees both
      const onGemini = await cancelRun(by.gemini, { runId: 'run-T', provider: 'codex' });
      assert.equal(onGemini.outcome, 'still_active');
      const onCodex = await cancelRun(by.codex, { runId: 'run-F', provider: 'gemini' });
      assert.equal(onCodex.outcome, 'still_active');
      // and a run that holds nothing is not blocked by either, whatever handle asks
      assert.equal((await cancelRun(by.codex, { runId: 'run-none', provider: 'codex' })).outcome, 'stopped');
      assert.equal((await cancelRun(by.gemini, { runId: 'run-none', provider: 'gemini' })).outcome, 'stopped');
    } finally {
      await finish(target, foreign);
    }
  });

  it('6. target permit still active: STOPPED is never reported, however terminal the run looks', CASE, async () => {
    const { by, probe } = await handles(['gemini']);
    const run = await startRun({ runId: 'run-T', capacity: by.gemini });
    await ready(run);
    try {
      const r = await cancelRun(probe, { runId: 'run-T', provider: 'gemini', graceMs: 300 });
      assert.equal(r.outcome, 'still_active');
      assert.match(r.detail, /model still engaged/);
    } finally {
      await finish(run);
    }
  });

  it('7. target process still active: a provider call that outlived its abort keeps the permit, and the cancel waits for it', CASE, async () => {
    const { by, probe } = await handles(['gemini']);
    const run = await startRun({ runId: 'run-T', capacity: by.gemini, honorAbort: false });
    await ready(run);
    run.abort();
    await Promise.race([run.done, timeoutAfter(20_000, 'the runner to give up on the unresponsive call')]);
    try {
      const r = await cancelRun(probe, { runId: 'run-T', provider: 'gemini', graceMs: 300 });
      assert.equal(r.outcome, 'still_active', `the "process" is still running: ${JSON.stringify(r)}`);
      setTimeout(() => run.release(), 60); // the process finally exits
      const later = await cancelRun(probe, { runId: 'run-T', provider: 'gemini', graceMs: 5_000 });
      assert.equal(later.outcome, 'stopped', `once the process is gone the cancel is confirmed: ${JSON.stringify(later)}`);
    } finally {
      await finish(run);
    }
  });

  it('8a. cancellation while queued for the permit: nothing is held, and no permit is taken later', CASE, async () => {
    const { by, probe } = await handles(['gemini']);
    const blocker = await startRun({ taskId: 'OTHER', runId: 'run-blocker', capacity: by.gemini });
    await ready(blocker);
    const queued = await startRun({ runId: 'run-Q', capacity: by.gemini });
    await waitFor(() => by.gemini.queue().length === 1, 'run Q to be queued');
    queued.abort();
    await queued.done;
    try {
      assert.equal(by.gemini.queue().length, 0, 'the cancelled run left the queue');
      assert.equal((await cancelRun(probe, { runId: 'run-Q', provider: 'gemini' })).outcome, 'stopped');
      blocker.abort();
      await blocker.done;
      await sleep(300); // the permit is free now: a cancelled run must not pick it up
      assert.equal(queued.calls(), 0, 'the cancelled run never reached the model');
      assert.deepEqual(probe.engagedBy('T'), [], 'and holds nothing');
    } finally {
      await finish(queued, blocker);
    }
  });

  it('8b. cancellation landing right after the permit is granted, before the call: the permit is released and the cancel is confirmed', CASE, async () => {
    const { by, probe } = await handles(['gemini']);
    const run = await startRun({ runId: 'run-S', capacity: by.gemini, onPermit: (abort) => abort() });
    await Promise.race([run.done, timeoutAfter(20_000, 'the run to end')]);
    assert.equal(run.permitSeen(), true, 'the permit really was granted through capacity.acquire (otherwise this case proves nothing)');
    assert.deepEqual(probe.engagedBy('T'), [], 'no permit leaks from the start window');
    assert.equal((await cancelRun(probe, { runId: 'run-S', provider: 'gemini' })).outcome, 'stopped');
  });

  it('9a. lease expiry: a crashed, un-renewed permit blocks while live and stops blocking when it expires', CASE, async () => {
    const { ModelCapacity } = await mod('src/runtime/capacity/model-capacity.ts');
    const db = join(tmp('m10-1-oracle-lease-'), 'capacity.db');
    const clock = { t: 1_000_000 };
    const live = new ModelCapacity(db, { resource: 'gemini', permits: 1 });
    const run = await startRun({ runId: 'run-X', capacity: live });
    await ready(run);
    const [row] = leaseRows(db, 'gemini'); // the lease row a REAL run of this id holds, exactly as stored
    assert.ok(row, 'the run holds a lease row');
    await finish(run);
    assert.equal(leaseRows(db, 'gemini').length, 0, 'released');
    replayLease(db, row, clock.t + 1_000); // the same holder, crashed: it will never renew
    const probe = new ModelCapacity(db, { resource: 'ollama', permits: 1, now: () => clock.t });
    assert.equal((await cancelRun(probe, { runId: 'run-X', provider: 'gemini', graceMs: 60 })).outcome, 'still_active', 'not expired yet: the model may still be running');
    clock.t += 1_001;
    assert.equal((await cancelRun(probe, { runId: 'run-X', provider: 'gemini', graceMs: 60 })).outcome, 'stopped', 'expired and never renewed: it no longer blocks');
  });

  it('9b. recovery: a re-run of the same task is not blocked by the previous run\'s stale permit, and the previous run still is', CASE, async () => {
    const { ModelCapacity } = await mod('src/runtime/capacity/model-capacity.ts');
    const db = join(tmp('m10-1-oracle-recover-'), 'capacity.db');
    const clock = { t: 5_000_000 };
    const live = new ModelCapacity(db, { resource: 'gemini', permits: 1 });
    const first = await startRun({ runId: 'run-1', capacity: live });
    await ready(first);
    const [row] = leaseRows(db, 'gemini');
    await finish(first);
    replayLease(db, row, clock.t + 1_000);
    const probe = new ModelCapacity(db, { resource: 'ollama', permits: 1, now: () => clock.t });
    assert.equal((await cancelRun(probe, { runId: 'run-2', provider: 'gemini', graceMs: 60 })).outcome, 'stopped', 'the retry is a different run');
    assert.equal((await cancelRun(probe, { runId: 'run-1', provider: 'gemini', graceMs: 60 })).outcome, 'still_active', 'the run that owned it is not confirmed while its lease is live');
    clock.t += 1_001;
    assert.equal((await cancelRun(probe, { runId: 'run-1', provider: 'gemini', graceMs: 60 })).outcome, 'stopped', 'and is once the stale lease has expired');
  });

  it('10. unknown or legacy ownership fails closed for every run, for permits and for queue entries', CASE, async () => {
    const { by, probe } = await handles(['codex']);
    const legacy = await by.codex.acquire('gpt:T:pid4242', undefined, { tag: 'T' }); // the pre-run-id holder format
    try {
      for (const runId of ['run-A', 'run-B']) {
        const r = await cancelRun(probe, { runId, provider: 'gemini', graceMs: 150 });
        assert.equal(r.outcome, 'still_active', `a permit of unknown ownership blocks ${runId}: ${JSON.stringify(r)}`);
        assert.equal(r.engaged.length, 1);
      }
    } finally {
      legacy.release();
    }
    assert.equal((await cancelRun(probe, { runId: 'run-A', provider: 'gemini' })).outcome, 'stopped');
    const ticket = by.codex.enqueue('gpt:T:pid4242', 'T'); // a legacy queue entry
    try {
      assert.equal((await cancelRun(probe, { runId: 'run-A', graceMs: 150 })).outcome, 'still_active', 'a queue entry of unknown ownership blocks too');
    } finally {
      by.codex.withdraw(ticket.ticket);
    }
  });

  it('10b. an unreadable ownership marker is unknown ownership, not "some other run" (pins the holder syntax, see the header)', CASE, async () => {
    const { by, probe } = await handles(['codex']);
    for (const holder of ['gpt:T:pid4242:run=', 'gpt:T:pid4242:run=%E0%A4%A', 'gpt:T:pid4242:run=run-A:extra', 'gpt:T:pid4242:junk']) {
      const lease = await by.codex.acquire(holder, undefined, { tag: 'T' });
      try {
        const r = await cancelRun(probe, { runId: 'run-A', provider: 'codex', graceMs: 120 });
        assert.equal(r.outcome, 'still_active', `${holder} must fail closed: ${JSON.stringify(r)}`);
        assert.equal(r.engaged.length, 1);
      } finally {
        lease.release();
      }
    }
    const ok = await by.codex.acquire('gpt:T:pid4242:run=run-Z', undefined, { tag: 'T' });
    try {
      assert.equal((await cancelRun(probe, { runId: 'run-A', provider: 'codex', graceMs: 120 })).outcome, 'stopped', 'a well-formed marker of ANOTHER run is foreign');
      assert.equal((await cancelRun(probe, { runId: 'run-Z', provider: 'codex', graceMs: 120 })).outcome, 'still_active', 'and of this run is its own');
    } finally {
      ok.release();
    }
  });

  it('11. the Mastra workflow carries its own run id into the permit it takes (scheduler -> workflow run -> capacity)', CASE, async () => {
    const { createCodingTaskWorkflow } = await mod('src/integrations/mastra/workflows/coding-task-workflow.ts');
    const db = join(tmp('m10-1-oracle-wf-'), 'capacity.db');
    const previous = process.env.AGENTIC_MODEL_LOCK_DB;
    process.env.AGENTIC_MODEL_LOCK_DB = db;
    const root = makeRepo();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: root });
    let enter!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const generate = async (_p: string, opts: { abortSignal?: AbortSignal }) => {
      enter();
      await new Promise<void>((_, reject) => opts.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return { text: '', finishReason: 'stop', steps: [{}] };
    };
    const workflow = createCodingTaskWorkflow({ resolveWorker: () => ({ generate }), artifactRoot: tmp('m10-1-oracle-wf-art-'), runOptions: { runtimeRetryDelayMs: 0 } });
    try {
      const run = await workflow.createRun({ runId: 'wf-run-X' });
      const pending = run.start({ inputData: { repository: root, contract: { ...codingTask('WF-F2'), verificationCommands: [['go', 'test', '-count=1', './...']] }, assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one function' } } as never });
      await Promise.race([entered, timeoutAfter(30_000, 'the workflow run to reach the model call')]);
      const { capacityFor } = await mod('src/runtime/capacity/model-capacity.ts');
      const probe = capacityFor(undefined, db);
      assert.equal((await cancelRun(probe, { taskId: 'WF-F2', runId: 'wf-run-Y', graceMs: 150 })).outcome, 'stopped', 'another run of the task is not blocked by this one');
      assert.equal((await cancelRun(probe, { taskId: 'WF-F2', runId: 'wf-run-X', graceMs: 150 })).outcome, 'still_active', 'this run\'s own permit carries this run\'s id');
      await run.cancel();
      await pending.catch(() => {});
      assert.equal((await cancelRun(probe, { taskId: 'WF-F2', runId: 'wf-run-X', graceMs: 5_000 })).outcome, 'stopped');
    } finally {
      if (previous === undefined) delete process.env.AGENTIC_MODEL_LOCK_DB;
      else process.env.AGENTIC_MODEL_LOCK_DB = previous;
    }
  });

  it('12. overlapping run ids never match each other (whole-value comparison, not substring or prefix)', CASE, async () => {
    const { by, probe } = await handles(['gemini'], 8);
    // ids that overlap on purpose: prefixes, a delimiter, and pieces of the holder itself (label "fake:model", task "T", "pid")
    const ids = ['run-1', 'run-10', 'r', 'r:1', 'fake', 'model', 'T', 'pid'];
    const runs = new Map<string, LiveRun>();
    for (const id of ids) runs.set(id, await startRun({ runId: id, capacity: by.gemini }));
    await Promise.all([...runs.values()].map((r) => ready(r)));
    try {
      for (const id of ids) {
        const r = await cancelRun(probe, { runId: id, provider: 'gemini', graceMs: 100 });
        assert.equal(r.outcome, 'still_active', id);
        assert.equal(r.engaged.length, 1, `run ${JSON.stringify(id)} sees only its own permit: ${JSON.stringify(r.engaged)}`);
      }
      for (const idle of ['run', 'run-', 'ru', '1', 'fake:model', 'T:pid', 'run=run-1', 'RUN-1']) {
        const r = await cancelRun(probe, { runId: idle, provider: 'gemini', graceMs: 100 });
        assert.equal(r.outcome, 'stopped', `${JSON.stringify(idle)} holds nothing: ${JSON.stringify(r.engaged)}`);
      }
      runs.get('run-1')!.abort();
      await runs.get('run-1')!.done;
      assert.equal((await cancelRun(probe, { runId: 'run-1', provider: 'gemini', graceMs: 100 })).outcome, 'stopped', 'run-1 is over although run-10 lives on');
      assert.equal((await cancelRun(probe, { runId: 'run-10', provider: 'gemini', graceMs: 100 })).outcome, 'still_active');
      runs.get('r:1')!.abort();
      await runs.get('r:1')!.done;
      assert.equal((await cancelRun(probe, { runId: 'r:1', provider: 'gemini', graceMs: 100 })).outcome, 'stopped');
      assert.equal((await cancelRun(probe, { runId: 'r', provider: 'gemini', graceMs: 100 })).outcome, 'still_active');
    } finally {
      await finish(...runs.values());
    }
  });

  it('13. the runner\'s own retry takes a second permit for the SAME run, and that permit carries the run id too', CASE, async () => {
    const { by, probe } = await handles(['gemini']);
    const run = await startRun({ runId: 'run-R', capacity: by.gemini, failFirst: true });
    await waitFor(() => run.calls() >= 2, 'the runner\'s retry to reach the model');
    await ready(run);
    try {
      assert.equal((await cancelRun(probe, { runId: 'run-other', provider: 'gemini', graceMs: 100 })).outcome, 'stopped', 'the retry\'s permit is not another run\'s');
      const own = await cancelRun(probe, { runId: 'run-R', provider: 'gemini', graceMs: 100 });
      assert.equal(own.outcome, 'still_active');
      assert.equal(own.engaged.length, 1);
    } finally {
      await finish(run);
    }
  });

  it('14. scheduler -> executor -> workflow: the run id the scheduler stores is the one that owns the permit, so a foreign run of the same task never blocks the scheduler\'s own cancel and an unattributable permit still does', CASE, async () => {
    const previous = process.env.AGENTIC_MODEL_LOCK_DB;
    try {
      for (const foreign of ['run', 'unmarked'] as const) {
        const db = join(tmp('m10-1-oracle-sched-'), 'capacity.db');
        process.env.AGENTIC_MODEL_LOCK_DB = db;
        const { makeRepo: makeGitRepo, makeStore, plan, tempDir } = await mod('src/runtime/scheduler/test-helpers.ts');
        const { Scheduler } = await mod('src/runtime/scheduler/scheduler.ts');
        const { WorktreeManager } = await mod('src/runtime/worktree/worktree.ts');
        const { createCodingTaskWorkflow } = await mod('src/integrations/mastra/workflows/coding-task-workflow.ts');
        const { createInProcessExecutor } = await mod('src/integrations/mastra/__testing__/in-process-executor.ts');
        const { capacityFor } = await mod('src/runtime/capacity/model-capacity.ts');
        const repo = makeGitRepo({ 'go.mod': 'module example.com/calc\n\ngo 1.22\n', 'calc/calc.go': STUB, 'calc/calc_test.go': TEST_SRC });
        let enter!: () => void;
        const entered = new Promise<void>((r) => (enter = r));
        const generate = async (_p: string, opts: { abortSignal?: AbortSignal }) => {
          enter();
          await new Promise<void>((_, reject) => opts.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
          return { text: '', finishReason: 'stop', steps: [{}] };
        };
        const dir = tempDir('m10-1-oracle-sched-');
        const workflow = createCodingTaskWorkflow({ resolveWorker: () => ({ generate }), artifactRoot: join(dir, 'artifacts'), runOptions: { runtimeRetryDelayMs: 0 } });
        const store = makeStore();
        store.createBatch(plan(repo, [{ id: 'T', title: 'Implement Double', priority: 50, executor: 'worker', maxClaims: 1, request: { contract: codingTask('T'), assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one function' } } }] as never));
        store.promote();
        const scheduler = new Scheduler({
          store,
          executor: createInProcessExecutor(workflow),
          workspace: new WorktreeManager(join(dir, 'worktrees')),
          capacity: capacityFor(undefined, db),
          cancelGraceMs: 1_500,
          config: { pollMs: 20, workerLeaseTimeoutMs: 5_000, taskTimeoutMs: 120_000, maxCapacityWaitMs: 120_000 },
        });
        const codex = capacityFor({ resource: 'codex', defaultPermits: 1 }, db);
        let foreignRun: LiveRun | undefined;
        let foreignLease: { release(): void } | undefined;
        if (foreign === 'run') {
          foreignRun = await startRun({ runId: 'a-different-run', capacity: codex }); // same task id "T", another run, another provider
          await ready(foreignRun);
        } else foreignLease = await codex.acquire('gpt:T:pid4242', undefined, { tag: 'T' });
        const running = scheduler.run();
        try {
          await Promise.race([entered, timeoutAfter(60_000, 'the scheduled run to reach the model call')]);
          scheduler.stop();
          const summary = await Promise.race([running, timeoutAfter(60_000, 'the scheduler to stop')]);
          if (foreign === 'run') assert.deepEqual(summary.stillActive, [], `a foreign run's permit must not block the scheduler's cancel confirmation: ${JSON.stringify(summary.stillActive)}`);
          else assert.equal(summary.stillActive.length, 1, 'a permit nobody can attribute still blocks it: STOPPED would be false');
          assert.match(store.events('T').map((e: { reason?: string }) => e.reason ?? '').join('\n'), /run cancellation \(scheduler stopped\): (stopped|still_active)/);
        } finally {
          if (foreignRun) await finish(foreignRun);
          foreignLease?.release();
          scheduler.stop();
          await running.catch(() => {});
        }
      }
    } finally {
      if (previous === undefined) delete process.env.AGENTIC_MODEL_LOCK_DB;
      else process.env.AGENTIC_MODEL_LOCK_DB = previous;
    }
  });
});

describe('O-F2 regression guards: the existing false-STOPPED contract is not weakened (these must also hold on the baseline)', () => {
  it('a permit nobody can attribute to a run, held on ANOTHER resource than the probe\'s, still blocks (http-boundary.test.ts:132 in miniature)', CASE, async () => {
    const { by, probe } = await handles(['codex']);
    const lease = await by.codex.acquire('gpt:a:pid4242', undefined, { tag: 'a' });
    try {
      const r = await cancelRun(probe, { taskId: 'a', runId: 'run-1', graceMs: 150 });
      assert.equal(r.outcome, 'still_active');
      assert.equal(r.engaged.length, 1);
    } finally {
      lease.release();
    }
  });

  it('once that permit is released the same cancellation is confirmed', CASE, async () => {
    const { by, probe } = await handles(['codex']);
    const lease = await by.codex.acquire('gpt:a:pid4242', undefined, { tag: 'a' });
    setTimeout(() => lease.release(), 60);
    const r = await cancelRun(probe, { taskId: 'a', runId: 'run-1', graceMs: 2_000 });
    assert.equal(r.outcome, 'stopped');
  });

  it('the task-level probe (no run id) still reports every permit and queue entry carrying the task id, on every resource', CASE, async () => {
    const { by, probe } = await handles(['codex', 'gemini']);
    const a = await by.codex.acquire('gpt:T:pid1', undefined, { tag: 'T' });
    const b = await by.gemini.acquire('gem:T:pid2', undefined, { tag: 'T' });
    try {
      assert.equal(probe.engagedBy('T').length, 2);
      assert.equal(probe.engagedBy('OTHER').length, 0);
    } finally {
      a.release();
      b.release();
    }
  });
});

// ---- O-SA: execution, integration and acceptance are separate facts ---------------------------------------------------------------

async function claudeBatch(batchId: string, ids: { id: string; dependsOn?: string[] }[], dbFile = ':memory:') {
  const { SchedulerStore } = await mod('src/runtime/scheduler/store.ts');
  const store = new SchedulerStore(dbFile);
  store.createBatch({ batchId, project: 'p', repository: '/tmp/none', tasks: ids.map((t) => ({ id: t.id, title: t.id, executor: 'claude', keptReason: 'oracle fixture', dependsOn: t.dependsOn ?? [] })) });
  return store;
}
function finishClaude(store: any, id: string) {
  if (store.requireTask(id).state === 'BACKLOG') store.transition(id, 'READY', { actor: 'oracle', expectFrom: 'BACKLOG' });
  store.transition(id, 'CODING', { actor: 'oracle', expectFrom: 'READY' });
  store.transition(id, 'DONE', { actor: 'oracle', expectFrom: 'CODING', reason: 'implemented', patch: { implementedBy: 'claude' } });
}
/** A worker-implemented task taken all the way through review and integration (the path real worker tasks take). */
function finishWorker(store: any, id: string) {
  store.transition(id, 'READY', { actor: 'oracle', expectFrom: 'BACKLOG' });
  store.transition(id, 'CLAIMED', { actor: 'oracle', expectFrom: 'READY' });
  store.transition(id, 'CODING', { actor: 'oracle', expectFrom: 'CLAIMED' });
  store.transition(id, 'VERIFYING', { actor: 'oracle', expectFrom: 'CODING' });
  store.transition(id, 'REVIEW_PENDING', { actor: 'oracle', expectFrom: 'VERIFYING' });
  store.transition(id, 'APPROVED', { actor: 'oracle', expectFrom: 'REVIEW_PENDING' });
  store.transition(id, 'INTEGRATING', { actor: 'oracle', expectFrom: 'APPROVED' });
  store.transition(id, 'DONE', { actor: 'oracle', expectFrom: 'INTEGRATING', reason: 'integrated and verified', patch: { implementedBy: 'worker' } });
}

describe('O-SA scheduler acceptance truth', () => {
  it('a DONE task whose implementation was reverted keeps its history and is not currently accepted; reinstating it restores acceptance', CASE, async () => {
    const dbFile = join(tmp('m10-1-oracle-sa-'), 'scheduler.db');
    const store = await claudeBatch('B', [{ id: 't1' }], dbFile);
    finishClaude(store, 't1');
    const rowBefore = { ...store.requireTask('t1') };
    const eventsBefore = store.events('t1');
    assert.equal(store.projection('t1').accepted, true, 'a DONE, integrated task is accepted');

    store.recordRevert('t1', { actor: 'lead-1', reason: 'F2 fix reverted: false STOPPED against http-boundary.test.ts:132', commit: '94f5239' });

    const p = store.projection('t1');
    assert.equal(p.execution.state, 'DONE', 'the historical completion is still shown');
    assert.equal(typeof p.execution.finishedAt, 'number');
    assert.equal(p.integration.state, 'reverted');
    assert.equal(p.accepted, false, 'a reverted implementation is never currently accepted');
    assert.equal(p.integration.history.length, 1);
    assert.equal(p.integration.history[0].kind, 'reverted');
    assert.equal(p.integration.history[0].actor, 'lead-1', 'who recorded it is kept');
    assert.equal(p.integration.history[0].commit, '94f5239', 'the reverting commit is kept');
    assert.match(p.integration.history[0].reason, /false STOPPED/);
    assert.equal(typeof p.integration.history[0].at, 'number');
    const after = store.requireTask('t1');
    const strip = (t: any) => ({ ...t, updatedAt: undefined });
    assert.deepEqual(strip(after), strip(rowBefore), 'no column of the task row changed: DONE stays terminal and untouched');
    const eventsAfter = store.events('t1');
    assert.deepEqual(eventsAfter.slice(0, eventsBefore.length), eventsBefore, 'history is append-only: every earlier event is byte-identical');
    assert.equal(eventsAfter.length, eventsBefore.length + 1, 'exactly one event records the revert');
    const added = eventsAfter.at(-1);
    assert.equal(added.from, 'DONE');
    assert.equal(added.to, 'DONE');
    assert.match(added.reason ?? '', /reverted/);
    assert.match(added.reason ?? '', /http-boundary/);

    store.close();
    const { SchedulerStore } = await mod('src/runtime/scheduler/store.ts');
    const reopened = new SchedulerStore(dbFile);
    assert.equal(reopened.projection('t1').integration.state, 'reverted', 'the fact is durable');
    assert.equal(reopened.projection('t1').accepted, false);

    reopened.recordReinstatement('t1', { actor: 'lead-2', reason: 'run-scoped fix integrated', commit: 'abc1234' });
    const q = reopened.projection('t1');
    assert.equal(q.integration.state, 'integrated');
    assert.equal(q.accepted, true);
    assert.deepEqual(q.integration.history.map((h: { kind: string }) => h.kind), ['reverted', 'reinstated'], 'the whole history stays visible, oldest first');
    assert.equal(q.integration.history[1].actor, 'lead-2');
    assert.equal(reopened.events('t1').length, eventsBefore.length + 2);
    reopened.close();
  });

  it('a revert needs a reason and a DONE task; nothing else is accepted', CASE, async () => {
    const store = await claudeBatch('B', [{ id: 't1' }, { id: 't2' }]);
    finishClaude(store, 't1');
    assert.throws(() => store.recordRevert('t1', { actor: 'lead', reason: '   ' }));
    assert.throws(() => store.recordRevert('t2', { actor: 'lead', reason: 'not integrated yet' }), 'a BACKLOG task has nothing to revert');
    assert.throws(() => store.recordRevert('nope', { actor: 'lead', reason: 'x' }));
    assert.throws(() => store.recordReinstatement('t1', { actor: 'lead', reason: 'never reverted' }), 'only a reverted implementation can be reinstated');
    assert.equal(store.projection('t2').accepted, false);
    assert.equal(store.projection('t2').integration.state, 'not_integrated');
    assert.equal(store.projection('t1').integration.history.length, 0, 'the refused calls recorded nothing');
    store.recordRevert('t1', { actor: 'lead', reason: 'first' });
    assert.throws(() => store.recordRevert('t1', { actor: 'lead', reason: 'again' }), 'a second revert without a reinstatement is refused');
    assert.equal(store.projection('t1').integration.history.length, 1);
  });

  it('a reverted dependency does not satisfy its dependents, nothing can claim them, and reinstating it releases them', CASE, async () => {
    const store = await claudeBatch('B', [{ id: 't1' }, { id: 't2', dependsOn: ['t1'] }]);
    finishClaude(store, 't1');
    assert.equal(store.dependencyStatus(store.requireTask('t2')).status, 'ready', 'a DONE, integrated dependency satisfies its dependent');
    store.recordRevert('t1', { actor: 'lead', reason: 'reverted' });
    const dep = store.dependencyStatus(store.requireTask('t2'));
    assert.notEqual(dep.status, 'ready', 'a reverted dependency does not satisfy it');
    assert.match(dep.reason ?? '', /revert/i);
    store.transition('t2', 'READY', { actor: 'oracle', reason: 'forced READY before the revert was noticed', expectFrom: 'BACKLOG' });
    assert.equal(store.claim({ workerId: 'w', languages: ['go', 'js'], leaseMs: 1_000, maxActive: 3 }), undefined, 'a worker cannot claim work built on a reverted dependency');
    store.transition('t2', 'BACKLOG', { actor: 'oracle', reason: 'back', expectFrom: 'READY' }).state;
    store.promote('oracle');
    assert.equal(store.requireTask('t2').state, 'BLOCKED');
    assert.equal(store.requireTask('t2').failureCategory, 'dependency_failed');
    store.recordReinstatement('t1', { actor: 'lead', reason: 'reinstated' });
    store.promote('oracle');
    assert.ok(['BACKLOG', 'READY'].includes(store.requireTask('t2').state), `the dependent returns once the implementation is back (is ${store.requireTask('t2').state})`);
  });

  it('metrics do not count a reverted implementation as done, for either implementer, and report the revert', CASE, async () => {
    const { computeMetrics } = await mod('src/runtime/scheduler/report.ts');
    const store = await claudeBatch('B', [{ id: 'c1' }, { id: 'c2' }, { id: 'w1' }]);
    finishClaude(store, 'c1');
    finishClaude(store, 'c2');
    finishWorker(store, 'w1');
    const before = computeMetrics(store, 'B');
    assert.equal(before.doneByClaude, 2);
    assert.equal(before.doneByWorker, 1);
    store.recordRevert('c1', { actor: 'lead', reason: 'reverted' });
    store.recordRevert('w1', { actor: 'lead', reason: 'reverted' });
    const m = computeMetrics(store, 'B');
    assert.equal(m.doneByClaude, 1, 'only the implementation that is still integrated');
    assert.equal(m.doneByWorker, 0);
    assert.equal(m.revertedAfterDone, 2, 'and the reverts are reported, not hidden');
    assert.ok((m.acceptedLocalImplementationRate ?? 0) <= (before.acceptedLocalImplementationRate ?? 0), 'a reverted worker implementation is not an accepted one');
    assert.equal(m.byState.DONE, 3, 'the historical state counts are untouched: three tasks did reach DONE');
  });

  it('`lead tasks` shows the historical completion without claiming the code is still integrated', CASE, async () => {
    const dir = tmp('m10-1-oracle-sa-');
    const dbFile = join(dir, 'scheduler.db');
    const store = await claudeBatch('B', [{ id: 'shipped' }, { id: 'undone' }], dbFile);
    finishClaude(store, 'shipped');
    finishClaude(store, 'undone');
    store.recordRevert('undone', { actor: 'lead', reason: 'reverted by 94f5239', commit: '94f5239' });
    store.close();
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'lead.ts'), 'tasks', '--batch', 'B'], { env: { ...process.env, AGENTIC_SCHED_DB: dbFile, AGENTIC_SCHED_ROOT: dir }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    // a task's block: its line plus the indented continuation lines that follow it
    const block = (id: string) => {
      const lines = r.stdout.split('\n');
      const i = lines.findIndex((l) => l.includes(` ${id} `));
      assert.ok(i >= 0, `no row for ${id} in:\n${r.stdout}`);
      const out = [lines[i]];
      for (let j = i + 1; j < lines.length && /^\s{10,}\S/.test(lines[j]); j++) out.push(lines[j]);
      return out.join('\n');
    };
    assert.doesNotMatch(block('shipped'), /revert/i);
    assert.match(block('undone'), /DONE/, 'the completion is shown');
    assert.match(block('undone'), /revert/i, 'and so is the fact that the code is no longer integrated');
  });

  it('an objective recorded as ACCEPTED says a required task has since been reverted, keeps its history, and cannot be accepted again', CASE, async () => {
    const dir = tmp('m10-1-oracle-lc-');
    const dbFile = join(dir, 'scheduler.db');
    const { LifecycleStore } = await mod('src/lead/lifecycle/store.ts');
    const { requiredTasks, runAcceptance } = await mod('src/lead/lifecycle/oracle.ts');
    const store = await claudeBatch('OBJ', [{ id: 'a' }, { id: 'b' }], dbFile);
    finishClaude(store, 'a');
    finishClaude(store, 'b');
    const lifecycle = new LifecycleStore(store);
    const oracle = { dir: '/tmp/none', files: {}, commands: [], negativeControl: { mode: 'not_applicable', reason: 'fixture' }, specHash: 'a'.repeat(64), pinnedAt: 0, pinnedBy: 'oracle' };
    lifecycle.create({ objectiveId: 'OBJ', batchId: 'OBJ', oracle, baseCommit: 'c0ffee', actor: 'oracle' });
    for (const to of ['EXECUTING', 'ACCEPTING', 'ACCEPTED']) lifecycle.transition('OBJ', to, { actor: 'oracle', reason: 'fixture' });
    const lcBefore = JSON.stringify([lifecycle.require('OBJ'), lifecycle.events('OBJ')]);
    assert.equal(requiredTasks(store, 'OBJ').length, 2);

    store.recordRevert('b', { actor: 'lead', reason: 'reverted by 94f5239', commit: '94f5239' });

    assert.equal(JSON.stringify([lifecycle.require('OBJ'), lifecycle.events('OBJ')]), lcBefore, 'the recorded verdict and its events are history: untouched');
    await assert.rejects(runAcceptance({ store, lifecycle, worktrees: {}, run: async () => ({ exitCode: 0, output: '', timedOut: false }) }, 'OBJ'), /revert/i, 'acceptance cannot be run while a required task\'s implementation is reverted');
    store.close();
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'lead.ts'), 'lifecycle', 'status', 'OBJ'], { env: { ...process.env, AGENTIC_SCHED_DB: dbFile, AGENTIC_SCHED_ROOT: dir }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const header = r.stdout.split('\n').find((l) => l.startsWith('objective OBJ:')) ?? '';
    assert.match(header, /ACCEPTED/, 'the recorded verdict is still shown');
    assert.match(header, /revert|no longer|not currently/i, `but not as a current fact: ${header}`);
    assert.match(r.stdout, /revert/i);
  });
});

// ---- O-PR: objective-scoped promotion --------------------------------------------------------------------------------------------

async function twoObjectives() {
  const { SchedulerStore } = await mod('src/runtime/scheduler/store.ts');
  const store = new SchedulerStore(':memory:');
  const task = (id: string, dependsOn: string[] = []) => ({ id, title: id, executor: 'claude', keptReason: 'oracle fixture', dependsOn });
  // objective X has a task whose dependency is dead: a GLOBAL promote would turn it BLOCKED
  store.createBatch({ batchId: 'X', project: 'p', repository: '/tmp/none', tasks: [task('x-dep'), task('x-child', ['x-dep']), task('x-free')] });
  store.transition('x-dep', 'CANCELLED', { actor: 'oracle', reason: 'dead dependency' });
  return { store, task };
}
const snapshot = (store: any, batchId: string) => JSON.stringify({ tasks: store.listTasks({ batchId }).map((t: any) => [t.id, t.state, t.updatedAt, t.failureCategory]), events: store.events().filter((e: any) => store.getTask(e.taskId)?.batchId === batchId) });

describe('O-PR objective-scoped promotion', () => {
  it('promoting one objective mutates nothing in an unrelated objective', CASE, async () => {
    const { store, task } = await twoObjectives();
    const before = snapshot(store, 'X');
    store.createBatch({ batchId: 'Y', project: 'p', repository: '/tmp/none', tasks: [task('y-a'), task('y-b', ['y-a'])] });
    const out = store.promote('plan', { batchId: 'Y' });
    assert.deepEqual(out.ready, ['y-a']);
    assert.equal(store.requireTask('y-a').state, 'READY');
    assert.equal(snapshot(store, 'X'), before, 'objective X: no state, no timestamp and no event changed');
    assert.equal(store.requireTask('x-child').state, 'BACKLOG', 'the task with a dead dependency was NOT blocked by someone else\'s promote');
  });

  it('a BLOCKED task of another objective whose dependency has recovered is not released by someone else\'s promote either', CASE, async () => {
    const { SchedulerStore } = await mod('src/runtime/scheduler/store.ts');
    const store = new SchedulerStore(':memory:');
    const task = (id: string, dependsOn: string[] = []) => ({ id, title: id, executor: 'claude', keptReason: 'oracle fixture', dependsOn });
    store.createBatch({ batchId: 'X', project: 'p', repository: '/tmp/none', tasks: [task('x-dep'), task('x-child', ['x-dep'])] });
    store.transition('x-dep', 'READY', { actor: 'oracle' });
    store.transition('x-dep', 'CODING', { actor: 'oracle' });
    store.transition('x-dep', 'ESCALATED', { actor: 'oracle', reason: 'stuck' });
    store.promote('oracle'); // x-child -> BLOCKED(dependency_failed)
    assert.equal(store.requireTask('x-child').state, 'BLOCKED');
    store.transition('x-dep', 'READY', { actor: 'oracle', reason: 'recovered' }); // the dependency recovers
    store.createBatch({ batchId: 'Y', project: 'p', repository: '/tmp/none', tasks: [task('y-a')] });
    const before = snapshot(store, 'X');
    store.promote('oracle', { batchId: 'Y' });
    assert.equal(snapshot(store, 'X'), before, 'objective X was not re-evaluated');
    assert.equal(store.requireTask('x-child').state, 'BLOCKED');
    store.promote('oracle', { batchId: 'X' });
    assert.equal(store.requireTask('x-child').state, 'BACKLOG', 'its own objective\'s promote does release it');
  });

  it('promote() with no scope keeps its global behaviour', CASE, async () => {
    const { store, task } = await twoObjectives();
    store.createBatch({ batchId: 'Y', project: 'p', repository: '/tmp/none', tasks: [task('y-a')] });
    const out = store.promote('scheduler');
    assert.ok(out.ready.includes('y-a'));
    assert.ok(out.ready.includes('x-free'));
    assert.deepEqual(out.blocked, ['x-child']);
    assert.equal(store.requireTask('x-child').state, 'BLOCKED');
  });

  it('an empty or unknown objective id is an error, never "global"', CASE, async () => {
    const { store } = await twoObjectives();
    const before = store.events().length;
    assert.throws(() => store.promote('oracle', { batchId: '' }));
    assert.throws(() => store.promote('oracle', { batchId: 'no-such-batch' }));
    assert.equal(store.events().length, before, 'and nothing was promoted by the failed calls');
    assert.equal(store.requireTask('x-free').state, 'BACKLOG');
  });

  it('dependencies across objectives are read both ways: a scoped task sees a dead or finished dependency elsewhere', CASE, async () => {
    const { store, task } = await twoObjectives();
    store.createBatch({ batchId: 'Z', project: 'p', repository: '/tmp/none', tasks: [task('z-done')] });
    finishClaude(store, 'z-done');
    store.createBatch({ batchId: 'Y', project: 'p', repository: '/tmp/none', tasks: [task('y-after-dead', ['x-dep']), task('y-after-done', ['z-done'])] });
    const out = store.promote('oracle', { batchId: 'Y' });
    assert.equal(store.requireTask('y-after-dead').state, 'BLOCKED', 'its dependency in X is dead');
    assert.equal(store.requireTask('y-after-done').state, 'READY', 'its dependency in Z is done');
    assert.deepEqual(out.blocked, ['y-after-dead']);
    assert.equal(store.requireTask('x-child').state, 'BACKLOG', 'X itself is still untouched');
  });

  it('after the dependency is done, scoped promotion of its objective releases dependents in other objectives, transitively, and leaves strangers alone', CASE, async () => {
    const { store, task } = await twoObjectives();
    store.createBatch({ batchId: 'Y', project: 'p', repository: '/tmp/none', tasks: [task('y-a')] });
    store.createBatch({ batchId: 'Z', project: 'p', repository: '/tmp/none', tasks: [task('z-after-y', ['y-a']), task('z-alone')] });
    store.createBatch({ batchId: 'W', project: 'p', repository: '/tmp/none', tasks: [task('w-after-z', ['z-after-y'])] });
    store.promote('oracle', { batchId: 'Y' });
    assert.equal(store.requireTask('z-alone').state, 'BACKLOG', 'Z\'s independent task is a stranger to Y');
    finishClaude(store, 'y-a');
    const out = store.promote('oracle', { batchId: 'Y' });
    assert.deepEqual(out.ready, ['z-after-y'], 'the dependent follows its dependency');
    assert.equal(store.requireTask('z-alone').state, 'BACKLOG');
    assert.equal(store.requireTask('x-child').state, 'BACKLOG');
    finishClaude(store, 'z-after-y');
    const next = store.promote('oracle', { batchId: 'Y' });
    assert.deepEqual(next.ready, ['w-after-z'], 'and so does its dependent in a third objective: dependents count transitively');
    assert.equal(store.requireTask('z-alone').state, 'BACKLOG');
  });

  it('history is append-only: earlier events are untouched by a scoped promotion', CASE, async () => {
    const { store, task } = await twoObjectives();
    const before = store.events();
    store.createBatch({ batchId: 'Y', project: 'p', repository: '/tmp/none', tasks: [task('y-a')] });
    store.promote('oracle', { batchId: 'Y' });
    const after = store.events();
    assert.deepEqual(after.slice(0, before.length), before);
    assert.ok(after.slice(before.length).every((e: any) => store.getTask(e.taskId)?.batchId === 'Y'), 'every new event belongs to objective Y');
  });

  it('`lead plan` promotes the plan it created and nothing else (the M10 side effect)', CASE, async () => {
    const dir = tmp('m10-1-oracle-plan-');
    const dbFile = join(dir, 'scheduler.db');
    const { SchedulerStore } = await mod('src/runtime/scheduler/store.ts');
    const real = new SchedulerStore(dbFile);
    const task = (id: string, dependsOn: string[] = []) => ({ id, title: id, executor: 'claude', keptReason: 'oracle fixture', dependsOn });
    real.createBatch({ batchId: 'X', project: 'p', repository: '/tmp/none', tasks: [task('x-dep'), task('x-child', ['x-dep']), task('x-free')] });
    real.transition('x-dep', 'CANCELLED', { actor: 'oracle', reason: 'dead dependency' });
    const before = snapshot(real, 'X');
    real.close();
    const planFile = join(dir, 'plan.json');
    writeFileSync(planFile, JSON.stringify({ batchId: 'Y', project: 'p', repository: '/tmp/none', tasks: [task('y-a')] }));
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'lead.ts'), 'plan', planFile], { env: { ...process.env, AGENTIC_SCHED_DB: dbFile, AGENTIC_SCHED_ROOT: dir }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const check = new SchedulerStore(dbFile);
    assert.equal(check.requireTask('y-a').state, 'READY');
    assert.equal(snapshot(check, 'X'), before, 'objective X was not touched by planning objective Y');
    assert.equal(check.requireTask('x-child').state, 'BACKLOG');
    check.close();
  });
});

// ---- O-FP: fault points (carried from v2, unchanged) ------------------------------------------------------------------------------

describe('O-FP fault points', () => {
  it('declares the named boundaries', async () => {
    const { FAULT_POINTS } = await mod('src/runtime/reliability/faults.ts');
    for (const p of ['runner.before-permit', 'runner.after-permit', 'provider.before-spawn']) assert.ok(FAULT_POINTS.includes(p), p);
  });

  it('is inert without the explicit test enable, even when a plan is present (production cannot be affected)', async () => {
    const { faultPoint } = await mod('src/runtime/reliability/faults.ts');
    const log = join(tmp('m10-oracle-fp-'), 'faults.jsonl');
    const env = { AGENTIC_FAULTS: JSON.stringify({ 'provider.before-spawn': { delayMs: 5_000 } }), AGENTIC_FAULTS_LOG: log };
    const t0 = Date.now();
    await faultPoint('provider.before-spawn', { env });
    assert.ok(Date.now() - t0 < 1_000, 'no delay was injected');
    assert.equal(existsSync(log), false, 'nothing fired');
  });

  it('when enabled: delays, can throw, logs one JSON line per firing, and an abort ends the delay at once', async () => {
    const { faultPoint } = await mod('src/runtime/reliability/faults.ts');
    const log = join(tmp('m10-oracle-fp-'), 'faults.jsonl');
    const env = { AGENTIC_FAULTS_ENABLE: 'test', AGENTIC_FAULTS: JSON.stringify({ 'runner.before-permit': { delayMs: 150 }, 'runner.after-permit': { throw: 'injected failure' }, 'provider.before-spawn': { delayMs: 60_000 } }), AGENTIC_FAULTS_LOG: log };
    const t0 = Date.now();
    await faultPoint('runner.before-permit', { env });
    assert.ok(Date.now() - t0 >= 140, 'the delay happened');
    await assert.rejects(faultPoint('runner.after-permit', { env }), /injected failure/);
    const ac = new AbortController();
    const pending = faultPoint('provider.before-spawn', { env, signal: ac.signal });
    setTimeout(() => ac.abort(new Error('cancelled by test')), 50);
    const t1 = Date.now();
    await assert.rejects(pending, /cancelled by test/);
    assert.ok(Date.now() - t1 < 2_000, 'the abort ended the injected delay');
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.point), ['runner.before-permit', 'runner.after-permit', 'provider.before-spawn']);
    for (const l of lines) assert.equal(typeof l.pid, 'number');
  });

  it('a plan naming an unknown boundary is refused, never silently ignored', async () => {
    const { faultPoint } = await mod('src/runtime/reliability/faults.ts');
    await assert.rejects(faultPoint('provider.before-spawn', { env: { AGENTIC_FAULTS_ENABLE: 'test', AGENTIC_FAULTS: JSON.stringify({ 'provider.befor-spawn': { delayMs: 1 } }) } }), /unknown fault point/);
  });
});

// ---- O-SM: the HTTP smoke timeout, deterministic (carried from v2; only the not-ready budget changes) -----------------------------

const FAKE = join(ROOT, 'src', 'workers', 'providers', '__testing__', 'fake-gemini.mjs');
const RIGHT = 'package smoke\n\nfunc Double(n int) int {\n\treturn n * 2\n}\n';
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function timeoutSmoke(extra: { fake?: Record<string, string>; faults?: Record<string, unknown>; taskTimeoutMs?: number }) {
  const { runSchedulerSmoke, TASK_ID } = await mod('tests/provider-smoke/scheduler-smoke.ts');
  const { capacityFor } = await mod('src/runtime/capacity/model-capacity.ts');
  const outDir = tmp('m10-oracle-sm-');
  const pidfile = join(outDir, 'pid');
  const capacityDb = join(outDir, 'capacity.db');
  const fakeLog = join(outDir, 'fake-gemini.log');
  const { report } = await runSchedulerSmoke({
    outDir,
    transport: 'http',
    provider: 'gemini',
    gemini: { command: FAKE, termGraceMs: 200, env: { FAKE_FILE: 'smoke/double.go', FAKE_CONTENT: JSON.stringify(RIGHT), FAKE_LOG: fakeLog, FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile, ...extra.fake } },
    http: { capacityDb, maxInvocations: 1, pollMs: 100, ...(extra.faults ? { faults: extra.faults } : {}) },
    modelTimeoutMs: 20_000,
    taskTimeoutMs: extra.taskTimeoutMs ?? 2_500, // the original budget: deliberately NOT widened
    signalSource: new EventEmitter(),
    log: () => {},
  });
  const prompts = existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e: { args?: string[] }) => e.args?.includes('--prompt')).length : 0;
  const faultLog = join(outDir, 'faults.jsonl');
  const fired = existsSync(faultLog) ? readFileSync(faultLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).point) : [];
  return { report, pidfile, prompts, fired, engaged: capacityFor({ resource: 'gemini', defaultPermits: 1 }, capacityDb).engagedBy(TASK_ID) };
}

function assertTimedOutCleanly(r: Awaited<ReturnType<typeof timeoutSmoke>>) {
  assert.equal(r.report.taskState, 'RUNTIME_FAILURE');
  assert.equal(r.report.failureCategory, 'task_timeout');
  assert.deepEqual(r.report.stillActive, [], 'the cancel was confirmed');
  assert.ok(r.report.schedulerEvents.some((e: { reason?: string }) => /run cancellation \(task timeout\): stopped/.test(e.reason ?? '')), JSON.stringify(r.report.schedulerEvents));
  assert.equal(r.report.claims, 1);
  assert.deepEqual(r.report.requeued, [], 'no requeue, no second execution');
  assert.deepEqual(r.engaged, [], 'the model permit is free');
}

describe('O-SM HTTP smoke timeout, each interleaving forced', () => {
  it('timeout BEFORE the CLI is spawned: no provider process ever exists, no late spawn', async () => {
    const r = await timeoutSmoke({ faults: { 'provider.before-spawn': { delayMs: 60_000 } } });
    assertTimedOutCleanly(r);
    assert.ok(r.fired.includes('provider.before-spawn'), `the boundary was reached: ${JSON.stringify(r.fired)}`);
    assert.deepEqual(r.report.processes, [], 'no provider process was started');
    assert.equal(r.prompts, 0, 'the CLI never received a prompt');
    assert.equal(existsSync(r.pidfile), false);
  });

  it('timeout AFTER spawn but before the CLI is ready: the started group is killed although it never reported in', async () => {
    // v3: the 60 s start delay holds "not ready"; the budget only has to land after the spawn, so it is sized for spawn latency
    // under full-suite load (v2 used 2.5 s, which landed before the spawn in one of two full runs: M10 report, section 6).
    const r = await timeoutSmoke({ fake: { FAKE_START_DELAY_MS: '60000' }, taskTimeoutMs: 15_000 });
    assertTimedOutCleanly(r);
    assert.equal(existsSync(r.pidfile), false, 'the CLI never became ready');
    assert.equal(r.report.processes.length, 1, 'exactly one provider process was started');
    assert.ok(r.report.processes.every((p: { pid: number; groupGone: boolean }) => p.groupGone && !alive(p.pid)), JSON.stringify(r.report.processes));
  });

  it('the original scenario, original 2.5 s budget, NO forcing: whichever interleaving the machine produces, the timeout is clean', async () => {
    const r = await timeoutSmoke({});
    assertTimedOutCleanly(r);
    if (existsSync(r.pidfile)) {
      const pid = Number(readFileSync(r.pidfile, 'utf8'));
      assert.equal(alive(pid), false, 'ready CLI killed');
      assert.deepEqual(r.report.processes, [{ pid, groupGone: true }]);
    } else {
      assert.ok(r.report.processes.every((p: { pid: number; groupGone: boolean }) => p.groupGone && !alive(p.pid)), `not ready / not spawned: every started group is gone ${JSON.stringify(r.report.processes)}`);
      assert.ok(r.report.processes.length <= 1);
    }
  });
});

// ---- O-RL: the runner and classifier (carried from v2, unchanged) -----------------------------------------------------------------

describe('O-RL reliability runner and classifier', () => {
  it('classifies the two known signatures and the environmental and unknown cases', async () => {
    const { classify } = await mod('tests/reliability/classify.ts');
    const base = { schema: 'agentic.reliability-evidence/1', scenario: 'x', run: 1, ok: false, durationMs: 1 };
    assert.equal(classify({ ...base, failure: { message: 'timed out waiting for: the (fake) Gemini CLI to be running under the Mastra server' }, runtime: { cancelOutcome: 'stopped', processes: [], engaged: [] } }).category, 'test_race');
    assert.equal(classify({ ...base, failure: { message: 'still_active run status canceled; model still engaged: lease pid 1' }, runtime: { cancelOutcome: 'still_active', processes: [], engaged: [{ kind: 'lease', holder: 'codex:T:pid1', pid: 1, resource: 'codex' }], taskResource: 'gemini' } }).category, 'product_defect');
    assert.equal(classify({ ...base, failure: { message: 'listen EADDRINUSE: address already in use 127.0.0.1:4111' } }).category, 'environmental');
    assert.equal(classify({ ...base, failure: { message: 'something nobody has seen' } }).category, 'unknown');
    assert.equal(classify({ ...base, ok: true }).category, 'pass');
  });

  it('runs a scenario N times with bounded concurrency and writes one evidence record per run plus a summary', async () => {
    const { runScenarios } = await mod('tests/reliability/run.ts');
    const out = tmp('m10-oracle-rl-');
    const summary = await runScenarios({ scenarios: ['lease-isolation'], repeat: 3, concurrency: 2, outDir: out });
    const files = readdirSync(out).filter((f: string) => f.startsWith('lease-isolation-') && f.endsWith('.json')).sort();
    assert.equal(files.length, 3, files.join(','));
    for (const f of files) {
      const e = JSON.parse(readFileSync(join(out, f), 'utf8'));
      assert.equal(e.schema, 'agentic.reliability-evidence/1');
      assert.equal(e.scenario, 'lease-isolation');
      assert.equal(e.ok, true, JSON.stringify(e));
      assert.equal(typeof e.durationMs, 'number');
      // ok:true alone is how oracle v1 went vacuous: the evidence must say what was actually proved, with two distinct real runs
      const proves = e.detail?.proves ?? {};
      for (const k of ['ownPermitBlocksItsOwnCancel', 'foreignRunDoesNotBlock', 'unattributablePermitFailsClosed']) assert.equal(proves[k], true, `${k}: ${JSON.stringify(e.detail)}`);
      assert.ok(e.detail?.targetRunId && e.detail?.foreignRunId && e.detail.targetRunId !== e.detail.foreignRunId, 'two different runs of the same task id');
    }
    assert.ok(summary.peakConcurrency <= 2, `peak ${summary.peakConcurrency}`);
    assert.equal(summary.runs, 3);
    assert.deepEqual(summary.byCategory, { pass: 3 });
    assert.ok(existsSync(join(out, 'summary.json')));
  });

  it('knows the scenarios the mission requires', async () => {
    const { SCENARIOS } = await mod('tests/reliability/scenarios.ts');
    const ids = Object.keys(SCENARIOS);
    for (const id of ['timeout-before-spawn', 'timeout-spawned-not-ready', 'timeout-after-ready', 'cancel-after-permit', 'lease-isolation', 'stale-lease', 'interrupted-run']) assert.ok(ids.includes(id), id);
  });
});

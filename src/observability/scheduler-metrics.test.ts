import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMetrics } from './metrics.ts';
import { LEASED_STATES, readSchedulerState, resolveSchedulerDbPath, TASK_STATES } from './scheduler-state.ts';
import * as scheduler from '../runtime/scheduler/types.ts';
import { tempDir } from '../runtime/scheduler/test-helpers.ts';

const CHILD = new URL('./scheduler-child.fixture.ts', import.meta.url).pathname;
const runChild = (mode: string, db: string) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, mode, db], { encoding: 'utf8' });

/** Value of one exposition sample line, or undefined when the series is absent. */
function series(text: string, name: string, labels = ''): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(labels ? `${name}{${labels}} ` : `${name} `));
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
}

describe('persisted scheduler metrics (read-only SQLite at scrape time)', () => {
  it('sees a task claimed by a SEPARATE live process, and keeps seeing it after the metrics side restarts', async () => {
    const db = join(tempDir('sched-metrics-'), 'sched.db');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, 'hold', db], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (b) => String(b).includes('CLAIMED') && resolve());
        child.on('exit', (code) => reject(new Error(`child exited early (${code})`)));
      });
      const m1 = createMetrics({ schedulerDbPath: db });
      m1.workerTask('qwen3:8b', 'pass'); // a LIVE counter, lost on restart by design
      const t1 = await m1.render();
      assert.equal(series(t1, 'active_workers'), 1);
      assert.equal(series(t1, 'task_queue_depth'), 1); // T2 still READY
      assert.equal(series(t1, 'scheduler_state_up'), 1);
      assert.equal(series(t1, 'scheduler_tasks', 'state="CLAIMED"'), 1);
      assert.equal(series(t1, 'worker_tasks_total', 'worker="qwen3:8b",outcome="pass"'), 1);

      // "Mastra server restart": a brand-new metrics instance. Persisted series are intact; live counters start over.
      const t2 = await createMetrics({ schedulerDbPath: db }).render();
      assert.equal(series(t2, 'active_workers'), 1);
      assert.equal(series(t2, 'worker_tasks_total', 'worker="qwen3:8b",outcome="pass"'), undefined);
    } finally {
      child.stdin.end();
    }
  });

  it('scheduler crash/restart: a dead worker stops counting once its lease expires, and returns to the queue after recovery', async () => {
    const db = join(tempDir('sched-metrics-'), 'sched.db');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, 'hold', db], { stdio: ['pipe', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.on('data', (b) => String(b).includes('CLAIMED') && resolve()));
    child.kill('SIGKILL'); // crash: no cleanup, lease row stays in the database
    await new Promise((r) => child.on('exit', r));

    let wall = Date.now();
    const m = createMetrics({ schedulerDbPath: db, wallClock: () => wall });
    assert.equal(series(await m.render(), 'active_workers'), 1); // lease (60s) still valid
    wall += 120_000;
    const expired = await m.render();
    assert.equal(series(expired, 'active_workers'), 0); // expired lease is not an active worker, even before any reaper ran
    assert.equal(series(expired, 'scheduler_tasks', 'state="CLAIMED"'), 1); // ...and the persisted state is reported as it is

    // The restarted scheduler recovers through its normal path (reapExpired); its clock is shifted so the 60s lease is past.
    const reaped = JSON.parse(runChildWithClock(db, wall));
    assert.deepEqual(reaped.requeued, ['T1']);
    const after = await m.render();
    assert.equal(series(after, 'active_workers'), 0);
    assert.equal(series(after, 'task_queue_depth'), 2); // T1 requeued + T2
    assert.equal(series(after, 'scheduler_tasks', 'state="READY"'), 2);
  });

  it('exposes Claude review decisions written by another process, counted from the persisted reviews table', async () => {
    const db = join(tempDir('sched-metrics-'), 'sched.db');
    runChild('decide', db);
    const text = await createMetrics({ schedulerDbPath: db }).render();
    assert.equal(series(text, 'review_decisions_total', 'decision="APPROVED",reviewer="claude"'), 1);
    assert.equal(series(text, 'review_decisions_total', 'decision="ESCALATED_TO_HUMAN",reviewer="claude"'), 1);
    assert.equal(series(text, 'scheduler_tasks', 'state="ESCALATED"'), 1);
    assert.equal(series(text, 'scheduler_tasks', 'state="APPROVED"'), 1);
    // Monotonic across scrapes: reading never mutates anything.
    const again = await createMetrics({ schedulerDbPath: db }).render();
    assert.equal(series(again, 'review_decisions_total', 'decision="APPROVED",reviewer="claude"'), 1);
  });

  it('does not change task state or create files: reading is strictly read-only', () => {
    const db = join(tempDir('sched-metrics-'), 'sched.db');
    runChild('decide', db);
    const count = () => {
      const c = new DatabaseSync(db, { readOnly: true });
      try {
        return JSON.stringify([c.prepare('SELECT COUNT(*) n FROM events').get(), c.prepare('SELECT state, updated_at FROM tasks ORDER BY id').all()]);
      } finally {
        c.close();
      }
    };
    const before = count();
    readSchedulerState(db);
    assert.equal(count(), before);
    const missing = join(tempDir('sched-metrics-'), 'nope', 'sched.db');
    assert.throws(() => readSchedulerState(missing));
    assert.equal(existsSync(missing), false);
    assert.deepEqual(readdirSync(join(missing, '..', '..')).sort(), []);
  });

  it('unavailable database: series are absent (not stale, not zero), up=0, the scrape still succeeds', async () => {
    const dir = tempDir('sched-metrics-');
    const m = createMetrics({ schedulerDbPath: join(dir, 'missing.db') });
    const text = await m.render();
    assert.equal(series(text, 'scheduler_state_up'), 0);
    assert.equal(series(text, 'task_queue_depth'), undefined);
    assert.equal(series(text, 'active_workers'), undefined);
    assert.equal(series(text, 'scheduler_state_read_errors_total'), 0); // "scheduler never ran" is not an error
    m.workflowFinished('wf', 'r', 'success');
    assert.equal(series(await m.render(), 'workflow_runs_total', 'workflow="wf",status="success"'), 1); // live series unaffected
  });

  it('corrupt or schema-less database is counted as a read error and never throws', async () => {
    const dir = tempDir('sched-metrics-');
    const corrupt = join(dir, 'corrupt.db');
    writeFileSync(corrupt, 'this is not a sqlite file '.repeat(200));
    const empty = join(dir, 'empty.db');
    new DatabaseSync(empty).close();
    for (const path of [corrupt, empty]) {
      const m = createMetrics({ schedulerDbPath: path });
      const text = await m.render();
      assert.equal(series(text, 'scheduler_state_up'), 0);
      assert.equal(series(text, 'scheduler_state_read_errors_total'), 1);
      assert.equal(series(text, 'task_queue_depth'), undefined);
    }
  });

  it('a locked database costs a bounded wait, then the scrape degrades instead of hanging or crashing', async () => {
    const db = join(tempDir('sched-metrics-'), 'locked.db');
    const writer = new DatabaseSync(db);
    writer.exec('PRAGMA journal_mode = DELETE; CREATE TABLE tasks (id TEXT); BEGIN EXCLUSIVE;'); // rollback-journal mode: readers are blocked
    try {
      const m = createMetrics({ schedulerDbPath: db });
      const started = Date.now();
      const text = await m.render();
      assert.ok(Date.now() - started < 3_000);
      assert.equal(series(text, 'scheduler_state_up'), 0);
      assert.equal(series(text, 'scheduler_state_read_errors_total'), 1);
      writer.exec('COMMIT');
    } finally {
      writer.close();
    }
  });

  it('recovers on the next scrape once the database is readable again, with no stale values in between', async () => {
    const dir = tempDir('sched-metrics-');
    const db = join(dir, 'late.db');
    const m = createMetrics({ schedulerDbPath: db });
    assert.equal(series(await m.render(), 'scheduler_state_up'), 0);
    runChild('decide', db);
    const text = await m.render();
    assert.equal(series(text, 'scheduler_state_up'), 1);
    assert.equal(series(text, 'review_decisions_total', 'decision="APPROVED",reviewer="claude"'), 1);
  });

  it('state lists mirrored here (to avoid an import cycle) match the scheduler\'s own', () => {
    assert.deepEqual([...TASK_STATES], [...scheduler.TASK_STATES]);
    assert.deepEqual([...LEASED_STATES], [...scheduler.LEASED_STATES]);
  });

  it('resolves the database path like lead: AGENTIC_SCHED_DB, then AGENTIC_SCHED_ROOT, then <project>/.workdir', () => {
    assert.equal(resolveSchedulerDbPath({ AGENTIC_SCHED_DB: '/x/y.db' }, '/'), '/x/y.db');
    assert.equal(resolveSchedulerDbPath({ AGENTIC_SCHED_ROOT: '/r' }, '/'), '/r/scheduler/scheduler.db');
    // from a nested cwd (mastra dev runs inside its own build output) it still finds the project root
    const projectRoot = join(import.meta.dirname, '..', '..'); // independent of the checkout's directory name
    assert.equal(resolveSchedulerDbPath({}, join(projectRoot, '.mastra', 'output')), join(projectRoot, '.workdir', 'scheduler', 'scheduler.db'));
  });
});

function runChildWithClock(db: string, wall: number): string {
  // The reaper reads the store clock; run it with a shifted Date.now so the 60s lease is genuinely expired.
  const preload = `const real=Date.now;Date.now=()=>real()+${wall - Date.now()};`;
  return execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', `data:text/javascript,${encodeURIComponent(preload)}`, CHILD, 'reap', db], { encoding: 'utf8' });
}

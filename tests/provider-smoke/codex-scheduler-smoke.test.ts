import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { tempDir } from '../../src/runtime/scheduler/test-helpers.ts';
import { SmokeCancellationUnconfirmed, runSchedulerSmoke } from './scheduler-smoke.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'workers', 'providers', '__testing__', 'fake-codex.mjs');
const RIGHT = 'package smoke\n\n// Double returns n multiplied by two.\nfunc Double(n int) int {\n\treturn n * 2\n}\n';

describe('smoke harness, against the MOCK Codex CLI (always runs; no network, no account)', () => {
  it('drives task -> scheduler -> adapter -> worktree -> verifier -> REVIEW_PENDING and writes a complete report', async () => {
    const { report } = await runSchedulerSmoke({
      outDir: tempDir('smoke-harness-'),
      codex: { command: FAKE, model: 'gpt-fake', termGraceMs: 200, env: { FAKE_FILE: 'smoke/double.go', FAKE_CONTENT: JSON.stringify(RIGHT) } },
    });
    assert.equal(report.taskState, 'REVIEW_PENDING', JSON.stringify(report));
    assert.equal(report.claims, 1);
    assert.equal(report.codingAttempts, 1);
    assert.equal(report.runtimeRetries, 0);
    assert.deepEqual(report.requeued, []);
    assert.deepEqual(report.stillActive, []);
    assert.deepEqual(report.verifier[0]?.exitCode, 0);
    assert.deepEqual(report.git, { ...report.git, sourceHeadUnchanged: true, sourceStatusClean: true, existingRefsUnchanged: true, unexpectedNewRefs: [], fsckOk: true, worktreeStatus: '' });
    assert.deepEqual(report.commentsKept, [false, true], 'the mock rewrote the file without the package comment: the report sees comment deletion');
    assert.match(report.diffOfTaskCommit ?? '', /n \* 2/);
  });
});

// ---- signal handling, against the mock CLI ----------------------------------------------------------------------------------

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (cond: () => boolean, what: string, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

function hanging(mode: 'hang' | 'term-ok-hang', extra: { termGraceMs: number; cancelDeadlineMs?: number }) {
  const pidfile = join(tempDir('smoke-pid-'), 'pid');
  const emitter = new EventEmitter();
  const logs: string[] = [];
  const exits: number[] = [];
  const outDir = tempDir('smoke-sig-');
  const run = runSchedulerSmoke({
    outDir,
    codex: { command: FAKE, model: 'gpt-fake', termGraceMs: extra.termGraceMs, env: { FAKE_MODE: mode, FAKE_PIDFILE: pidfile } },
    signalSource: emitter,
    exit: (code) => exits.push(code),
    log: (l) => logs.push(l),
    cancelDeadlineMs: extra.cancelDeadlineMs,
  });
  run.catch(() => {});
  const pid = async () => {
    await waitFor(() => existsSync(pidfile), 'the (mock) Codex CLI to be running');
    return Number(readFileSync(pidfile, 'utf8'));
  };
  return { emitter, logs, exits, outDir, run, pid };
}

describe('smoke harness: SIGINT / SIGTERM handling (mock CLI; deterministic)', () => {
  it('SIGINT during execution: the scheduler stops, the CLI (which ignores SIGTERM) is SIGKILLed, and the group is confirmed gone', async () => {
    const h = hanging('hang', { termGraceMs: 300 });
    const pid = await h.pid();
    assert.ok(alive(pid));
    assert.equal(h.emitter.listenerCount('SIGINT'), 1);
    h.emitter.emit('SIGINT');
    const { report } = await h.run;
    assert.equal(report.cancellation?.confirmed, true, JSON.stringify(report.cancellation));
    assert.equal(report.cancellation?.signal, 'SIGINT');
    assert.equal(alive(pid), false, 'the owned Codex process is gone');
    assert.deepEqual(report.processes, [{ pid, groupGone: true }]);
    assert.equal(report.taskState, 'RUNTIME_FAILURE');
    assert.equal(report.claims, 1);
    assert.deepEqual(report.requeued, []);
    assert.deepEqual(h.exits, [], 'a single signal does not force an exit');
    assert.equal(h.emitter.listenerCount('SIGINT') + h.emitter.listenerCount('SIGTERM'), 0, 'handlers are removed afterwards');
    assert.ok(h.logs.some((l) => /SIGINT: stopping/.test(l)));
  });

  it('SIGTERM behaves the same (a CLI that honors SIGTERM exits without SIGKILL)', async () => {
    const h = hanging('term-ok-hang', { termGraceMs: 5_000 });
    const pid = await h.pid();
    h.emitter.emit('SIGTERM');
    const { report } = await h.run;
    assert.equal(report.cancellation?.confirmed, true);
    assert.equal(report.cancellation?.signal, 'SIGTERM');
    assert.equal(alive(pid), false);
    assert.equal(report.taskState, 'RUNTIME_FAILURE');
    assert.ok((report.cancellation?.elapsedMs as number) < 4_000, 'it did not wait out the SIGKILL grace');
  });

  it('a second signal exits promptly, SIGKILLs only the owned groups and says what may still be running', async () => {
    const h = hanging('hang', { termGraceMs: 4_000 }); // the first stop would take 4 s to escalate
    const pid = await h.pid();
    h.emitter.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(alive(pid), true, 'still inside the SIGTERM grace period');
    const t0 = Date.now();
    h.emitter.emit('SIGINT');
    assert.deepEqual(h.exits, [130]);
    assert.ok(Date.now() - t0 < 500, 'the exit path did not wait');
    const report = h.logs.find((l) => /^SIGINT again: exiting/.test(l)) ?? '';
    assert.ok(report.includes(`(SIGKILL sent, NOT confirmed): ${pid};`), `the report names the owned pid ${pid}: ${report}`);
    assert.match(report, /NOT confirmed/);
    await waitFor(() => !alive(pid), 'the owned group to die from the second signal', 5_000);
    const { report: written } = await h.run; // (exit is a stub here, so the harness finishes and records both signals)
    assert.deepEqual((written.cancellation?.secondSignal as { sentSigkillTo: number[] }).sentSigkillTo, [pid]);
  });

  it('cancellation that cannot be confirmed within the deadline fails loudly and keeps the evidence', async () => {
    const h = hanging('hang', { termGraceMs: 10_000, cancelDeadlineMs: 300 });
    const pid = await h.pid();
    try {
      h.emitter.emit('SIGINT');
      await assert.rejects(h.run, (e: unknown) => e instanceof SmokeCancellationUnconfirmed && /NOT confirmed/.test(e.message) && e.message.includes('report.json'));
      assert.equal(alive(pid), true, 'the process really is still there: the harness did not pretend otherwise');
      const written = JSON.parse(readFileSync(join(h.outDir, 'report.json'), 'utf8'));
      assert.equal(written.cancellation.confirmed, false);
      assert.deepEqual(written.cancellation.stillAlive, [pid]);
    } finally {
      try {
        process.kill(-pid, 'SIGKILL'); // test cleanup of the process this test started
      } catch {
        /* gone */
      }
    }
    await waitFor(() => !alive(pid), 'cleanup', 5_000);
  });

  it('with no signal the handlers are removed, every process group is gone, and the report has no cancellation', async () => {
    const emitter = new EventEmitter();
    const { report } = await runSchedulerSmoke({
      outDir: tempDir('smoke-nosig-'),
      codex: { command: FAKE, model: 'gpt-fake', termGraceMs: 200, env: { FAKE_FILE: 'smoke/double.go', FAKE_CONTENT: JSON.stringify(RIGHT) } },
      signalSource: emitter,
    });
    assert.equal(report.cancellation, null);
    assert.equal(report.taskState, 'REVIEW_PENDING');
    assert.ok(report.processes.length >= 1 && report.processes.every((p) => p.groupGone));
    assert.equal(emitter.listenerCount('SIGINT') + emitter.listenerCount('SIGTERM'), 0);
  });
});

/**
 * ONE real Codex task through the real scheduler. Opt-in; spends the operator's Codex quota/credits:
 *
 *   npm run smoke:codex
 *
 * Limits: one task, maxClaims 1, at most 2 coding attempts and NO automatic runtime retry (so at most 2 Codex invocations,
 * normally 1), 5 minute per-call deadline, workspace-write sandbox, --ignore-user-config, no bypass flags, allowlisted
 * environment, throwaway repository under .workdir/m8.2-smoke/. PASS is decided by the runtime verifier, not by Codex.
 * Report: .workdir/m8.2-smoke/<timestamp>/report.json.
 */
const real = process.env.AGENTIC_REAL_PROVIDER_SMOKE === 'codex';
describe('REAL Codex through the scheduler (opt-in)', { skip: real ? false : 'run: npm run smoke:codex' }, () => {
  it('completes one Go task, judged by the runtime verifier', async () => {
    const { report } = await runSchedulerSmoke({
      codex: { model: process.env.AGENTIC_CODEX_MODEL || undefined, passEnv: (process.env.AGENTIC_CODEX_PASS_ENV ?? (process.env.CODEX_HOME ? 'CODEX_HOME' : '')).split(',').filter(Boolean) },
    });
    console.log(JSON.stringify(report, null, 2));
    assert.equal(report.taskState, 'REVIEW_PENDING', `${report.taskState}: ${report.stateReason}`);
    assert.equal(report.git.sourceHeadUnchanged, true);
    assert.equal(report.git.existingRefsUnchanged, true);
    assert.deepEqual(report.git.unexpectedNewRefs, []);
  });
});

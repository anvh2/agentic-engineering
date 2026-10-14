import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { capacityFor } from '../../src/runtime/capacity/model-capacity.ts';
import { tempDir } from '../../src/runtime/scheduler/test-helpers.ts';
import { HTTP_SMOKE_LIMITS, HTTP_SMOKE_OPT_IN_ENV, checkHttpSmokeAuthorization } from '../provider-smoke/http-smoke-guards.ts';
import { SmokeCancellationUnconfirmed, TASK_ID, runSchedulerSmoke, type SmokeOptions } from '../provider-smoke/scheduler-smoke.ts';

/**
 * The full HTTP execution path with a FAKE Codex CLI (no network, no account, no model):
 *
 *   Scheduler -> createMastraExecutor -> HTTP -> a real Mastra server (child process) -> coding-task-workflow
 *   -> Codex adapter -> fake CLI in an isolated worktree -> runtime verifier (sandboxed `go test`) -> REVIEW_PENDING
 *
 * Each test that needs a server starts its own (own port, own storage, own env), so the operator's `mastra dev` is never used.
 */

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'workers', 'providers', '__testing__', 'fake-codex.mjs');
const RIGHT = 'package smoke\n\n// Double returns n multiplied by two.\nfunc Double(n int) int {\n\treturn n * 2\n}\n';
const WRONG = 'package smoke\n\n// Double returns n multiplied by two.\nfunc Double(n int) int {\n\treturn n + 2\n}\n';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (cond: () => boolean, what: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

function smoke(extra: Partial<SmokeOptions> & { fake?: Record<string, string>; termGraceMs?: number; maxInvocations?: number; serverAllow?: string[] } = {}) {
  const outDir = tempDir('http-smoke-');
  const capacityDb = join(outDir, 'capacity.db');
  const { fake, termGraceMs, maxInvocations, serverAllow, ...rest } = extra;
  const options: SmokeOptions = {
    outDir,
    transport: 'http',
    codex: { command: FAKE, model: 'gpt-fake', termGraceMs: termGraceMs ?? 200, env: { FAKE_FILE: 'smoke/double.go', FAKE_CONTENT: JSON.stringify(RIGHT), FAKE_LOG: join(outDir, 'fake-codex.log'), ...fake } },
    http: { capacityDb, maxInvocations, serverAllowProviders: serverAllow, pollMs: 100, ...rest.http },
    modelTimeoutMs: 20_000,
    log: () => {},
    ...rest,
  };
  options.http = { capacityDb, maxInvocations, serverAllowProviders: serverAllow, pollMs: 100, ...rest.http };
  return { outDir, capacityDb, options, run: () => runSchedulerSmoke(options) };
}

/** A hanging fake CLI plus the signal plumbing of the smoke command. */
function hanging(extra: Parameters<typeof smoke>[0] = {}) {
  const pidfile = join(tempDir('http-smoke-pid-'), 'pid');
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const logs: string[] = [];
  const s = smoke({ ...extra, fake: { FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile, ...extra.fake }, signalSource: emitter, exit: (c) => exits.push(c), log: (l) => logs.push(l) });
  const run = s.run();
  run.catch(() => {});
  const pid = async () => {
    await waitFor(() => existsSync(pidfile), 'the (fake) Codex CLI to be running under the Mastra server');
    return Number(readFileSync(pidfile, 'utf8'));
  };
  return { ...s, emitter, exits, logs, run, pid };
}

const execLines = (log: string) =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args?: string[] })
    .filter((e) => e.args?.[0] === 'exec' && !e.args.includes('--help'));

describe('Codex HTTP smoke: gates (pure)', () => {
  it('is disabled unless the operator opts in', () => {
    const r = checkHttpSmokeAuthorization({ AGENTIC_ALLOW_PROVIDERS: 'codex:smoke-double' });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /disabled by default/);
    assert.equal(checkHttpSmokeAuthorization({ [HTTP_SMOKE_OPT_IN_ENV]: 'codex', AGENTIC_ALLOW_PROVIDERS: 'codex' }).ok, false, 'the in-process opt-in value does not enable the HTTP smoke');
  });
  it('rejects a missing or unrelated cloud-provider allow-list', () => {
    for (const allow of [undefined, '', 'codex:other-task', 'gemini']) {
      const r = checkHttpSmokeAuthorization({ [HTTP_SMOKE_OPT_IN_ENV]: 'codex-http', AGENTIC_ALLOW_PROVIDERS: allow });
      assert.equal(r.ok, false, `allow-list ${JSON.stringify(allow)}`);
      assert.match((r as { reason: string }).reason, /no operator authorization/);
    }
  });
  it('accepts no task input: a single fixed objective only', () => {
    const r = checkHttpSmokeAuthorization({ [HTTP_SMOKE_OPT_IN_ENV]: 'codex-http', AGENTIC_ALLOW_PROVIDERS: 'codex:smoke-double' }, ['--task', 'something-else']);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /no arguments/);
  });
  it('narrows whatever the operator allowed to this one task, for both processes', () => {
    for (const allow of ['codex', 'codex:smoke-double', 'codex,codex:other']) {
      const r = checkHttpSmokeAuthorization({ [HTTP_SMOKE_OPT_IN_ENV]: 'codex-http', AGENTIC_ALLOW_PROVIDERS: allow });
      assert.deepEqual(r, { ok: true, allowProviders: ['codex:smoke-double'] });
    }
    assert.equal(HTTP_SMOKE_LIMITS.maxProviderInvocations, 1);
    assert.equal(HTTP_SMOKE_LIMITS.automaticRuntimeRetries, 0);
  });
});

describe('Codex HTTP smoke: scheduler -> Mastra HTTP server -> workflow -> fake Codex (deterministic)', () => {
  it('success: verifier PASS, REVIEW_PENDING, nothing integrated, everything accounted for', async () => {
    const s = smoke();
    const { report } = await s.run();
    assert.equal(report.transport, 'http');
    assert.equal(report.taskState, 'REVIEW_PENDING', JSON.stringify(report.schedulerEvents));
    assert.equal(report.claims, 1);
    assert.equal(report.codingAttempts, 1);
    assert.equal(report.runtimeRetries, 0);
    assert.deepEqual(report.requeued, []);
    assert.deepEqual(report.stillActive, []);
    assert.deepEqual(report.verifier[0]?.exitCode, 0);
    assert.equal(report.git.sourceHeadUnchanged, true);
    assert.equal(report.git.sourceStatusClean, true);
    assert.equal(report.git.existingRefsUnchanged, true);
    assert.deepEqual(report.git.unexpectedNewRefs, []);
    assert.equal(report.git.fsckOk, true);
    assert.equal(report.git.worktreeStatus, '');
    // captured evidence
    assert.match(report.runId ?? '', /^[0-9a-f-]{36}$/, 'the Mastra run id (a uuid minted by the HTTP client)');
    assert.match(report.studioUrl ?? '', /\/workflows\/coding-task-workflow\/graph\//);
    const path = report.schedulerEvents.map((e) => e.to).filter((to, i, all) => to !== all[i - 1]);
    assert.deepEqual(path, ['BACKLOG', 'READY', 'CLAIMED', 'CODING', 'VERIFYING', 'REVIEW_PENDING'], 'the lifecycle, in order, ending at review (never integrated)');
    assert.equal(report.telemetry[0]?.provider, 'codex');
    // the HTTP path really was used, with the production client and a server the harness started and then stopped
    const b = report.backend as Record<string, any>;
    assert.equal(b.transport, 'http');
    assert.equal(b.serverStartedByHarness, true);
    assert.equal(b.providerInvocations, 1);
    assert.equal(b.providerInvocationsRefused, 0);
    assert.equal(b.providerProcessesSpawned, 1);
    assert.equal(b.shutdown.exited, true, JSON.stringify(b.shutdown));
    assert.ok(!alive(b.serverPid), 'the smoke Mastra server is gone');
    assert.ok(report.processes.length === 1 && report.processes.every((p) => p.groupGone));
    // the adapter's containment flags survive the HTTP hop
    const runs = execLines(join(s.outDir, 'fake-codex.log'));
    assert.equal(runs.length, 1);
    const args = runs[0].args!;
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.ok(args.includes('--ignore-user-config'));
    assert.ok(!args.some((a) => /dangerously|bypass|full-auto|danger-full-access|--add-dir/.test(a)));
    assert.equal(args[args.indexOf('--cd') + 1], report.paths.worktree, 'the CLI runs in the task worktree, not the source repository');
    // written to disk for the operator
    assert.ok(existsSync(join(s.outDir, 'report.json')));
  });

  it('authorization mismatch: the scheduler allows codex, the SERVER process does not -> refused there, the CLI never starts', async () => {
    const s = smoke({ serverAllow: [] });
    const { report } = await s.run();
    assert.equal(report.taskState, 'RUNTIME_FAILURE');
    assert.equal(report.failureCategory, 'provider_not_authorized');
    assert.match(report.stateReason ?? '', /not authorized|allow/i);
    const b = report.backend as Record<string, any>;
    assert.equal(b.providerInvocations, 0);
    assert.equal(b.providerProcessesSpawned, 0);
    const fakeLog = join(s.outDir, 'fake-codex.log');
    assert.equal(existsSync(fakeLog) ? execLines(fakeLog).length : 0, 0, 'no `codex exec` was ever run');
    assert.equal(report.git.worktreeStatus, '');
    assert.equal(report.runId !== null, true, 'the refusal came from a real Mastra run, so there is a run id to audit');
  });

  it('authorization mismatch: the scheduler does not allow it -> refused before any HTTP request is made', async () => {
    const hits: string[] = [];
    const stub = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.statusCode = 500;
      res.end('stub');
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    try {
      const s = smoke({ schedulerAllowProviders: [], http: { existingServer: `http://127.0.0.1:${(stub.address() as AddressInfo).port}` } });
      const { report } = await s.run();
      assert.equal(report.taskState, 'RUNTIME_FAILURE');
      assert.equal(report.failureCategory, 'provider_not_authorized');
      assert.deepEqual(hits, [], 'the server was never contacted');
      assert.equal(report.claims, 1);
    } finally {
      stub.close();
    }
  });

  it('unreachable server: an infrastructure failure, no provider call, nothing requeued', async () => {
    const closed = await new Promise<number>((r) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as AddressInfo;
        s.close(() => r(port));
      });
    });
    const s = smoke({ http: { existingServer: `http://127.0.0.1:${closed}` } });
    const { report } = await s.run();
    assert.equal(report.taskState, 'RUNTIME_FAILURE');
    assert.equal(report.failureCategory, 'executor_error');
    assert.match(report.stateReason ?? '', /Cannot start the workflow/);
    assert.deepEqual(report.requeued, []);
    assert.deepEqual(report.processes, []);
    assert.equal(report.claims, 1);
  });

  it('HTTP error from the server: reported as an executor failure, not a verdict', async () => {
    const stub = createServer((_req, res) => {
      res.statusCode = 503;
      res.end('service unavailable');
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    try {
      const s = smoke({ http: { existingServer: `http://127.0.0.1:${(stub.address() as AddressInfo).port}` } });
      const { report } = await s.run();
      assert.equal(report.taskState, 'RUNTIME_FAILURE');
      assert.match(report.stateReason ?? '', /HTTP 503/);
      assert.deepEqual(report.processes, []);
    } finally {
      stub.close();
    }
  });

  it('invocation bound: a second provider call (the runner would retry a failing verification) is refused inside the server', async () => {
    const s = smoke({ fake: { FAKE_CONTENT: JSON.stringify(WRONG) }, maxInvocations: 1 });
    const { report } = await s.run();
    const b = report.backend as Record<string, any>;
    assert.equal(b.providerInvocations, 1, 'exactly one `codex exec` ran');
    assert.equal(b.providerProcessesSpawned, 1);
    assert.equal(b.providerInvocationsRefused, 1, 'the second attempt was stopped before it started');
    assert.notEqual(report.taskState, 'REVIEW_PENDING', 'a wrong answer is never a pass');
    assert.equal(execLines(join(s.outDir, 'fake-codex.log')).length, 1);
    assert.ok(report.processes.every((p) => p.groupGone));
  });
});

describe('Codex HTTP smoke: cancellation and timeouts through HTTP (deterministic)', () => {
  it('SIGINT during execution: cancel propagates over HTTP to the workflow and the owned Codex process group; permit released; auditable', async () => {
    const h = hanging({ termGraceMs: 300 });
    const pid = await h.pid();
    // the provider permit is held, in the server's process, while inference is active, and the scheduler can see it
    const capacity = capacityFor(undefined, h.capacityDb);
    await waitFor(() => capacity.engagedBy(TASK_ID).length > 0, 'the server to hold the codex permit');
    assert.ok(alive(pid));
    h.emitter.emit('SIGINT');
    const { report } = await h.run;
    assert.equal(report.cancellation?.confirmed, true, JSON.stringify(report.cancellation));
    assert.equal(report.cancellation?.signal, 'SIGINT');
    assert.equal(alive(pid), false, 'the Codex process is gone (it ignores SIGTERM, so it was SIGKILLed after the grace period)');
    assert.deepEqual(report.processes, [{ pid, groupGone: true }]);
    assert.deepEqual(capacity.engagedBy(TASK_ID), [], 'the permit was released only after the process was gone');
    assert.equal(report.taskState, 'RUNTIME_FAILURE');
    assert.equal(report.claims, 1);
    assert.deepEqual(report.requeued, []);
    assert.deepEqual(report.stillActive, []);
    assert.deepEqual(h.exits, []);
    // every cancelled attempt is auditable, with what was (and was not) confirmed
    const audit = report.schedulerEvents.find((e) => /run cancellation/.test(e.reason ?? ''));
    assert.ok(audit, JSON.stringify(report.schedulerEvents));
    assert.match(audit!.reason ?? '', /scheduler stopped.*stopped/);
    assert.equal((audit!.detail as { runId?: string }).runId, report.runId);
    assert.equal((report.backend as Record<string, any>).providerInvocations, 1, 'no second paid call after the cancel');
    assert.equal((report.backend as Record<string, any>).shutdown.exited, true);
    h.emitter.emit('SIGINT'); // handlers were removed: nothing happens
    assert.deepEqual(h.exits, []);
  });

  it('a second signal exits at once, SIGKILLs only the groups the server started and says what is unconfirmed', async () => {
    const h = hanging({ termGraceMs: 4_000 });
    const pid = await h.pid();
    h.emitter.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(pid), true, 'still inside the SIGTERM grace period');
    h.emitter.emit('SIGINT');
    assert.deepEqual(h.exits, [130]);
    const line = h.logs.find((l) => /^SIGINT again: exiting/.test(l)) ?? '';
    assert.ok(line.includes(`(SIGKILL sent, NOT confirmed): ${pid};`), line);
    assert.match(line, /Mastra smoke server pid \d+ sent SIGTERM \(NOT confirmed\)/);
    await waitFor(() => !alive(pid), 'the owned group to die from the second signal', 8_000);
    // The server that was confirming the cancel was itself told to stop, so nothing about the run could be confirmed: the harness
    // says so (it throws with the evidence) instead of reporting a clean stop.
    const err = await h.run.then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof SmokeCancellationUnconfirmed, String(err));
    const c = (err as SmokeCancellationUnconfirmed).report.cancellation as Record<string, any>;
    assert.equal(c.confirmed, false);
    assert.deepEqual(c.secondSignal.sentSigkillTo, [pid]);
    assert.equal(c.secondSignal.server.sigtermSent, true);
    assert.ok(((err as SmokeCancellationUnconfirmed).report.processes as { groupGone: boolean }[]).every((p) => p.groupGone));
  });

  it('active-execution timeout: the run is cancelled over HTTP and confirmed; no late result can complete the task', async () => {
    const h = hanging({ termGraceMs: 200, taskTimeoutMs: 10_000 }); // the budget includes starting the CLI inside the server step; 2.5 s only held on a quiet machine
    const pid = await h.pid();
    const { report } = await h.run;
    assert.equal(report.taskState, 'RUNTIME_FAILURE');
    assert.equal(report.failureCategory, 'task_timeout');
    assert.equal(alive(pid), false);
    assert.deepEqual(report.stillActive, [], 'the cancel was confirmed (run terminal, permit released)');
    assert.ok(report.schedulerEvents.some((e) => /run cancellation \(task timeout\): stopped/.test(e.reason ?? '')), JSON.stringify(report.schedulerEvents));
    assert.deepEqual(report.processes, [{ pid, groupGone: true }]);
    assert.equal(report.claims, 1);
    assert.deepEqual(report.requeued, []);
  });

  it('cancellation that cannot be confirmed fails loudly, keeps the evidence and LEAVES the server (the process supervisor) running', async () => {
    const h = hanging({ termGraceMs: 20_000, cancelDeadlineMs: 500 });
    const pid = await h.pid();
    let serverPid = 0;
    try {
      h.emitter.emit('SIGINT');
      const err = await h.run.then(() => undefined, (e: unknown) => e);
      assert.ok(err instanceof SmokeCancellationUnconfirmed, String(err));
      assert.match((err as Error).message, /NOT confirmed/);
      assert.match((err as Error).message, /report\.json/);
      const backend = (err as SmokeCancellationUnconfirmed).report.backend as Record<string, any>;
      serverPid = backend.serverPid;
      assert.match(String(backend.shutdown.skipped), /left running/);
      assert.equal(alive(pid), true, 'the harness did not pretend the process was gone');
      assert.equal(alive(serverPid), true, 'the server stays up while a provider process may still be running');
      const written = JSON.parse(readFileSync(join(h.outDir, 'report.json'), 'utf8'));
      assert.equal(written.cancellation.confirmed, false);
      assert.deepEqual(written.cancellation.stillAlive, [pid]);
    } finally {
      for (const [target, how] of [[-pid, 'SIGKILL'], [serverPid, 'SIGKILL']] as const) {
        try {
          if (target) process.kill(target, how); // cleanup of processes THIS test started
        } catch {
          /* gone */
        }
      }
    }
  });
});

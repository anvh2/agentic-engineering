import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capacityFor } from '../../src/runtime/capacity/model-capacity.ts';
import { runCodingTask } from '../../src/runtime/execution/coding-task-runner.ts';
import type { FaultPlan } from '../../src/runtime/reliability/faults.ts';
import { cancelTaskRun } from '../../src/runtime/scheduler/cancel.ts';
import { SchedulerStore } from '../../src/runtime/scheduler/store.ts';
import { TASK_ID, runSchedulerSmoke } from '../provider-smoke/scheduler-smoke.ts';
import type { Evidence } from './classify.ts';

/**
 * Reliability Lab scenarios (M10). Two kinds, so nothing that already exists is rebuilt:
 *
 *   smoke      the real path - scheduler -> HTTP -> Mastra server child -> coding workflow -> Gemini adapter -> fake CLI in a
 *              sandbox - with one interleaving FORCED by a fault point or the fake CLI's start delay;
 *   node-test  an existing deterministic test, run by name in a child process (failure-injection.test.ts,
 *              model-capacity.test.ts, store.test.ts), its outcome recorded as evidence;
 *   inprocess  a direct check against the runtime modules (fast, no child process).
 *
 * A scenario returns the part of the evidence it knows; run.ts adds identity, timing and the environment.
 */

export type ScenarioResult = Pick<Evidence, 'ok' | 'failure' | 'runtime'> & { detail?: Record<string, unknown> };

export interface Scenario {
  id: string;
  kind: 'smoke' | 'node-test' | 'inprocess';
  covers: string;
  run(): Promise<ScenarioResult>;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
const fail = (message: string, runtime?: ScenarioResult['runtime'], detail?: Record<string, unknown>): ScenarioResult => ({ ok: false, failure: { message }, runtime, detail });

interface SmokeRun {
  report: Record<string, any>;
  pidfile: string;
  prompts: number;
  fired: string[];
  runtime: NonNullable<ScenarioResult['runtime']>;
}

async function hangingSmoke(opts: { fake?: Record<string, string>; faults?: FaultPlan; taskTimeoutMs?: number; interruptAfterFault?: string }): Promise<SmokeRun> {
  const outDir = mkdtempSync(join(tmpdir(), 'reliability-smoke-'));
  const pidfile = join(outDir, 'pid');
  const capacityDb = join(outDir, 'capacity.db');
  const fakeLog = join(outDir, 'fake-gemini.log');
  const faultLog = join(outDir, 'faults.jsonl');
  const signals = new EventEmitter();
  let watcher: NodeJS.Timeout | undefined;
  if (opts.interruptAfterFault) {
    // the operator's SIGINT, delivered once the run is provably held at the boundary
    watcher = setInterval(() => {
      if (existsSync(faultLog) && readFileSync(faultLog, 'utf8').includes(`"point":"${opts.interruptAfterFault}"`)) {
        clearInterval(watcher);
        signals.emit('SIGINT');
      }
    }, 20);
  }
  try {
    const { report } = await runSchedulerSmoke({
      outDir,
      transport: 'http',
      provider: 'gemini',
      gemini: { command: FAKE, termGraceMs: 200, env: { FAKE_FILE: 'smoke/double.go', FAKE_CONTENT: JSON.stringify(RIGHT), FAKE_LOG: fakeLog, FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile, ...opts.fake } },
      http: { capacityDb, maxInvocations: 1, pollMs: 100, ...(opts.faults ? { faults: opts.faults } : {}) },
      modelTimeoutMs: 20_000,
      taskTimeoutMs: opts.taskTimeoutMs ?? 2_500,
      signalSource: signals,
      exit: () => {},
      log: () => {},
    });
    const r = report as Record<string, any>;
    const prompts = existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args?: string[] }).filter((e) => e.args?.includes('--prompt')).length : 0;
    const fired = existsSync(faultLog) ? readFileSync(faultLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).point as string) : [];
    const cancel = (r.schedulerEvents as { reason?: string }[]).map((e) => /run cancellation \([^)]*\): (\w+)/.exec(e.reason ?? '')?.[1]).find(Boolean) ?? null;
    const engaged = capacityFor({ resource: 'gemini', defaultPermits: 1 }, capacityDb).engagedBy(TASK_ID).map((x) => ({ ...x, resource: 'gemini', alive: alive(x.pid) }));
    return { report: r, pidfile, prompts, fired, runtime: { taskState: r.taskState, failureCategory: r.failureCategory, cancelOutcome: cancel, processes: r.processes, engaged, taskResource: 'gemini', claims: r.claims, requeued: r.requeued, faultsFired: fired, prompts } };
  } finally {
    if (watcher) clearInterval(watcher);
  }
}

/** The invariants of any clean stop of a hung provider run, as failures. */
function cleanStop(s: SmokeRun, expectCategory: 'task_timeout' | null): string[] {
  const p: string[] = [];
  if (s.report.taskState !== 'RUNTIME_FAILURE') p.push(`task state ${s.report.taskState}, expected RUNTIME_FAILURE`);
  if (expectCategory && s.report.failureCategory !== expectCategory) p.push(`failure category ${s.report.failureCategory}, expected ${expectCategory}`);
  if ((s.report.stillActive ?? []).length) p.push(`still_active: ${JSON.stringify(s.report.stillActive)}`);
  if (s.runtime.cancelOutcome !== 'stopped') p.push(`cancel outcome ${s.runtime.cancelOutcome}, expected stopped`);
  if (s.runtime.engaged?.length) p.push(`model permit still engaged: ${JSON.stringify(s.runtime.engaged)}`);
  if ((s.report.processes ?? []).some((x: { pid: number; groupGone: boolean }) => !x.groupGone || alive(x.pid))) p.push(`provider process alive: ${JSON.stringify(s.report.processes)}`);
  if (s.report.claims !== 1 || (s.report.requeued ?? []).length) p.push(`claims=${s.report.claims} requeued=${JSON.stringify(s.report.requeued)}`);
  return p;
}

/** One REAL execution of the coding runner holding a model permit (a model double that blocks until the run is aborted). */
function holdingRun(runId: string, capacity: ReturnType<typeof capacityFor>): { entered: Promise<void>; stop(): Promise<void> } {
  const root = mkdtempSync(join(tmpdir(), 'reliability-run-'));
  mkdirSync(join(root, 'calc'));
  writeFileSync(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
  writeFileSync(join(root, 'calc', 'calc.go'), 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n');
  writeFileSync(join(root, 'calc', 'calc_test.go'), 'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif Double(3) != 6 {\n\t\tt.Fatal("no")\n\t}\n}\n');
  const ctl = new AbortController();
  let enter!: () => void;
  let ended!: (why: string) => void;
  const entered = Promise.race([new Promise<void>((r) => (enter = r)), new Promise<void>((_, reject) => (ended = (why) => reject(new Error(`run ${runId} ended before the model call: ${why}`))))]);
  const worker = {
    async generate(_prompt: string, opts: { abortSignal?: AbortSignal }) {
      enter();
      await new Promise<void>((_, reject) => opts.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return { text: '', finishReason: 'stop', steps: [{}] };
    },
  };
  const done = runCodingTask(
    { taskId: 'T', objective: 'Implement Double', allowedFiles: ['calc/calc.go'], contextFiles: ['calc/calc_test.go'], acceptanceCriteria: [], verificationCommands: [['go', 'test', '-count=1', './calc']], constraints: [] },
    { repoRoot: root, worker, capacity, runId, signal: ctl.signal, modelLabel: 'lab:model', maxAttempts: 1, runtimeRetryDelayMs: 0, abortGraceMs: 100 },
  ).then(
    (r) => ended(r.sandboxUnavailable ? `sandbox unavailable: ${r.sandboxUnavailable}` : `verdict ${r.verdict}`),
    (e) => ended((e as Error).message),
  );
  return { entered, stop: async () => (ctl.abort(new Error('scenario over')), void (await done)) };
}

function nodeTest(file: string, pattern: string): () => Promise<ScenarioResult> {
  return async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // a nested node --test must report to us, not to an enclosing runner
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, file], { cwd: ROOT, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
    const out = r.stdout ?? '';
    const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0);
    const failed = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0);
    const detail = { file, pattern, exitCode: r.status, pass, fail: failed };
    if (r.error) return fail(`could not run ${file}: ${r.error.message}`, undefined, detail);
    if (pass === 0) return fail(`no test matched ${JSON.stringify(pattern)} in ${file}`, undefined, detail);
    if (failed > 0 || r.status !== 0) return fail(/^\s+error: (.*)$/m.exec(out)?.[1] ?? `node --test exit ${r.status}`, undefined, detail);
    return { ok: true, detail };
  };
}

export const SCENARIOS: Record<string, Scenario> = {
  'timeout-before-spawn': {
    id: 'timeout-before-spawn',
    kind: 'smoke',
    covers: 'active-execution timeout while the run is held right before the provider spawn: nothing may ever start (no late spawn)',
    async run() {
      const s = await hangingSmoke({ faults: { 'provider.before-spawn': { delayMs: 60_000 } } });
      const p = cleanStop(s, 'task_timeout');
      if (!s.fired.includes('provider.before-spawn')) p.push('the boundary was never reached');
      if ((s.report.processes ?? []).length) p.push(`a provider process was started: ${JSON.stringify(s.report.processes)}`);
      if (s.prompts) p.push(`the CLI received ${s.prompts} prompt(s)`);
      return p.length ? fail(p.join('; '), s.runtime) : { ok: true, runtime: s.runtime };
    },
  },
  'timeout-spawned-not-ready': {
    id: 'timeout-spawned-not-ready',
    kind: 'smoke',
    covers: 'timeout after the CLI process exists but before it reports in (the historical flaky interleaving, forced)',
    async run() {
      // the 60 s start delay forces 'not ready'; the 15 s budget only has to land after the spawn (see gemini-http-smoke.test.ts)
      const s = await hangingSmoke({ fake: { FAKE_START_DELAY_MS: '60000' }, taskTimeoutMs: 15_000 });
      const p = cleanStop(s, 'task_timeout');
      if (existsSync(s.pidfile)) p.push('the CLI became ready: the interleaving was not forced');
      if ((s.report.processes ?? []).length !== 1) p.push(`expected exactly one started provider process, got ${JSON.stringify(s.report.processes)}`);
      return p.length ? fail(p.join('; '), s.runtime) : { ok: true, runtime: s.runtime };
    },
  },
  'timeout-after-ready': {
    id: 'timeout-after-ready',
    kind: 'smoke',
    covers: 'the original scenario and budget, unforced: whichever interleaving occurs, the stop is clean',
    async run() {
      const s = await hangingSmoke({});
      const p = cleanStop(s, 'task_timeout');
      return p.length ? fail(p.join('; '), s.runtime, { ready: existsSync(s.pidfile) }) : { ok: true, runtime: s.runtime, detail: { ready: existsSync(s.pidfile) } };
    },
  },
  'cancel-after-permit': {
    id: 'cancel-after-permit',
    kind: 'smoke',
    covers: 'operator SIGINT while the run holds the model permit but has not called the model: permit released, nothing spawned',
    async run() {
      const s = await hangingSmoke({ faults: { 'runner.after-permit': { delayMs: 60_000 } }, taskTimeoutMs: 120_000, interruptAfterFault: 'runner.after-permit' });
      const p = cleanStop(s, null);
      const c = s.report.cancellation as { confirmed?: boolean } | undefined;
      if (c?.confirmed !== true) p.push(`operator cancellation not confirmed: ${JSON.stringify(c)}`);
      if ((s.report.processes ?? []).length) p.push(`a provider process was started: ${JSON.stringify(s.report.processes)}`);
      return p.length ? fail(p.join('; '), s.runtime) : { ok: true, runtime: s.runtime };
    },
  },
  'lease-isolation': {
    id: 'lease-isolation',
    kind: 'inprocess',
    covers: 'M10 F2 (run-scoped permits): two REAL runs of one task id on two providers - a cancel is confirmed against its own run, a sibling run never blocks it, a permit nobody can attribute still does',
    async run() {
      const db = join(mkdtempSync(join(tmpdir(), 'reliability-lease-')), 'capacity.db');
      const gemini = capacityFor({ resource: 'gemini', defaultPermits: 1 }, db);
      const codex = capacityFor({ resource: 'codex', defaultPermits: 1 }, db);
      const probe = capacityFor(undefined, db); // the scheduler's single machine-wide handle
      const target = holdingRun('lab-target', gemini);
      const foreign = holdingRun('lab-foreign', codex);
      let legacy: { release(): void } | undefined;
      try {
        await Promise.all([target.entered, foreign.entered]);
        const cancel = (runId: string) => cancelTaskRun({ store: new SchedulerStore(':memory:'), executor: { cancel: async () => ({ run: 'terminal', runStatus: 'canceled' }) }, capacity: probe, task: { id: 'T', runId, spec: { request: { provider: 'gemini', contract: { taskId: 'T' } } } } as never, actor: 'reliability', reason: 'scenario', graceMs: 200, pollMs: 20 });
        const own = await cancel('lab-target');
        const idle = await cancel('lab-idle-sibling'); // holds nothing: both live runs are other runs' business
        legacy = await capacityFor({ resource: 'legacy-lab', defaultPermits: 1 }, db).acquire('gpt:T:pid4242', undefined, { tag: 'T' }); // the pre-run-id holder format on a third resource: owner unknown
        const unknown = await cancel('lab-idle-sibling');
        const proves = {
          ownPermitBlocksItsOwnCancel: own.outcome === 'still_active' && own.engaged.length === 1,
          foreignRunDoesNotBlock: idle.outcome === 'stopped',
          unattributablePermitFailsClosed: unknown.outcome === 'still_active',
        };
        const runtime = { cancelOutcome: idle.outcome, engaged: [...own.engaged, ...unknown.engaged].map((x) => ({ ...x, resource: x.holder.split(':')[0] })), taskResource: 'gemini' };
        const detail = { proves, targetRunId: 'lab-target', foreignRunId: 'lab-foreign', outcomes: { own: own.outcome, idleSibling: idle.outcome, withUnattributablePermit: unknown.outcome } };
        const wrong = Object.entries(proves).filter(([, ok]) => !ok).map(([k]) => k);
        return wrong.length === 0 ? { ok: true, runtime, detail } : fail(`not proved: ${wrong.join(', ')}: ${JSON.stringify(detail.outcomes)}`, runtime, detail);
      } catch (err) {
        return fail(`scenario could not run: ${(err as Error).message}`);
      } finally {
        legacy?.release();
        await Promise.all([target.stop(), foreign.stop()]);
      }
    },
  },
  'stale-lease': {
    id: 'stale-lease',
    kind: 'node-test',
    covers: 'a crashed permit holder (SIGKILL) frees the model at once; an expired scheduler lease returns the task and fences the stale worker',
    run: async () => {
      const a = await nodeTest('src/runtime/capacity/model-capacity.test.ts', 'a holder killed with SIGKILL loses its permit at once')();
      if (!a.ok) return a;
      const b = await nodeTest('src/runtime/scheduler/store.test.ts', 'an expired lease returns the task to READY')();
      if (!b.ok) return b;
      return nodeTest('src/runtime/scheduler/failure-injection.test.ts', 'the reaper never requeues a lease that its owner renewed')();
    },
  },
  'interrupted-run': {
    id: 'interrupted-run',
    kind: 'node-test',
    covers: 'a run orphaned by a server restart does not trap the task and is not executed twice',
    run: nodeTest('src/runtime/scheduler/failure-injection.test.ts', 'a run orphaned by a Mastra restart'),
  },
};

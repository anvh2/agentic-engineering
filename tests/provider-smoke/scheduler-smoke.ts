import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findProjectRoot } from '../../src/core/paths.ts';
import { createInProcessExecutor } from '../../src/integrations/mastra/__testing__/in-process-executor.ts';
import { createCodingTaskWorkflow } from '../../src/integrations/mastra/workflows/coding-task-workflow.ts';
import { capacityFor } from '../../src/runtime/capacity/model-capacity.ts';
import { Scheduler } from '../../src/runtime/scheduler/scheduler.ts';
import { budgetsMirroring } from '../../src/runtime/scheduler/test-helpers.ts';
import type { ProviderBudgetEntry } from '../../src/runtime/execution/provider-routing.ts';
import { SchedulerStore } from '../../src/runtime/scheduler/store.ts';
import { WorktreeManager } from '../../src/runtime/worktree/worktree.ts';
import { codexEntry, type CodexConfig } from '../../src/workers/providers/codex.ts';
import { geminiEntry, type GeminiConfig } from '../../src/workers/providers/gemini.ts';
import { ProviderRegistry } from '../../src/workers/providers/registry.ts';
import type { Executor } from '../../src/runtime/scheduler/scheduler.ts';
import { createHttpBackend, groupAlive, type SmokeBackend } from './http-backend.ts';
import type { FaultPlan } from '../../src/runtime/reliability/faults.ts';

/**
 * One task through the real scheduler on a disposable Go repository:
 *
 *   task request (provider: codex) -> Scheduler (operator allow-list) -> workflow -> Codex adapter -> isolated worktree
 *   -> runtime verifier (sandboxed `go test`) -> REVIEW_PENDING
 *
 * The same code runs against the mock CLI in CI (tests) and against the real Codex CLI in the opt-in smoke. The in-process
 * executor stands in for the HTTP hop to a Mastra server (covered by client tests); everything else is the production path.
 */

export const TASK_ID = 'smoke-double';
const STUB = '// Package smoke holds the disposable smoke-test fixture.\npackage smoke\n\n// Double returns n multiplied by two.\nfunc Double(n int) int {\n\treturn 0\n}\n';
const TEST_SRC = 'package smoke\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tfor in, want := range map[int]int{0: 0, 3: 6, -4: -8} {\n\t\tif got := Double(in); got != want {\n\t\t\tt.Fatalf("Double(%d) = %d, want %d", in, got, want)\n\t\t}\n\t}\n}\n';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 's@s' } }).trim();

/** Cancellation could not be confirmed within its deadline: a Codex process (or run) may still be alive. The report on disk says which. */
export class SmokeCancellationUnconfirmed extends Error {
  report: Record<string, unknown>;
  constructor(message: string, report: Record<string, unknown>) {
    super(message);
    this.name = 'SmokeCancellationUnconfirmed';
    this.report = report;
  }
}

export interface SmokeOptions {
  /** The cloud provider under test (default `codex`). The fixture, the bounds and the acceptance checks are the same for both. */
  provider?: 'codex' | 'gemini';
  codex?: CodexConfig;
  gemini?: GeminiConfig;
  /** `in-process` (default): the workflow runs in this process. `http`: through a dedicated Mastra server over HTTP (the production path). */
  transport?: 'in-process' | 'http';
  http?: {
    /** AGENTIC_ALLOW_PROVIDERS of the Mastra server process. Default: the same entry the scheduler gets. */
    serverAllowProviders?: string[];
    /** Hard cap on provider invocations enforced inside the server (default 1). */
    maxInvocations?: number;
    /** Talk to this address instead of starting a server (stubs; an address nothing listens on). */
    existingServer?: string;
    /** Capacity database shared by the scheduler and the server (default: the machine-wide one, as in production). */
    capacityDb?: string;
    startTimeoutMs?: number;
    pollMs?: number;
    /** Reliability Lab fault plan for the Mastra server; each firing is logged to <outDir>/faults.jsonl. */
    faults?: FaultPlan;
  };
  /** The scheduler's own operator allow-list (default: `<provider>:smoke-double`). */
  schedulerAllowProviders?: string[];
  /** The scheduler's operator budget (M12). Default: one claim per allow-list entry. */
  schedulerBudgets?: ProviderBudgetEntry[];
  /** Active-execution budget of the task (default: modelTimeoutMs + 2 minutes). */
  taskTimeoutMs?: number;
  /** Where SIGINT/SIGTERM are heard (default: this process). Tests inject an emitter. */
  signalSource?: { on(event: string, listener: (...a: unknown[]) => void): unknown; off(event: string, listener: (...a: unknown[]) => void): unknown };
  /** Called on the SECOND signal, after owned process groups were sent SIGKILL (default: process.exit). */
  exit?: (code: number) => void;
  /** Time allowed, after the first signal, for the run to stop AND every Codex process group to be gone (default 45 s). */
  cancelDeadlineMs?: number;
  log?: (line: string) => void;
  /** Directory for the fixture, state and report. Default: .workdir/m8.2-smoke/<timestamp>. */
  outDir?: string;
  modelTimeoutMs?: number;
}

export async function runSchedulerSmoke(options: SmokeOptions) {
  const outDir = options.outDir ?? join(findProjectRoot() ?? process.cwd(), '.workdir', 'm8.2-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outDir, { recursive: true });
  const repo = mkdtempSync(join(outDir, 'repo-'));
  for (const [path, content] of Object.entries({ 'go.mod': 'module example.com/smoke\n\ngo 1.22\n', 'smoke/double.go': STUB, 'smoke/double_test.go': TEST_SRC, 'README.md': '# smoke fixture\n' })) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'fixture');
  const refs = () => sh(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
  const before = { head: sh(repo, 'rev-parse', 'HEAD'), refs: refs() };

  const modelTimeoutMs = options.modelTimeoutMs ?? 300_000;
  const log = options.log ?? ((l: string) => console.error(l));
  const schedulerLog: string[] = [];
  const taskTimeoutMs = options.taskTimeoutMs ?? modelTimeoutMs + 120_000;
  const maxCapacityWaitMs = 60_000;
  const providerId = options.provider ?? 'codex';
  const label = providerId === 'gemini' ? 'Gemini' : 'Codex';
  const schedulerAllow = options.schedulerAllowProviders ?? [`${providerId}:${TASK_ID}`];
  const http = options.transport === 'http';
  // The backend is the only thing that differs between the in-process smoke and the HTTP smoke: how the workflow is reached and
  // how the provider processes it starts are accounted for. Everything below (scheduler, worktree, verifier, report) is shared.
  const backend: SmokeBackend = http
    ? await createHttpBackend({
        outDir,
        provider: providerId,
        codex: options.codex,
        gemini: options.gemini,
        serverAllowProviders: options.http?.serverAllowProviders ?? schedulerAllow,
        maxInvocations: options.http?.maxInvocations ?? 1,
        modelTimeoutMs,
        capacityDb: options.http?.capacityDb,
        existingServer: options.http?.existingServer,
        startTimeoutMs: options.http?.startTimeoutMs,
        executor: { pollMs: options.http?.pollMs, taskTimeoutMs: taskTimeoutMs + maxCapacityWaitMs },
        ...(options.http?.faults ? { faults: options.http.faults, faultsLog: join(outDir, 'faults.jsonl') } : {}),
        log,
      })
    : inProcessBackend(options, outDir, modelTimeoutMs);
  const executor = backend.executor;
  const stillAlive = () => backend.stillAlive();
  const store = new SchedulerStore(join(outDir, 'scheduler.db'));
  store.createBatch({
    batchId: 'smoke',
    project: 'smoke',
    repository: repo,
    description: `${label} scheduler smoke`,
    integrationCommands: [],
    tasks: [
      {
        id: TASK_ID,
        title: 'Implement Double',
        priority: 50,
        executor: 'worker',
        maxClaims: 1,
        request: {
          contract: {
            taskId: TASK_ID,
            objective: 'Implement Double in smoke/double.go so that Double(n) returns n * 2. Keep the existing comments.',
            allowedFiles: ['smoke/double.go'],
            contextFiles: ['smoke/double_test.go'],
            acceptanceCriteria: ['TestDouble passes'],
            verificationCommands: [['go', 'test', '-count=1', './...']],
            constraints: ['tests are immutable'],
          },
          assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one function with an existing test' },
          provider: providerId,
        },
      },
    ],
  } as never);
  store.promote();

  const scheduler = new Scheduler({
    store,
    executor,
    workspace: new WorktreeManager(join(outDir, 'worktrees')),
    capacity: capacityFor(undefined, options.http?.capacityDb),
    allowProviders: schedulerAllow,
    // M12: the operator budget is one claim per authorized task, the same bound the smoke states for its single claim.
    providerBudgets: options.schedulerBudgets ?? budgetsMirroring(schedulerAllow, 1),
    describeProvider: (id) => (id === 'codex' ? codexEntry().describe() : id === 'gemini' ? geminiEntry().describe() : undefined),
    config: { maxConcurrentWorkers: 1, pollMs: 500, workerLeaseTimeoutMs: 60_000, taskTimeoutMs, maxCapacityWaitMs },
    log: (l) => {
      schedulerLog.push(l);
      console.log(`  ${l}`);
    },
  });
  // ---- signals: first = graceful stop with confirmation, second = prompt exit with a report of what may be orphaned ----
  const source = options.signalSource ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const cancelDeadlineMs = options.cancelDeadlineMs ?? 45_000;
  let interrupted: { signal: string; at: number } | undefined;
  let secondSignal: { signal: string; sentSigkillTo: number[]; server?: { pid: number; sigtermSent: boolean } } | undefined;
  let signals = 0;
  let hitDeadline!: () => void;
  const deadlineReached = new Promise<'deadline'>((r) => (hitDeadline = () => r('deadline')));
  let deadlineTimer: NodeJS.Timeout | undefined;
  const onSignal = (name: string) => {
    signals += 1;
    if (signals === 1) {
      interrupted = { signal: name, at: Date.now() };
      log(`${name}: stopping. Nothing new is claimed; cancelling the ${label} run and waiting up to ${Math.round(cancelDeadlineMs / 1000)}s for its process group to exit (send ${name} again to exit immediately).`);
      deadlineTimer = setTimeout(hitDeadline, cancelDeadlineMs);
      scheduler.stop();
      return;
    }
    const killed = backend.killOwned();
    const live = killed.sentSigkillTo;
    secondSignal = { signal: name, ...killed };
    log(`${name} again: exiting without waiting. ${label} process group(s) possibly still running (SIGKILL sent, NOT confirmed): ${live.length ? live.join(', ') : 'none'};${killed.server ? ` Mastra smoke server pid ${killed.server.pid} sent SIGTERM (NOT confirmed);` : ''} in flight: ${scheduler.inFlight().map((t) => `${t.taskId} (run ${t.runId ?? 'unknown'})`).join(', ') || 'none'}. Check with: ps -o pid,pgid,command -g <pid>`);
    exit(130);
  };
  const handlers: [string, () => void][] = [['SIGINT', () => onSignal('SIGINT')], ['SIGTERM', () => onSignal('SIGTERM')]];
  for (const [name, h] of handlers) source.on(name, h);

  const started = Date.now();
  let summary: Awaited<ReturnType<Scheduler['run']>>;
  const runPromise = scheduler.run();
  runPromise.catch(() => {});
  try {
    const first = await Promise.race([runPromise, deadlineReached]);
    if (first === 'deadline') summary = { claimed: [], reviewPending: [], failed: [], requeued: [], peakInFlight: 0, stopReason: 'aborted', stillActive: [] };
    else summary = first;
  } finally {
    for (const [name, h] of handlers) source.off(name, h);
  }
  // After a stop, the run has settled, but "settled" is not "gone": confirm every owned process group independently, within the deadline.
  let cancellation: Record<string, unknown> | undefined;
  if (interrupted) {
    const deadline = interrupted.at + cancelDeadlineMs;
    while (stillAlive().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    clearTimeout(deadlineTimer);
    const live = stillAlive();
    const runStopped = Date.now() < deadline && scheduler.inFlight().length === 0;
    cancellation = {
      signal: interrupted.signal,
      confirmed: live.length === 0 && runStopped && summary.stillActive.length === 0,
      elapsedMs: Date.now() - interrupted.at,
      ownedProcessGroups: backend.ownedPids().map((pid) => ({ pid, groupGone: !groupAlive(pid) })),
      stillAlive: live,
      runStillInFlight: scheduler.inFlight(),
      unconfirmedRuns: summary.stillActive,
      secondSignal: secondSignal ?? null,
    };
  }
  const elapsedMs = Date.now() - started;

  // The server this harness started is stopped last, and only if no provider process is left: while one may still run, its
  // supervisor (the server's runner, which holds the permit and escalates to SIGKILL) must keep running.
  const providerLeftRunning = stillAlive().length > 0;
  const backendShutdown = providerLeftRunning ? { skipped: 'a provider process is not confirmed gone: the smoke server was left running so its runner keeps supervising it' } : await backend.shutdown();

  const task = store.requireTask(TASK_ID);
  const worktree = task.worktreePath ?? undefined;
  const artifactDir = typeof task.artifacts.artifactDir === 'string' ? task.artifacts.artifactDir : undefined;
  const attempts = artifactDir && existsSync(join(artifactDir, 'attempts.json')) ? (JSON.parse(readFileSync(join(artifactDir, 'attempts.json'), 'utf8')) as Record<string, any>[]) : [];
  const afterRefs = refs();
  const beforeLines = new Set(before.refs.split('\n'));
  const newRefs = afterRefs.split('\n').filter((l) => !beforeLines.has(l)).map((l) => l.split(' ')[0]);
  const report = {
    at: new Date().toISOString(),
    taskState: task.state,
    failureCategory: task.failureCategory,
    stateReason: task.stateReason,
    transport: http ? 'http' : 'in-process',
    runId: task.runId,
    studioUrl: typeof task.artifacts.studioUrl === 'string' ? task.artifacts.studioUrl : null,
    claims: task.claims,
    requeued: summary.requeued,
    stillActive: summary.stillActive,
    elapsedMs,
    cancellation: cancellation ?? null,
    backend: { ...backend.describe(), shutdown: backendShutdown },
    schedulerAllowProviders: schedulerAllow,
    schedulerEvents: store.events(TASK_ID).map((e) => ({ at: new Date(e.at).toISOString(), from: e.from, to: e.to, actor: e.actor, reason: e.reason, detail: e.detail })),
    schedulerLog,
    // evidence for a normal finish too: every Codex process group this run started must be gone
    processes: backend.ownedPids().map((pid) => ({ pid, groupGone: !groupAlive(pid) })),
    codingAttempts: attempts.length,
    runtimeRetries: attempts.reduce((n, a) => n + (a.runtimeRetries ?? 0), 0),
    telemetry: attempts.map((a) => a.telemetry ?? null),
    verifier: attempts.map((a) => a.verification && { command: a.verification.command, exitCode: a.verification.exitCode }),
    filesMutated: attempts.map((a) => a.filesMutated),
    forbiddenFiles: attempts.map((a) => a.forbiddenFiles),
    git: {
      sourceHeadUnchanged: sh(repo, 'rev-parse', 'HEAD') === before.head,
      sourceStatusClean: sh(repo, 'status', '--porcelain') === '',
      // refs that existed before must be exactly as they were; the only new refs are the ones the runtime itself creates
      existingRefsUnchanged: [...beforeLines].every((l) => afterRefs.split('\n').includes(l)),
      newRefs,
      unexpectedNewRefs: newRefs.filter((r) => r !== `refs/heads/${task.branch}` && !r.startsWith('refs/heads/lead-integration/') && !r.startsWith('refs/lead/base/')),
      fsckOk: (() => {
        try {
          sh(repo, 'fsck', '--no-dangling');
          return true;
        } catch {
          return false;
        }
      })(),
      worktreeStatus: worktree ? sh(worktree, 'status', '--porcelain') : null,
    },
    commentsKept: worktree ? ['Package smoke holds', 'Double returns n multiplied by two'].map((c) => readFileSync(join(worktree, 'smoke/double.go'), 'utf8').includes(c)) : null,
    diffOfTaskCommit: task.headCommit ? sh(repo, 'show', '--format=', task.headCommit) : null,
    paths: { outDir, repo, worktree, artifactDir },
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  if (cancellation && cancellation.confirmed !== true) {
    throw new SmokeCancellationUnconfirmed(`cancellation NOT confirmed (${JSON.stringify({ stillAlive: cancellation.stillAlive, runStillInFlight: cancellation.runStillInFlight })}); evidence kept in ${join(outDir, 'report.json')}. Do not rerun until these processes are accounted for.`, report);
  }
  return { report, store, outDir, repo };
}

/** The workflow runs in this process (no HTTP hop); provider processes are reported by the adapter itself. */
function inProcessBackend(options: SmokeOptions, outDir: string, modelTimeoutMs: number): SmokeBackend {
  // Every provider process this run starts, by pid (= process group id). Nothing else is ever signalled or reported on.
  const owned = new Map<number, { exited: boolean }>();
  const providerId = options.provider ?? 'codex';
  const base = providerId === 'gemini' ? options.gemini : options.codex;
  const onProcess = ({ pid, exited }: { pid: number; exited: Promise<void> }) => {
    owned.set(pid, { exited: false });
    void exited.then(() => {
      const e = owned.get(pid);
      if (e) e.exited = true;
    });
    base?.onProcess?.({ pid, exited });
  };
  const providers = new ProviderRegistry().register(providerId === 'gemini' ? geminiEntry({ ...options.gemini, onProcess }) : codexEntry({ ...options.codex, onProcess }));
  const workflow = createCodingTaskWorkflow({ providers, allowProviders: () => options.schedulerAllowProviders ?? [`${providerId}:${TASK_ID}`], artifactRoot: join(outDir, 'artifacts'), runOptions: { modelTimeoutMs, runtimeRetryDelayMs: 0 } });
  const executor: Executor = createInProcessExecutor(workflow);
  return {
    executor,
    ownedPids: () => [...owned.keys()],
    stillAlive: () => [...owned].filter(([pid, e]) => !e.exited && groupAlive(pid)).map(([pid]) => pid),
    killOwned() {
      const live = [...owned].filter(([pid, e]) => !e.exited && groupAlive(pid)).map(([pid]) => pid);
      for (const pid of live) {
        try {
          process.kill(-pid, 'SIGKILL'); // our own group, best effort; not confirmed here
        } catch {
          /* already gone */
        }
      }
      return { sentSigkillTo: live };
    },
    shutdown: async () => ({ started: false }),
    describe: () => ({ transport: 'in-process' }),
  };
}

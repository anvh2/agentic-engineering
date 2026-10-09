import { execFileSync } from 'node:child_process';
import { codexEntry } from '../../src/workers/providers/codex.ts';
import { HTTP_SMOKE_LIMITS, HTTP_SMOKE_OPT_IN_ENV, HTTP_SMOKE_OPT_IN_VALUE, HTTP_SMOKE_TASK_ID, checkHttpSmokeAuthorization } from './http-smoke-guards.ts';
import { SmokeCancellationUnconfirmed, runSchedulerSmoke } from './scheduler-smoke.ts';

/**
 * ONE real Codex task through the production execution path:
 *
 *   Lead Scheduler -> Mastra HTTP client -> a dedicated Mastra server (started and stopped by this command) -> coding-task-workflow
 *   -> Codex CLI adapter -> isolated git worktree of a disposable Go repo -> the runtime verifier -> REVIEW_PENDING
 *
 * It spends the operator's Codex quota, so it does nothing unless explicitly enabled (see http-smoke-guards.ts):
 *
 *   AGENTIC_REAL_PROVIDER_SMOKE=codex-http AGENTIC_ALLOW_PROVIDERS=codex:smoke-double npm run smoke:codex-http
 *
 * It takes no arguments, never talks to any Mastra server it did not start, and stops at REVIEW_PENDING (nothing is integrated).
 */

const fail = (code: number, message: string): never => {
  console.error(message);
  process.exit(code);
};

const auth = checkHttpSmokeAuthorization(process.env, process.argv.slice(2));
if (!auth.ok) fail(2, `refused: ${auth.reason}`);
const allowProviders = (auth as { allowProviders: string[] }).allowProviders;

// Free, local, no model call: is Codex installed, does it advertise the containment flags, is it signed in; is Go there for the verifier?
const model = process.env.AGENTIC_CODEX_MODEL || undefined;
const passEnv = (process.env.AGENTIC_CODEX_PASS_ENV ?? (process.env.CODEX_HOME ? 'CODEX_HOME' : '')).split(',').filter(Boolean);
const availability = await codexEntry({ model, passEnv }).probe();
if (availability.state !== 'available') fail(3, `refused: Codex is ${availability.state}: ${availability.detail}`);
try {
  execFileSync('go', ['version'], { stdio: 'ignore' });
} catch {
  fail(3, 'refused: `go` is not on PATH; the runtime verifier needs it');
}

console.log(
  [
    `Real Codex HTTP smoke (${HTTP_SMOKE_OPT_IN_ENV}=${HTTP_SMOKE_OPT_IN_VALUE}); Codex ${availability.version ?? 'unknown version'}; model ${model ?? 'CLI default (reported UNKNOWN)'}`,
    `  objective: 1 disposable Go task (${HTTP_SMOKE_TASK_ID}); allow-list given to the scheduler AND the Mastra server: ${allowProviders.join(', ')}`,
    `  bounds: <= ${HTTP_SMOKE_LIMITS.maxProviderInvocations} Codex invocation (enforced in the server), ${HTTP_SMOKE_LIMITS.automaticRuntimeRetries} automatic retries, no provider fallback, ${HTTP_SMOKE_LIMITS.maxClaims} claim,`,
    `          ${HTTP_SMOKE_LIMITS.perCallTimeoutMs / 1000}s per call, ${HTTP_SMOKE_LIMITS.taskActiveTimeoutMs / 1000}s active execution, ${HTTP_SMOKE_LIMITS.cancelConfirmationMs / 1000}s to confirm a cancel`,
    '  sandbox: --sandbox workspace-write --ignore-user-config, no bypass flags (enforced by the adapter); Ctrl-C once = cancel and confirm, twice = exit and report',
  ].join('\n'),
);

let exitCode = 1;
try {
  const { report } = await runSchedulerSmoke({
    transport: 'http',
    codex: { model, passEnv },
    schedulerAllowProviders: allowProviders,
    http: { serverAllowProviders: allowProviders, maxInvocations: HTTP_SMOKE_LIMITS.maxProviderInvocations },
    modelTimeoutMs: HTTP_SMOKE_LIMITS.perCallTimeoutMs,
    taskTimeoutMs: HTTP_SMOKE_LIMITS.taskActiveTimeoutMs,
    cancelDeadlineMs: HTTP_SMOKE_LIMITS.cancelConfirmationMs,
    log: (l) => console.error(l),
  });
  const backend = report.backend as Record<string, any>;
  const clean =
    report.taskState === 'REVIEW_PENDING' &&
    report.git.sourceHeadUnchanged &&
    report.git.existingRefsUnchanged &&
    report.git.unexpectedNewRefs.length === 0 &&
    report.git.fsckOk &&
    report.processes.every((p) => p.groupGone) &&
    backend.shutdown?.exited === true &&
    backend.providerInvocations <= HTTP_SMOKE_LIMITS.maxProviderInvocations;
  console.log(
    JSON.stringify(
      {
        taskState: report.taskState,
        stateReason: report.stateReason,
        runId: report.runId,
        studioUrl: report.studioUrl,
        providerInvocations: backend.providerInvocations,
        elapsedMs: report.elapsedMs,
        telemetry: report.telemetry,
        verifier: report.verifier,
        git: report.git,
        processes: report.processes,
        serverStopped: backend.shutdown,
        report: `${report.paths.outDir}/report.json`,
      },
      null,
      2,
    ),
  );
  console.log(clean ? 'RESULT: task at REVIEW_PENDING, verifier passed, git integrity intact, no owned process left. Nothing was integrated.' : 'RESULT: NOT clean; read the report before doing anything else.');
  exitCode = clean ? 0 : 1;
} catch (err) {
  if (err instanceof SmokeCancellationUnconfirmed) console.error(err.message);
  else console.error(`smoke failed: ${(err as Error).stack ?? err}`);
}
process.exit(exitCode);

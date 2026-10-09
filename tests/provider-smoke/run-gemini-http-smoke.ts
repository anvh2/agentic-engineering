import { execFileSync } from 'node:child_process';
import { GEMINI_PASSABLE_ENV, geminiEntry } from '../../src/workers/providers/gemini.ts';
import { GEMINI_HTTP_SMOKE_OPT_IN_VALUE, HTTP_SMOKE_LIMITS, HTTP_SMOKE_OPT_IN_ENV, HTTP_SMOKE_TASK_ID, checkHttpSmokeAuthorization } from './http-smoke-guards.ts';
import { SmokeCancellationUnconfirmed, runSchedulerSmoke } from './scheduler-smoke.ts';

/**
 * ONE real Gemini task through the production execution path:
 *
 *   Lead Scheduler -> Mastra HTTP client -> a dedicated Mastra server (started and stopped by this command) -> coding-task-workflow
 *   -> Gemini CLI adapter -> isolated git worktree of a disposable Go repo -> the runtime verifier -> REVIEW_PENDING
 *
 * It spends the operator's Gemini quota or API budget, so it does nothing unless explicitly enabled (see http-smoke-guards.ts):
 *
 *   AGENTIC_REAL_PROVIDER_SMOKE=gemini-http AGENTIC_ALLOW_PROVIDERS=gemini:smoke-double \
 *   AGENTIC_GEMINI_PASS_ENV=GEMINI_API_KEY GEMINI_API_KEY=... npm run smoke:gemini-http
 *
 * It takes no arguments, never talks to any Mastra server it did not start, and stops at REVIEW_PENDING (nothing is integrated).
 * Same fixture, same bounds, same acceptance checks and same cleanup accounting as the Codex smoke (scheduler-smoke.ts).
 */

const fail = (code: number, message: string): never => {
  console.error(message);
  process.exit(code);
};

const auth = checkHttpSmokeAuthorization(process.env, process.argv.slice(2), 'gemini');
if (!auth.ok) fail(2, `refused: ${auth.reason}`);
const allowProviders = (auth as { allowProviders: string[] }).allowProviders;

const model = process.env.AGENTIC_GEMINI_MODEL || undefined;
const passEnv = (process.env.AGENTIC_GEMINI_PASS_ENV ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const notPassable = passEnv.filter((n) => !(GEMINI_PASSABLE_ENV as readonly string[]).includes(n));
if (notPassable.length > 0) fail(2, `refused: AGENTIC_GEMINI_PASS_ENV names ${notPassable.join(', ')}, which the adapter will not forward (allowed: ${GEMINI_PASSABLE_ENV.join(', ')})`);

// Authentication. The adapter runs the CLI with a private GEMINI_CLI_HOME (so the operator's own settings, hooks and extensions are never
// loaded), which also means there is no cached Google sign-in to find: an API key in the environment is the only way in. Only whether
// the variable is SET is checked here (its value is never printed or logged).
const apiKeyNames = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
if (!passEnv.some((n) => apiKeyNames.includes(n) && process.env[n])) {
  fail(2, 'refused: no API key is being passed to the CLI. Export GEMINI_API_KEY (or GOOGLE_API_KEY) and set AGENTIC_GEMINI_PASS_ENV=GEMINI_API_KEY (or GOOGLE_API_KEY). The CLI runs with a private home, so cached Google sign-in is not available to it.');
}

// Free, local, no model call: is Gemini installed, does it advertise every control the adapter needs, does Seatbelt run; is Go there for the verifier?
const availability = await geminiEntry({ model, passEnv }).probe();
if (availability.state !== 'available') fail(3, `refused: Gemini is ${availability.state}: ${availability.detail}`);
try {
  execFileSync('go', ['version'], { stdio: 'ignore' });
} catch {
  fail(3, 'refused: `go` is not on PATH; the runtime verifier needs it');
}

console.log(
  [
    `Real Gemini HTTP smoke (${HTTP_SMOKE_OPT_IN_ENV}=${GEMINI_HTTP_SMOKE_OPT_IN_VALUE}); Gemini CLI ${availability.version ?? 'unknown version'}; model ${model ?? 'CLI default (the model it reports is recorded)'}`,
    `  objective: 1 disposable Go task (${HTTP_SMOKE_TASK_ID}); allow-list given to the scheduler AND the Mastra server: ${allowProviders.join(', ')}`,
    `  credentials forwarded to the CLI (names only): ${passEnv.join(', ')}`,
    `  bounds: <= ${HTTP_SMOKE_LIMITS.maxProviderInvocations} Gemini invocation (enforced in the server), ${HTTP_SMOKE_LIMITS.automaticRuntimeRetries} automatic retries, no provider fallback, ${HTTP_SMOKE_LIMITS.maxClaims} claim,`,
    `          ${HTTP_SMOKE_LIMITS.perCallTimeoutMs / 1000}s per call, ${HTTP_SMOKE_LIMITS.taskActiveTimeoutMs / 1000}s active execution, ${HTTP_SMOKE_LIMITS.cancelConfirmationMs / 1000}s to confirm a cancel`,
    '  sandbox: --sandbox (macOS Seatbelt permissive-open) --approval-mode auto_edit, private home + admin policy generated per run, no bypass flags (enforced by the adapter); Ctrl-C once = cancel and confirm, twice = exit and report',
  ].join('\n'),
);

let exitCode = 1;
try {
  const { report } = await runSchedulerSmoke({
    provider: 'gemini',
    transport: 'http',
    gemini: { model, passEnv },
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

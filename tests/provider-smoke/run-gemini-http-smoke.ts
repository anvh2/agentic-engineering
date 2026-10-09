import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEMINI_PASSABLE_ENV, geminiEntry } from '../../src/workers/providers/gemini.ts';
import { GEMINI_HTTP_SMOKE_OPT_IN_VALUE, GEMINI_SMOKE_BUDGET, GEMINI_SMOKE_MAX_FORWARDED_REQUESTS, HTTP_SMOKE_LIMITS, HTTP_SMOKE_OPT_IN_ENV, HTTP_SMOKE_TASK_ID, checkGeminiSmokeModel, checkHttpSmokeAuthorization } from './http-smoke-guards.ts';
import { guardVerdict, startModelGuard } from './gemini-model-guard.ts';
import { SmokeCancellationUnconfirmed, runSchedulerSmoke } from './scheduler-smoke.ts';

const GEMINI_API = 'https://generativelanguage.googleapis.com';

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

const pin = checkGeminiSmokeModel(process.env.AGENTIC_GEMINI_MODEL || undefined);
if (!pin.ok) fail(2, `refused: ${pin.reason}`);
const model = (pin as { model: string }).model;
const passEnv = (process.env.AGENTIC_GEMINI_PASS_ENV ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const notPassable = passEnv.filter((n) => !(GEMINI_PASSABLE_ENV as readonly string[]).includes(n));
if (notPassable.length > 0) fail(2, `refused: AGENTIC_GEMINI_PASS_ENV names ${notPassable.join(', ')}, which the adapter will not forward (allowed: ${GEMINI_PASSABLE_ENV.join(', ')})`);
// Free tier means an AI Studio API key. Vertex variables, project/location or credential files would select a billed Google Cloud path.
if (passEnv.length !== 1 || !['GEMINI_API_KEY', 'GOOGLE_API_KEY'].includes(passEnv[0])) fail(2, 'refused: the free-tier smoke forwards exactly one variable, GEMINI_API_KEY (or GOOGLE_API_KEY); Vertex AI, project, location and credential-file variables are not accepted.');

// Authentication. The adapter runs the CLI with a private GEMINI_CLI_HOME (so the operator's own settings, hooks and extensions are never
// loaded), which also means there is no cached Google sign-in to find: an API key in the environment is the only way in. Only whether
// the variable is SET is checked here (its value is never printed or logged).
const apiKeyNames = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
if (!passEnv.some((n) => apiKeyNames.includes(n) && process.env[n])) {
  fail(2, 'refused: no API key is being passed to the CLI. Export GEMINI_API_KEY (or GOOGLE_API_KEY) and set AGENTIC_GEMINI_PASS_ENV=GEMINI_API_KEY (or GOOGLE_API_KEY). The CLI runs with a private home, so cached Google sign-in is not available to it.');
}

// Free, local, no model call: is Gemini installed, does it advertise every control the adapter needs, does Seatbelt run; is Go there for the verifier?
const availability = await geminiEntry({ model, passEnv, ...GEMINI_SMOKE_BUDGET }).probe();
if (availability.state !== 'available') fail(3, `refused: Gemini is ${availability.state}: ${availability.detail}`);
try {
  execFileSync('go', ['version'], { stdio: 'ignore' });
} catch {
  fail(3, 'refused: `go` is not on PATH; the runtime verifier needs it');
}

console.log(
  [
    `Real Gemini HTTP smoke (${HTTP_SMOKE_OPT_IN_ENV}=${GEMINI_HTTP_SMOKE_OPT_IN_VALUE}); Gemini CLI ${availability.version ?? 'unknown version'}; model ${model} (exact id, free tier only; a request guard on 127.0.0.1 forwards ONLY this model to ${GEMINI_API}, max ${GEMINI_SMOKE_MAX_FORWARDED_REQUESTS} requests, and stops the run on the first 4xx)`,
    `  objective: 1 disposable Go task (${HTTP_SMOKE_TASK_ID}); allow-list given to the scheduler AND the Mastra server: ${allowProviders.join(', ')}`,
    `  credentials forwarded to the CLI (names only): ${passEnv.join(', ')}`,
    `  budget ceilings: <= ${GEMINI_SMOKE_BUDGET.maxTurns} model turns (CLI exits 53 beyond), <= ${GEMINI_SMOKE_BUDGET.maxOutputTokens} generated tokens per request; the CLI's own API-level retries are NOT counted (bounded only by the per-call deadline)`,
    `  bounds: <= ${HTTP_SMOKE_LIMITS.maxProviderInvocations} Gemini invocation (enforced in the server), ${HTTP_SMOKE_LIMITS.automaticRuntimeRetries} automatic retries, no provider fallback, ${HTTP_SMOKE_LIMITS.maxClaims} claim,`,
    `          ${HTTP_SMOKE_LIMITS.perCallTimeoutMs / 1000}s per call, ${HTTP_SMOKE_LIMITS.taskActiveTimeoutMs / 1000}s active execution, ${HTTP_SMOKE_LIMITS.cancelConfirmationMs / 1000}s to confirm a cancel`,
    '  sandbox: --sandbox (macOS Seatbelt permissive-open) --approval-mode auto_edit, private home + admin policy generated per run, no bypass flags (enforced by the adapter); Ctrl-C once = cancel and confirm, twice = exit and report',
  ].join('\n'),
);

// The request guard: the CLI talks to it, never to Google directly. It is the enforcement of the model pin (the CLI cannot guarantee it).
const guard = await startModelGuard({ pinnedModel: model, upstream: GEMINI_API, maxForwarded: GEMINI_SMOKE_MAX_FORWARDED_REQUESTS });
let exitCode = 1;
let outDir: string | undefined;
try {
  const { report } = await runSchedulerSmoke({
    provider: 'gemini',
    transport: 'http',
    gemini: { model, passEnv, apiBaseUrl: guard.url, ...GEMINI_SMOKE_BUDGET },
    schedulerAllowProviders: allowProviders,
    http: { serverAllowProviders: allowProviders, maxInvocations: HTTP_SMOKE_LIMITS.maxProviderInvocations },
    modelTimeoutMs: HTTP_SMOKE_LIMITS.perCallTimeoutMs,
    taskTimeoutMs: HTTP_SMOKE_LIMITS.taskActiveTimeoutMs,
    cancelDeadlineMs: HTTP_SMOKE_LIMITS.cancelConfirmationMs,
    log: (l) => console.error(l),
  });
  outDir = report.paths.outDir;
  const backend = report.backend as Record<string, any>;
  const gv = guardVerdict(guard.report());
  const clean =
    gv.ok &&
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
        modelGuard: { ok: gv.ok, reasons: gv.reasons, modelsRequested: guard.report().modelsRequested, forwarded: guard.report().forwarded, blocked: guard.report().blocked, tripped: guard.report().tripped ?? null },
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
// Evidence of exactly what the CLI asked the API for (models, decisions, statuses only: no headers, no bodies, no key).
const final = guard.report();
if (outDir) writeFileSync(join(outDir, 'model-guard-report.json'), JSON.stringify({ ...final, verdict: guardVerdict(final) }, null, 2));
await guard.stop();
if (final.tripped) console.error(`STOP: the API refused a request (HTTP ${final.tripped.status}: model not available to this project, quota, or key/permission). Do not rerun, do not switch model or project, and do not add billing. See model-guard-report.json.`);
process.exit(exitCode);

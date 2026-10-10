import { M85_LIMITS, M85_OPT_IN_ENV, M85_OPT_IN_VALUE, OBJECTIVE_ID, TASK_A, TASK_B, checkM85Authorization, judge, preflightProblems, runM85Objective } from './m85-objective.ts';

/**
 * ONE real M8.5 objective (two dependent Go tasks, Codex only, through a dedicated Mastra HTTP server). It spends the operator's
 * Codex quota, so it does nothing unless explicitly enabled:
 *
 *   AGENTIC_REAL_PROVIDER_SMOKE=codex-objective AGENTIC_ALLOW_PROVIDERS=codex:m85-normalize,codex:m85-wordfreq \
 *     node --disable-warning=ExperimentalWarning tests/provider-smoke/run-m85-objective.ts
 *
 * It takes no arguments and never talks to a Mastra server it did not start. Run it once; it does not repeat after a failure.
 */

const fail = (code: number, message: string): never => {
  console.error(message);
  process.exit(code);
};

const auth = checkM85Authorization(process.env, process.argv.slice(2));
if (!auth.ok) fail(2, `refused: ${auth.reason}`);
const allowProviders = (auth as { allowProviders: string[] }).allowProviders;

const model = process.env.AGENTIC_CODEX_MODEL || undefined;
const passEnv = (process.env.AGENTIC_CODEX_PASS_ENV ?? (process.env.CODEX_HOME ? 'CODEX_HOME' : '')).split(',').filter(Boolean);
const codex = { model, passEnv };

const problems = await preflightProblems({ codex });
if (problems.length > 0) fail(3, `M8_5_BLOCKED_BY_PREFLIGHT (no model was called):\n  - ${problems.join('\n  - ')}`);

console.log(
  [
    `Real M8.5 objective (${M85_OPT_IN_ENV}=${M85_OPT_IN_VALUE}); model ${model ?? 'CLI default (reported UNKNOWN)'}`,
    `  objective ${OBJECTIVE_ID}: ${TASK_A} -> ${TASK_B}; allow-list given to the scheduler AND the Mastra server: ${allowProviders.join(', ')}`,
    `  bounds: <= ${M85_LIMITS.maxInvocationsTotal} Codex invocations in total and <= ${M85_LIMITS.maxInvocationsPerTask} per task (enforced in the server), ${M85_LIMITS.maxClaimsPerTask} claim per task, 0 retries,`,
    `          ${M85_LIMITS.perInvocationTimeoutMs / 1000}s per invocation, ${M85_LIMITS.taskActiveTimeoutMs / 1000}s active per task, no repair authorization, no push`,
  ].join('\n'),
);

let exitCode = 1;
try {
  const { report, outDir } = await runM85Objective({ codex, allowProviders });
  const verdict = judge(report);
  console.log(JSON.stringify({ outDir, lifecycle: report.lifecycle.phase, reason: report.lifecycle.reason, elapsedMs: report.elapsedMs, checks: report.checks, verdict }, null, 2));
  console.log(`RESULT: ${verdict.verdict}\n  ${verdict.why.join('\n  ')}\nreport: ${outDir}/report.json`);
  exitCode = verdict.verdict === 'M8_5_REAL_OBJECTIVE_ACCEPTED' ? 0 : 1;
} catch (err) {
  console.error(`objective run failed: ${(err as Error).stack ?? err}`);
}
process.exit(exitCode);

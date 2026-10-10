import { findProjectRoot } from '../../src/core/paths.ts';
import { runM85Objective } from './m85-objective.ts';
import { ECONOMICS, M8F_LIMITS, M8F_OBJECTIVE_ID, M8F_OPT_IN_ENV, M8F_OPT_IN_VALUE, M8F_TASK_A, M8F_TASK_B, checkM8FAuthorization, judge, m8fPreflightProblems } from './m8final-objective.ts';

/**
 * The ONE real M8-final objective (affiliate-video-economics: two dependent Go tasks, Codex only, through a dedicated Mastra HTTP server).
 * It spends the operator's Codex quota, so it does nothing unless explicitly enabled, and it requires the approved model to be named:
 *
 *   AGENTIC_REAL_PROVIDER_SMOKE=codex-m8-final AGENTIC_CODEX_MODEL=<approved model> \
 *   AGENTIC_ALLOW_PROVIDERS=codex:m8f-accounting,codex:m8f-budget \
 *     node --disable-warning=ExperimentalWarning tests/provider-smoke/run-m8-final-objective.ts
 *
 * It takes no arguments and never talks to a Mastra server it did not start. Run it once; it does not repeat after a failure.
 */

const fail = (code: number, message: string): never => {
  console.error(message);
  process.exit(code);
};

const auth = checkM8FAuthorization(process.env, process.argv.slice(2));
if (!auth.ok) fail(2, `refused: ${auth.reason}`);
const { allowProviders, model } = auth as { allowProviders: string[]; model: string };

const passEnv = (process.env.AGENTIC_CODEX_PASS_ENV ?? (process.env.CODEX_HOME ? 'CODEX_HOME' : '')).split(',').filter(Boolean);
const codex = { model, passEnv };
const projectRoot = findProjectRoot() ?? process.cwd();

const problems = await m8fPreflightProblems({ codex, projectRoot });
if (problems.length > 0) fail(3, `M8_REAL_OBJECTIVE_BLOCKED_BY_PREFLIGHT (no model was called):\n  - ${problems.join('\n  - ')}`);

console.log(
  [
    `Real M8 final objective (${M8F_OPT_IN_ENV}=${M8F_OPT_IN_VALUE}); model ${model} (pinned)`,
    `  objective ${M8F_OBJECTIVE_ID}: ${M8F_TASK_A} -> ${M8F_TASK_B}; allow-list given to the scheduler AND the Mastra server: ${allowProviders.join(', ')}`,
    `  bounds: <= ${M8F_LIMITS.maxInvocationsTotal} Codex invocations in total and <= ${M8F_LIMITS.maxInvocationsPerTask} per task (enforced in the server), ${M8F_LIMITS.maxClaimsPerTask} claim per task, 0 retries,`,
    `          ${M8F_LIMITS.perInvocationTimeoutMs / 1000}s per invocation, ${M8F_LIMITS.taskActiveTimeoutMs / 1000}s active per task, no repair authorization, no push`,
  ].join('\n'),
);

let exitCode = 1;
try {
  const { report, outDir } = await runM85Objective({ objective: ECONOMICS, codex, allowProviders, requireIsolationCanary: true });
  const verdict = judge(report);
  console.log(JSON.stringify({ outDir, lifecycle: report.lifecycle.phase, reason: report.lifecycle.reason, elapsedMs: report.elapsedMs, checks: report.checks, verdict }, null, 2));
  console.log(`RESULT: ${verdict.verdict}\n  ${verdict.why.join('\n  ')}\nreport: ${outDir}/report.json`);
  exitCode = verdict.verdict === 'M8_REAL_OBJECTIVE_ACCEPTED' ? 0 : 1;
} catch (err) {
  console.error(`objective run failed: ${(err as Error).stack ?? err}`);
}
process.exit(exitCode);

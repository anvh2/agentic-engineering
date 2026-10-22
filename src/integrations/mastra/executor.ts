import { attachToCodingTaskRun, cancelCodingTaskRunConfirmed, runCodingTaskWorkflow, type WorkflowRunResult } from './client.ts';
import type { Executor, ExecutorModelCall, ExecutorOutcome } from '../../runtime/scheduler/scheduler.ts';

/**
 * The production Executor: every task runs through the registered Mastra `coding-task-workflow` on a running Mastra
 * server (so each run is a recorded, Studio-inspectable workflow run), with the task's isolated worktree as the
 * `repository`. There is NO coding, retry or verification logic here; it only starts / attaches to a run and maps its
 * result. The run id is reported the moment the run exists so a crash can be reconciled against it.
 */

export function toOutcome(run: WorkflowRunResult): ExecutorOutcome {
  const r = run.result;
  if (!r) throw new Error(run.error ?? `workflow run ${run.runId} produced no result`);
  return {
    runId: run.runId,
    studioUrl: run.studioUrl,
    status: r.status,
    reasons: r.reasons ?? [],
    codingAttempts: r.codingAttempts ?? 0,
    runtimeRetries: r.runtimeRetries ?? 0,
    failureCategory: r.failureCategory,
    artifactDir: r.artifactDir,
    verifier: r.verifier ? { command: r.verifier.command, exitCode: r.verifier.exitCode } : null,
    diff: r.diff,
    // Server JSON: shape is not trusted here; the scheduler's mergeModelCalls validates every field before persisting.
    modelCalls: Array.isArray(r.attempts)
      ? r.attempts.flatMap((a: { attempt?: unknown; telemetry?: Record<string, unknown> } | null) =>
          a?.telemetry && typeof a.telemetry === 'object' ? [{ ...a.telemetry, attempt: a.attempt } as ExecutorModelCall] : [],
        )
      : [],
  };
}

export function createMastraExecutor(options: { server?: string; pollMs?: number; taskTimeoutMs?: number; cancelGraceMs?: number } = {}): Executor {
  return {
    async run({ task, repository, signal, onRunStart, log }) {
      if (!task.spec.request) throw new Error(`task ${task.id} has no delegation request`);
      const run = await runCodingTaskWorkflow(task.spec.request, repository, {
        server: options.server,
        pollMs: options.pollMs,
        timeoutMs: options.taskTimeoutMs,
        signal,
        onStart: ({ runId, studioUrl }) => {
          onRunStart({ runId, studioUrl });
          log(`${task.id}: mastra run ${runId}  ${studioUrl}`);
        },
        onProgress: (line) => log(`${task.id}: ${line}`),
      });
      if (!run.result && run.status === undefined && !run.error?.startsWith('polling aborted')) onRunStart({ runId: run.runId, studioUrl: run.studioUrl });
      return toOutcome(run);
    },

    async reconcile({ runId, signal, log, task }) {
      const run = await attachToCodingTaskRun(runId, { server: options.server, pollMs: options.pollMs, timeoutMs: options.taskTimeoutMs, signal, onProgress: (l) => log(`${task.id}: ${l}`) }).catch(() => undefined);
      if (!run?.result) return undefined; // unknown / failed / never finished: the task will run fresh in a reset worktree
      return toOutcome(run);
    },

    async cancel({ runId, task, log }) {
      const result = await cancelCodingTaskRunConfirmed(runId, { server: options.server, graceMs: options.cancelGraceMs });
      log(`${task.id}: mastra run ${runId} cancel: ${result.run}${result.runStatus ? ` (${result.runStatus})` : ''}`);
      return result;
    },
  };
}

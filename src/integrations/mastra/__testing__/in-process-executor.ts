import { randomUUID } from 'node:crypto';
import type { createCodingTaskWorkflow } from '../workflows/coding-task-workflow.ts';
import type { Executor } from '../../../runtime/scheduler/scheduler.ts';
import { toOutcome } from '../executor.ts';

/**
 * An Executor that runs the REAL coding-task-workflow in this process instead of over HTTP to a Mastra server. It mirrors
 * what the production executor does and nothing more: start a run, report its id, stop WAITING (not the run) when the
 * scheduler's signal aborts, map the workflow result, and cancel the run on request. Used by the scheduler end-to-end tests
 * and the opt-in real smoke test; the HTTP hop itself is covered by client.test.ts / client-cancel.test.ts.
 */
export function createInProcessExecutor(workflow: ReturnType<typeof createCodingTaskWorkflow>, options: { cancelGraceMs?: number } = {}): Executor & { started: string[] } {
  const live = new Map<string, { cancel(): Promise<unknown>; settled: Promise<unknown> }>();
  const started: string[] = [];
  return {
    started,
    async run({ task, repository, signal, onRunStart }) {
      if (!task.spec.request) throw new Error(`task ${task.id} has no delegation request`);
      const runId = `inproc-${task.id}-${randomUUID().slice(0, 8)}`;
      const run = await workflow.createRun({ runId });
      started.push(runId);
      onRunStart({ runId });
      const pending = run.start({ inputData: { ...task.spec.request, repository } as never });
      live.set(runId, { cancel: () => run.cancel(), settled: pending.catch(() => undefined) });
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('polling aborted'));
        signal.addEventListener('abort', () => reject(new Error('polling aborted')), { once: true });
      });
      const r = (await Promise.race([pending, aborted])) as { status: string; result?: Record<string, any>; error?: unknown };
      if (r.status !== 'success' || !r.result) throw new Error(`workflow run ${runId} did not complete: status=${r.status} ${JSON.stringify(r.error ?? '').slice(0, 300)}`);
      // The production mapping, so these end-to-end tests exercise exactly what the HTTP executor hands the scheduler.
      return toOutcome({ runId, studioUrl: '', status: r.status, result: r.result });
    },
    async cancel({ runId }) {
      const entry = live.get(runId);
      if (!entry) return { run: 'terminal', runStatus: 'not_found', detail: 'unknown to this process' };
      await entry.cancel();
      const done = await Promise.race([entry.settled.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), options.cancelGraceMs ?? 10_000))]);
      return done ? { run: 'terminal', runStatus: 'canceled' } : { run: 'still_active', runStatus: 'running' };
    },
  };
}

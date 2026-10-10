import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { findProjectRoot } from '../../../core/paths.ts';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { codingWorkerGo, codingWorkerJs } from '../../../workers/coding-worker.ts';
import { createOllamaProvider } from '../../../workers/providers/ollama.ts';
import { defaultProviderRegistry } from '../../../workers/providers/default.ts';
import { UnknownProviderError, type ProviderRegistry } from '../../../workers/providers/registry.ts';
import { DEFAULT_PROVIDER_ID, allowedProvidersFromEnv, authorizeProvider } from '../../../runtime/execution/worker-provider.ts';
import { delegationRequestSchema, executeDelegation, languageOf, routeTask, workerAgentIdFor, type EngineeringResult } from '../../../runtime/execution/delegation.ts';
import type { RunCodingTaskOptions, WorkerLike } from '../../../runtime/execution/coding-task-runner.ts';
import { phaseOf, type CodingPhase, type PhaseUpdate } from '../../../runtime/execution/coding-task-status.ts';
import { runtimeMetrics } from '../../../observability/metrics.ts';
import { createTraceSink } from '../../../runtime/execution/coding-task-trace.ts';

/**
 * coding-task-workflow: the Engineering Lead's door to the local coding worker, and the orchestration /
 * visibility boundary visible in Mastra Studio.
 *
 *   prepare-coding-task        validate the CodingTask contract + deterministic routing gate (qwen | claude)
 *   run-coding-worker    the existing runtime-owned runner: worker -> mutation policy -> format -> verify,
 *                              fresh-context coding retry (max 3), separate runtime retry. PASS/FAIL is decided
 *                              there and nowhere else.
 *   finalize-result            map the runner's outcome to an explicit result for the Engineering Lead
 *
 * This file contains NO coding, retry or verification logic of its own: step 2 only calls executeDelegation().
 * Mastra step retries are deliberately not configured, so the runner stays the single retry authority.
 */

export const codingTaskInputSchema = delegationRequestSchema.extend({
  repository: z.string().describe('Absolute path of the git repository the worker may modify.'),
});
export type CodingTaskWorkflowInput = z.input<typeof codingTaskInputSchema>;

const phaseSchema = z.enum(['preparing', 'worker_running', 'verifying', 'retrying', 'passed', 'failed', 'escalated', 'runtime_failed', 'kept_by_claude']);

// Operational state shown for the run. Optional so a run started without initialState (Studio, API) is valid.
const stateSchema = z.object({
  phase: phaseSchema.optional(),
  attempt: z.number().optional(),
  detail: z.string().optional(),
  taskId: z.string().optional(),
});
type WorkflowState = z.infer<typeof stateSchema>;

const attemptSummarySchema = z.object({
  attempt: z.number(),
  category: z.string().optional(),
  filesMutated: z.array(z.string()),
  durationMs: z.number(),
  verificationExitCode: z.number().nullable().optional(),
  runtimeRetries: z.number(),
});

export const codingTaskResultSchema = z.object({
  taskId: z.string(),
  /** Provider that ran (or was refused) the task; 'ollama' unless the request named another. */
  provider: z.string().optional(),
  /** PASS | ESCALATED_TO_CLAUDE | RUNTIME_FAILURE | KEPT_BY_CLAUDE. Decided by the runtime verifier, never by the worker. */
  status: z.enum(['PASS', 'ESCALATED_TO_CLAUDE', 'RUNTIME_FAILURE', 'KEPT_BY_CLAUDE']),
  phase: phaseSchema,
  reasons: z.array(z.string()),
  codingAttempts: z.number(),
  runtimeRetries: z.number(),
  failureCategory: z.string().optional(),
  restored: z.boolean(),
  /** The verified change (PASS only). Left uncommitted in the repository for the Lead to review. */
  diff: z.string(),
  attempts: z.array(attemptSummarySchema),
  verifier: z.object({ command: z.array(z.string()), exitCode: z.number().nullable(), output: z.string() }).nullable(),
  escalation: z.unknown().optional(),
  artifactDir: z.string().optional(),
  nextAction: z.string(),
  report: z.string(),
});
export type CodingTaskWorkflowResult = z.infer<typeof codingTaskResultSchema>;

const prepareOutputSchema = z.object({
  taskId: z.string(),
  repository: z.string(),
  route: z.enum(['qwen', 'claude']),
  reasons: z.array(z.string()),
});

export interface CodingTaskWorkflowDeps {
  /** Defaults to the registered Qwen/Ollama coding worker for the task's language (Go or JS), traced under the step's span. */
  resolveWorker?: (ctx: { mastra?: { getAgent(id: string): unknown }; tracingContext?: unknown }) => WorkerLike;
  artifactRoot?: string;
  /** Providers a request may name (default: the shipped registry). */
  providers?: ProviderRegistry;
  /** The operator's allow-list, read at run time (default: AGENTIC_ALLOW_PROVIDERS of THIS process, i.e. the Mastra server's). */
  allowProviders?: () => readonly string[];
  runOptions?: Pick<RunCodingTaskOptions, 'modelTimeoutMs' | 'runtimeRetryDelayMs'>;
}

const NEXT_ACTION: Record<EngineeringResult['status'], string> = {
  PASS: 'Review the verified diff (uncommitted in the repository), then commit it or send it back.',
  ESCALATED_TO_CLAUDE: 'Claude takes over this task. The worker\'s changes were reverted; its last diff and the verifier output are in the escalation record.',
  RUNTIME_FAILURE: 'The local model runtime was unavailable; this is not a coding failure. Check Ollama and re-dispatch, or take the task directly.',
  KEPT_BY_CLAUDE: 'The task was not eligible for the local worker. Claude keeps it.',
};

const PHASE_BY_STATUS: Record<EngineeringResult['status'], CodingPhase> = {
  PASS: 'passed',
  ESCALATED_TO_CLAUDE: 'escalated',
  RUNTIME_FAILURE: 'runtime_failed',
  KEPT_BY_CLAUDE: 'kept_by_claude',
};

function summarize(result: EngineeringResult): Omit<CodingTaskWorkflowResult, 'phase' | 'nextAction' | 'report'> {
  const run = result.run;
  return {
    taskId: result.taskId,
    status: result.status,
    reasons: result.reasons,
    codingAttempts: run?.attempts ?? 0,
    runtimeRetries: run?.runtimeRetries ?? 0,
    failureCategory: run?.failureCategory,
    restored: result.restored,
    diff: result.diff,
    attempts: (run?.records ?? []).map((r) => ({
      attempt: r.attempt,
      category: r.category,
      filesMutated: r.filesMutated,
      durationMs: r.durationMs,
      verificationExitCode: r.verification?.exitCode ?? null,
      runtimeRetries: r.runtimeRetries,
    })),
    verifier: run?.verifier ? { command: run.verifier.command, exitCode: run.verifier.exitCode, output: run.verifier.output } : null,
    escalation: result.escalation,
    artifactDir: result.artifactDir,
  };
}

/**
 * The runtime step mutates a real repository, so it must run AT MOST ONCE per workflow run. Mastra re-executes the
 * active step of every still-"running" run on server boot (`mastra dev` does this after every hot reload): for this step
 * that means re-running the worker against a tree that its earlier execution left half-edited, after the client may
 * already have given up on the run and restored or reused that tree. Claims `runId` with an exclusive-create marker;
 * returns false if this run already executed the step (the caller then refuses instead of touching the repository).
 */
async function claimExecution(root: string, runId: string, info: Record<string, unknown>): Promise<boolean> {
  const dir = join(root, '.executions');
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, `${runId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`), JSON.stringify({ runId, ...info, pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** `mastra dev` runs with its cwd inside its own build output, so walk up to the project root. */
function defaultArtifactRoot(): string {
  if (process.env.AGENTIC_ARTIFACT_ROOT) return process.env.AGENTIC_ARTIFACT_ROOT;
  return join(findProjectRoot() ?? process.cwd(), '.workdir', 'lead-delegations');
}

export function createCodingTaskWorkflow(deps: CodingTaskWorkflowDeps = {}) {
  const publish = async (
    ctx: { setState: (s: WorkflowState) => Promise<void>; writer: { write: (d: unknown) => Promise<void> } },
    taskId: string,
    update: PhaseUpdate,
    current: WorkflowState,
  ) => {
    const next: WorkflowState = { phase: update.phase, attempt: update.attempt ?? current?.attempt ?? 0, detail: update.detail ?? '', taskId };
    try {
      await ctx.setState(next);
      await ctx.writer.write({ type: 'coding-phase', ...next, at: new Date().toISOString() });
    } catch {
      // Studio visibility must never break a coding run.
    }
    return next;
  };

  const prepare = createStep({
    id: 'prepare-coding-task',
    description: 'Validates the CodingTask contract and applies the deterministic routing gate. Only small, low-risk, unambiguous, well-scoped tasks are cleared for the local worker; everything else stays with Claude.',
    inputSchema: codingTaskInputSchema,
    outputSchema: prepareOutputSchema,
    stateSchema,
    execute: async ({ inputData, state, setState, writer }) => {
      const taskId = inputData.contract?.taskId ?? 'unknown';
      await publish({ setState, writer }, taskId, { phase: 'preparing', detail: 'validating contract and routing' }, state);
      const route = await routeTask(inputData, inputData.repository);
      return {
        taskId,
        repository: inputData.repository,
        route: route.route,
        reasons: route.route === 'claude' ? route.reasons : [],
      };
    },
  });

  const runWorker = createStep({
    id: 'run-coding-worker',
    description: 'Runs the existing runtime-owned runner: Qwen edits only the allowed files, the runtime checks the file hashes, formats, and runs the verification commands. PASS/FAIL comes only from the verifier. Fresh-context coding retries (max 3) and the separate runtime retry live inside the runner.',
    inputSchema: prepareOutputSchema,
    outputSchema: codingTaskResultSchema.omit({ phase: true, nextAction: true, report: true }),
    stateSchema,
    execute: async ({ inputData, state, setState, writer, getInitData, mastra, tracingContext, runId, abortSignal }) => {
      if (inputData.route === 'claude') {
        return summarize({ taskId: inputData.taskId, status: 'KEPT_BY_CLAUDE', reasons: inputData.reasons, diff: '', restored: false });
      }

      // Provider selection: the request only names one; a non-default provider also needs the operator's allow-list HERE, in
      // the process that would spawn it, whoever started the run. Nothing below runs (no marker, no worker, no spawn) otherwise.
      const requestedProvider = getInitData<CodingTaskWorkflowInput>().provider ?? DEFAULT_PROVIDER_ID;
      const refuse = (reason: string) => ({ ...summarize({ taskId: inputData.taskId, status: 'RUNTIME_FAILURE', reasons: [reason], diff: '', restored: false }), provider: requestedProvider });
      let providerWorker: WorkerLike | undefined;
      if (requestedProvider !== DEFAULT_PROVIDER_ID) {
        const auth = authorizeProvider(requestedProvider, inputData.taskId, (deps.allowProviders ?? (() => allowedProvidersFromEnv()))());
        if (!auth.ok) return refuse(auth.reason);
        try {
          const entry = (deps.providers ?? defaultProviderRegistry()).get(requestedProvider);
          const availability = await entry.probe();
          if (availability.state !== 'available') return refuse(`provider_unavailable: ${requestedProvider} is ${availability.state}: ${availability.detail}`);
          providerWorker = entry.create({ taskType: languageOf(getInitData<CodingTaskWorkflowInput>().contract.allowedFiles) ?? 'go', mastra, tracingContext });
        } catch (err) {
          if (err instanceof UnknownProviderError) return refuse(`unknown_provider: ${err.message}`);
          throw err;
        }
      }

      const artifactRoot = deps.artifactRoot ?? defaultArtifactRoot();
      if (!(await claimExecution(artifactRoot, runId, { taskId: inputData.taskId, repository: inputData.repository }))) {
        // A restarted run: the first execution may have been half-way through editing, and its client may have given up
        // and restored or reused the tree since. Never re-run blind; the caller decides (re-dispatch = a new run).
        return summarize({
          taskId: inputData.taskId,
          status: 'RUNTIME_FAILURE',
          reasons: [`run_restarted: the worker step of run ${runId} already executed once (the server restarted mid-run); refusing to re-run it against a repository in an unknown state. Re-dispatch the task as a new run.`],
          diff: '',
          restored: false,
        });
      }

      const request = getInitData<CodingTaskWorkflowInput>();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const artifactDir = join(artifactRoot, `${inputData.taskId}-${stamp}`);
      // Worker follows the language of the allowed files (the gate already guaranteed they are all one language).
      const agentId = workerAgentIdFor(languageOf(request.contract.allowedFiles));
      const fallbackAgent = agentId === 'codingWorkerJs' ? codingWorkerJs : codingWorkerGo;
      const worker = providerWorker ?? (deps.resolveWorker
        ? deps.resolveWorker({ mastra, tracingContext })
        : createOllamaProvider(
            (mastra?.getAgent(agentId) as typeof fallbackAgent | undefined) ?? fallbackAgent,
            tracingContext ? { tracingContext } : {},
          ));

      // Runner events -> Studio phase updates, in order. Observability only; never decides anything.
      let current = state;
      let chain: Promise<unknown> = Promise.resolve();
      const trace = createTraceSink({
        jsonlPath: join(artifactDir, 'trace.jsonl'),
        onEvent: (event) => {
          const update = phaseOf(event);
          if (update) chain = chain.then(async () => (current = await publish({ setState, writer }, inputData.taskId, update, current)));
        },
      });

      const result = await executeDelegation(request, {
        repoRoot: inputData.repository,
        worker,
        artifactDir,
        trace,
        modelLabel: providerWorker ? undefined : (process.env.OLLAMA_MODEL ?? 'qwen3:8b'), // a provider labels itself (provider:model)
        runOptions: { modelTimeoutMs: 900_000, ...deps.runOptions, signal: abortSignal, runId }, // the run's own id owns its model permits
      });
      await chain;
      return { ...summarize(result), provider: requestedProvider };
    },
  });

  const finalize = createStep({
    id: 'finalize-result',
    description: 'Maps the runner\'s outcome to an explicit result for the Engineering Lead: PASS, ESCALATED_TO_CLAUDE (coding attempts exhausted or mutation policy broken), RUNTIME_FAILURE, or KEPT_BY_CLAUDE.',
    inputSchema: codingTaskResultSchema.omit({ phase: true, nextAction: true, report: true }),
    outputSchema: codingTaskResultSchema,
    stateSchema,
    execute: async ({ inputData, state, setState, writer }) => {
      const phase = PHASE_BY_STATUS[inputData.status];
      await publish({ setState, writer }, inputData.taskId, { phase, detail: `${inputData.status} (${inputData.codingAttempts} coding attempt(s), ${inputData.runtimeRetries} runtime retr${inputData.runtimeRetries === 1 ? 'y' : 'ies'})` }, state);
      const lines = [
        `${inputData.taskId}: ${inputData.status}`,
        `coding attempts: ${inputData.codingAttempts} (max 3) | runtime retries: ${inputData.runtimeRetries}${inputData.failureCategory ? ` | failure class: ${inputData.failureCategory}` : ''}`,
        ...(inputData.reasons.length ? [`reasons: ${inputData.reasons.join('; ')}`] : []),
        ...(inputData.verifier ? [`verifier: ${inputData.verifier.command.join(' ')} -> exit ${inputData.verifier.exitCode}`] : []),
        NEXT_ACTION[inputData.status],
      ];
      return { ...inputData, phase, nextAction: NEXT_ACTION[inputData.status], report: lines.join('\n') };
    },
  });

  return createWorkflow({
    id: 'coding-task-workflow',
    description: 'Engineering Lead -> local Qwen coding worker. Validates and routes a scoped CodingTask, runs it through the runtime-owned runner (verification owns PASS/FAIL, max 3 coding attempts, fresh context per retry), and returns PASS or an explicit escalation.',
    inputSchema: codingTaskInputSchema,
    outputSchema: codingTaskResultSchema,
    stateSchema,
    options: {
      validateInputs: true,
      // Operational metrics only; the recorders never throw and Mastra swallows callback errors.
      onStart: ({ workflowId, runId }) => runtimeMetrics.workflowStarted(workflowId, runId),
      onFinish: ({ workflowId, runId, status }) => runtimeMetrics.workflowFinished(workflowId, runId, status),
    },
  })
    .then(prepare)
    .then(runWorker)
    .then(finalize)
    .commit();
}

export const codingTaskWorkflow = createCodingTaskWorkflow();

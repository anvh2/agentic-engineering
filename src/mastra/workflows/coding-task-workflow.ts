import { createStep, createWorkflow } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { codingWorkerGo, codingWorkerJs, type Ecosystem } from '../agents/coding-worker.ts';
import { REPOSITORY_ROOT_CONTEXT_KEY } from '../tools/repository-tools.ts';
import { detectEcosystem } from '../repository/detect-ecosystem.ts';
import { createRepairLoopTracker, resolveMaxRepairAttempts, type RepairLoopToolNames } from './repair-loop-tracker.ts';

const TOOL_NAMES_BY_ECOSYSTEM: Record<Ecosystem, RepairLoopToolNames> = {
  go: { format: 'runGoFmt', test: 'runGoTest' },
  js: { format: 'runPrettier', test: 'runJestTest' },
};

export const codingDelegationSchema = z.object({
  task: z.string(),
  requirements: z.array(z.string()).optional(),
  expectedOutput: z.string().optional(),
  repository: z.string().optional().describe('Absolute local filesystem path to the repository the worker may inspect.'),
});

export type CodingDelegation = z.infer<typeof codingDelegationSchema>;

function formatDelegationPrompt(delegation: CodingDelegation): string {
  const parts = [`Task: ${delegation.task}`];

  if (delegation.repository) {
    parts.push(`Repository: ${delegation.repository}`);
  }

  if (delegation.requirements && delegation.requirements.length > 0) {
    parts.push(`Requirements:\n${delegation.requirements.map((requirement) => `- ${requirement}`).join('\n')}`);
  }

  if (delegation.expectedOutput) {
    parts.push(`Expected output: ${delegation.expectedOutput}`);
  }

  return parts.join('\n\n');
}

const testOutcomeSchema = z.object({
  success: z.boolean(),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});

export const codingTaskOutputSchema = z.object({
  // The model's own final text. NOT authoritative for whether the task
  // succeeded - a model can (and, observed live, does) narrate success in
  // this field after its own patch was rejected by the tool layer. Use
  // `success` below to decide pass/fail; treat `result` as commentary only.
  result: z.string(),
  // Explicit, serializable state for the patch -> format -> test -> repair
  // cycle (Step 12), derived from the worker's own tool calls rather than
  // parsed out of its prose. Kept on the step output (not a module-level or
  // in-memory-only variable) so a future durable/checkpointed version of
  // this workflow has something concrete to persist between attempts.
  attempts: z.number(),
  status: z.enum(['pending', 'test_passed', 'test_failed', 'blocked']),
  lastTestResult: testOutcomeSchema.optional(),
  // Objective completion gate (Step 15.1): each flag is set only by a real
  // tool result (see repair-loop-tracker.ts), never by the model's prose.
  patchApplied: z.boolean(),
  gofmtCompleted: z.boolean(),
  goTestPassed: z.boolean(),
  // Authoritative pass/fail verdict: patchApplied && gofmtCompleted && goTestPassed.
  success: z.boolean(),
});

const runCodingWorkerStep = createStep({
  id: 'run-coding-worker',
  description:
    'Detects the repository\'s ecosystem (go.mod vs package.json) and sends the delegated task to the matching codingWorker (Go or JS), which inspects, patches, formats, and tests the repository itself, bounded to a configured number of repair attempts.',
  inputSchema: codingDelegationSchema,
  outputSchema: codingTaskOutputSchema,
  execute: async ({ inputData }) => {
    let requestContext: RequestContext | undefined;
    // Defaults to 'go' when there's no repository to detect from (the
    // text-only demo path) - preserves the original single-worker
    // behavior exactly for that case.
    let ecosystem: Ecosystem = 'go';
    if (inputData.repository) {
      requestContext = new RequestContext();
      requestContext.set(REPOSITORY_ROOT_CONTEXT_KEY, inputData.repository);
      ecosystem = (await detectEcosystem(inputData.repository)) ?? 'go';
    }

    const codingWorker = ecosystem === 'js' ? codingWorkerJs : codingWorkerGo;

    // A fresh tracker per run - no module-level mutable state, so concurrent
    // workflow runs (and, later, durable/resumed runs) never share state.
    const { state, onIterationComplete } = createRepairLoopTracker(
      resolveMaxRepairAttempts(),
      TOOL_NAMES_BY_ECOSYSTEM[ecosystem],
    );

    const response = await codingWorker.generate(formatDelegationPrompt(inputData), {
      requestContext,
      onIterationComplete,
    });

    const goTestPassed = state.status === 'test_passed';

    return {
      result: response.text,
      attempts: state.attempts,
      status: state.status,
      lastTestResult: state.lastTestResult,
      patchApplied: state.patchApplied,
      gofmtCompleted: state.gofmtCompleted,
      goTestPassed,
      success: state.patchApplied && state.gofmtCompleted && goTestPassed,
    };
  },
});

export const codingTaskWorkflow = createWorkflow({
  id: 'coding-task-workflow',
  inputSchema: codingDelegationSchema,
  outputSchema: codingTaskOutputSchema,
})
  .then(runCodingWorkerStep)
  .commit();

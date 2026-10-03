// Step 15 - Real Repository Coding Trial.
//
// Runs the existing pipeline (Claude supervisor -> CodingDelegation -> Mastra
// workflow -> codingWorker -> repository/execution tools -> repair loop)
// completely unmodified, against the real configured TARGET_REPOSITORY.
//
// The only addition here is observability: codingWorker.generate is wrapped
// (not replaced) for the duration of this run so every onIterationComplete
// call - the same hook the real repair-loop tracker already uses - is also
// mirrored into a telemetry log. The wrapper forwards to whatever
// onIterationComplete the workflow step itself supplies, so the real
// repair-loop behavior is unaffected; this script only observes.
import { planCodingTask } from '../src/mastra/supervisor/claude-supervisor.ts';
import { codingTaskWorkflow } from '../src/mastra/workflows/coding-task-workflow.ts';
import { codingWorker } from '../src/mastra/agents/coding-worker.ts';

const repository = process.env.TARGET_REPOSITORY;
if (!repository) {
  console.error('TARGET_REPOSITORY is not set.');
  process.exit(1);
}

const userRequest = `In this repository, add unit tests for the BuildURL function in pkg/utils/url.go (package "utils").

BuildURL(rawURL string, params map[string]string) string parses rawURL, merges the given params into rawURL's query string (overwriting any existing keys with the same name), and returns the resulting URL string; if rawURL fails to parse, it returns rawURL unchanged.

This package already has existing test files (pkg/utils/string_test.go, pkg/utils/time_test.go) - follow the same table-driven testing style and conventions used there.

Steps:
1. Read pkg/utils/url.go and an existing test file (e.g. pkg/utils/string_test.go) to see current conventions.
2. Create pkg/utils/url_test.go with table-driven tests for BuildURL covering at least: a URL with no existing query and one param, overwriting an existing query param, multiple params, no params at all, and an invalid/unparsable rawURL.
3. Format the new file.
4. Run the package's tests and fix any failures.`;

interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
interface ToolResultRecord {
  id: string;
  name: string;
  result: unknown;
  error?: string;
}
interface IterationRecord {
  iteration: number;
  finishReason: string;
  isFinal: boolean;
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  text: string;
}

const telemetry = {
  iterations: [] as IterationRecord[],
  toolCallCounts: {} as Record<string, number>,
  toolErrorCounts: {} as Record<string, number>,
  applyPatch: { attempts: 0, success: 0, failed: 0, failures: [] as unknown[] },
  goTest: { calls: 0, failures: [] as unknown[] },
  goFmt: { calls: 0 },
  finishReason: undefined as string | undefined,
};

const originalGenerate = codingWorker.generate.bind(codingWorker);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(codingWorker as any).generate = async (messages: unknown, options: Record<string, unknown> = {}) => {
  const userHook = options.onIterationComplete as
    | ((ctx: any) => unknown)
    | undefined;

  const wrappedHook = async (context: any) => {
    telemetry.iterations.push({
      iteration: context.iteration,
      finishReason: context.finishReason,
      isFinal: context.isFinal,
      toolCalls: context.toolCalls,
      toolResults: context.toolResults.map((r: any) => ({
        id: r.id,
        name: r.name,
        result: r.result,
        error: r.error ? String(r.error.message ?? r.error) : undefined,
      })),
      text: context.text,
    });

    for (const call of context.toolCalls as ToolCallRecord[]) {
      telemetry.toolCallCounts[call.name] = (telemetry.toolCallCounts[call.name] ?? 0) + 1;
    }

    for (const result of context.toolResults as { name: string; result: unknown; error?: Error }[]) {
      if (result.error) {
        telemetry.toolErrorCounts[result.name] = (telemetry.toolErrorCounts[result.name] ?? 0) + 1;
      }

      if (result.name === 'applyPatch') {
        telemetry.applyPatch.attempts += 1;
        const r = result.result as { success?: boolean } | undefined;
        if (result.error || !r || r.success !== true) {
          telemetry.applyPatch.failed += 1;
          telemetry.applyPatch.failures.push({ error: result.error?.message, result: r });
        } else {
          telemetry.applyPatch.success += 1;
        }
      }

      if (result.name === 'runGoTest') {
        telemetry.goTest.calls += 1;
        const r = result.result as { success?: boolean } | undefined;
        if (!result.error && r && r.success === false) telemetry.goTest.failures.push(r);
      }

      if (result.name === 'runGoFmt') {
        telemetry.goFmt.calls += 1;
      }
    }

    telemetry.finishReason = context.finishReason;
    return userHook ? await userHook(context) : undefined;
  };

  return originalGenerate(messages as any, { ...options, onIterationComplete: wrappedHook } as any);
};

console.log('=== STEP 15: REAL REPOSITORY CODING TRIAL ===\n');
console.log(`Target repository: ${repository}`);
console.log(`Ollama model: ${process.env.OLLAMA_MODEL ?? 'qwen3:8b'}`);
console.log(`Ollama base URL: ${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'}`);
console.log(`Max repair attempts: ${process.env.MAX_REPAIR_ATTEMPTS ?? '3 (default)'}`);
console.log('');

const supervisorStart = Date.now();
const delegation = await planCodingTask(userRequest, { repository });
const supervisorDurationMs = Date.now() - supervisorStart;

console.log('--- Supervisor delegation ---');
console.log(JSON.stringify(delegation, null, 2));
console.log(`Supervisor duration: ${supervisorDurationMs}ms\n`);

console.log('--- Running codingTaskWorkflow ---\n');
const workflowStart = Date.now();
const run = await codingTaskWorkflow.createRun();
const result = await run.start({ inputData: delegation });
const workflowDurationMs = Date.now() - workflowStart;

(codingWorker as any).generate = originalGenerate;

console.log(`Workflow duration: ${workflowDurationMs}ms`);
console.log(`Workflow status: ${result.status}\n`);

if (result.status === 'success') {
  console.log('--- Worker final text ---');
  console.log(result.result.result);
  console.log('');
  console.log('--- Repair loop state (from workflow output) ---');
  console.log(JSON.stringify({ attempts: result.result.attempts, status: result.result.status, lastTestResult: result.result.lastTestResult }, null, 2));
} else {
  console.log('--- Workflow did not succeed ---');
  console.log(JSON.stringify(result, null, 2));
}

console.log('\n--- Telemetry ---');
console.log(`Model turns (iterations): ${telemetry.iterations.length}`);
console.log(`Tool calls by type: ${JSON.stringify(telemetry.toolCallCounts, null, 2)}`);
console.log(`Tool errors by type: ${JSON.stringify(telemetry.toolErrorCounts, null, 2)}`);
console.log(`applyPatch: ${JSON.stringify(telemetry.applyPatch, null, 2)}`);
console.log(`runGoTest: ${JSON.stringify(telemetry.goTest, null, 2)}`);
console.log(`runGoFmt: ${JSON.stringify(telemetry.goFmt, null, 2)}`);
console.log(`Final finishReason: ${telemetry.finishReason}`);

console.log('\n--- Full iteration log (JSON) ---');
console.log(JSON.stringify(telemetry.iterations, null, 2));

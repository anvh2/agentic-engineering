// Shared driver for the autonomous real-coding pipeline (Step 16):
// validate TARGET_REPOSITORY -> Trellis context/task (optional, best-effort)
// -> Claude supervisor -> Mastra workflow -> codingWorker (Go or JS,
// auto-detected) -> repository/execution tools -> repair loop -> Claude
// review (read-only) -> full observability trace. Claude never writes code
// here - it only plans (supervisor) and reviews (reviewer), both via
// tool-less `claude -p` calls. The repository path always comes from the
// environment; nothing here lets either model choose or override it.
//
// Extracted from the original Step 16 script (scripts/step16-real-coding-task.ts,
// which ran against vus-metadata-v2/Go) so a second target repository
// (eshop/JS) doesn't need a second ~300-line copy of this orchestration.
import { spawn } from 'node:child_process';
import { validateTargetRepository } from '../../src/mastra/repository/validate-target-repository.ts';
import { planCodingTask } from '../../src/mastra/supervisor/claude-supervisor.ts';
import { reviewCodingResult } from '../../src/mastra/supervisor/claude-reviewer.ts';
import { codingTaskWorkflow } from '../../src/mastra/workflows/coding-task-workflow.ts';
import { codingWorkerGo, codingWorkerJs } from '../../src/mastra/agents/coding-worker.ts';
import {
  createAndStartTrellisTask,
  finishTrellisTask,
  hasTrellis,
  readTrellisSpecContext,
} from '../../src/mastra/trellis/trellis-integration.ts';

function runGit(args: string[], cwd: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    child.on('error', (err) => resolvePromise({ success: false, stdout, stderr: err.message }));
    child.on('close', (code) => resolvePromise({ success: code === 0, stdout, stderr }));
  });
}

interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
interface IterationRecord {
  iteration: number;
  finishReason: string;
  isFinal: boolean;
  toolCalls: ToolCallRecord[];
  toolResults: { id: string; name: string; result: unknown; error?: string }[];
}

export interface RunRealCodingTaskOptions {
  label: string;
  task: string;
  trellisTaskSlug: string;
  trellisTaskTitle: string;
}

export async function runRealCodingTask(options: RunRealCodingTaskOptions): Promise<void> {
  const { label, task, trellisTaskSlug, trellisTaskTitle } = options;

  console.log(`=== ${label}: AUTONOMOUS REAL CODING ===\n`);

  // --- 1. Repository validation (never the model's choice) --------------
  const targetRepository = process.env.TARGET_REPOSITORY;
  const validation = await validateTargetRepository(targetRepository);

  console.log(`Resolved TARGET_REPOSITORY: ${validation.resolvedPath ?? '(unset)'}`);
  if (!validation.valid) {
    console.error('\nRepository validation failed:');
    for (const error of validation.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('Repository validation: OK (exists, is a directory, is a git repository, `git status` succeeds)\n');

  const repository = validation.resolvedPath!;

  console.log('--- git status --short (before) ---');
  const statusBefore = await runGit(['status', '--short'], repository);
  console.log(statusBefore.stdout.trim() || '(clean)');
  console.log('');

  // --- 1b. Trellis (optional): context + task management -----------------
  const trellisAvailable = await hasTrellis(repository);
  let trellisTaskStarted = false;
  let trellisSpecFiles: string[] = [];
  console.log(`--- Trellis: ${trellisAvailable ? 'detected' : 'not present in this repository'} ---`);

  if (trellisAvailable) {
    const trellisTask = await createAndStartTrellisTask(repository, trellisTaskTitle, trellisTaskSlug);
    trellisTaskStarted = trellisTask.started;
    console.log(`Trellis task: ${trellisTask.started ? `started (${trellisTaskSlug})` : 'could not be started (continuing without one)'}`);
  }

  const trellisSpec = trellisAvailable ? await readTrellisSpecContext(repository) : undefined;
  if (trellisSpec) {
    trellisSpecFiles = trellisSpec.files;
    console.log(`Trellis spec context: ${trellisSpec.files.length} file(s)${trellisSpec.truncated ? ' (truncated to fit budget)' : ''}`);
    for (const file of trellisSpec.files) console.log(`  - ${file}`);
  }
  console.log('');

  async function finishAndExit(code: number): Promise<never> {
    if (trellisTaskStarted) await finishTrellisTask(repository);
    process.exit(code);
  }

  // --- 2. Supervisor: plan the task --------------------------------------
  const supervisorPrompt = trellisSpec
    ? `Project coding guidelines for this repository (from its Trellis spec system, .trellis/spec/). Where relevant to the task below, fold concrete conventions from these into the requirements you write - cite the specific guideline, don't just gesture at "follow conventions".\n\n${trellisSpec.text}\n\n---\n\nTask:\n\n${task}`
    : task;

  console.log('--- Supervisor: planning delegation ---');
  const supervisorStart = Date.now();
  const delegation = await planCodingTask(supervisorPrompt, { repository });
  const supervisorDurationMs = Date.now() - supervisorStart;
  console.log(JSON.stringify(delegation, null, 2));
  console.log(`Supervisor duration: ${supervisorDurationMs}ms\n`);

  // --- 3. Worker: run the workflow, mirroring telemetry (observe only) --
  // Ecosystem (Go vs JS) is auto-detected inside the workflow itself
  // (go.mod vs package.json) - whichever worker it picks, we intercept
  // *both* here so telemetry works regardless of which one actually runs.
  const telemetry = {
    iterations: [] as IterationRecord[],
    toolCallCounts: {} as Record<string, number>,
    toolErrorCounts: {} as Record<string, number>,
    applyPatch: { attempts: 0, success: 0, failed: 0, failures: [] as unknown[] },
    testCalls: { calls: 0, failures: [] as unknown[] },
    formatCalls: { calls: 0 },
    finishReason: undefined as string | undefined,
  };

  function wrapGenerate(worker: typeof codingWorkerGo) {
    const originalGenerate = worker.generate.bind(worker);
    (worker as any).generate = async (messages: unknown, genOptions: Record<string, unknown> = {}) => {
      const userHook = genOptions.onIterationComplete as ((ctx: any) => unknown) | undefined;

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
        });

        for (const call of context.toolCalls as ToolCallRecord[]) {
          telemetry.toolCallCounts[call.name] = (telemetry.toolCallCounts[call.name] ?? 0) + 1;
        }

        for (const result of context.toolResults as { name: string; result: unknown; error?: Error }[]) {
          if (result.error) telemetry.toolErrorCounts[result.name] = (telemetry.toolErrorCounts[result.name] ?? 0) + 1;

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
          if (result.name === 'runGoTest' || result.name === 'runJestTest') {
            telemetry.testCalls.calls += 1;
            const r = result.result as { success?: boolean } | undefined;
            if (!result.error && r && r.success === false) telemetry.testCalls.failures.push(r);
          }
          if (result.name === 'runGoFmt' || result.name === 'runPrettier') telemetry.formatCalls.calls += 1;
        }

        telemetry.finishReason = context.finishReason;
        return userHook ? await userHook(context) : undefined;
      };

      return originalGenerate(messages as any, { ...genOptions, onIterationComplete: wrappedHook } as any);
    };
    return originalGenerate;
  }

  const originalGoGenerate = wrapGenerate(codingWorkerGo);
  const originalJsGenerate = wrapGenerate(codingWorkerJs);

  console.log('--- Worker: running codingTaskWorkflow ---');
  console.log(`Ollama model: ${process.env.OLLAMA_MODEL ?? 'qwen3:8b'} @ ${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'}`);
  console.log(`Max repair attempts: ${process.env.MAX_REPAIR_ATTEMPTS ?? '3 (default)'}\n`);

  const workerStart = Date.now();
  const run = await codingTaskWorkflow.createRun();
  const workflowResult = await run.start({ inputData: delegation });
  const workerDurationMs = Date.now() - workerStart;

  (codingWorkerGo as any).generate = originalGoGenerate;
  (codingWorkerJs as any).generate = originalJsGenerate;

  console.log(`Worker duration: ${workerDurationMs}ms`);
  console.log(`Workflow status: ${workflowResult.status}\n`);

  if (workflowResult.status !== 'success') {
    console.error('Workflow did not complete successfully:');
    console.error(JSON.stringify(workflowResult, null, 2));
    console.log('\n--- git status --short (after) ---');
    console.log((await runGit(['status', '--short'], repository)).stdout.trim() || '(clean)');
    await finishAndExit(1);
  }

  const workerOutput = workflowResult.result;

  // --- 4. Independent, objective filesystem/tool state -------------------
  console.log('--- git status --short (after) ---');
  const statusAfter = await runGit(['status', '--short'], repository);
  console.log(statusAfter.stdout.trim() || '(clean)');

  console.log('\n--- git diff --stat ---');
  const diffStat = await runGit(['diff', '--stat'], repository);
  console.log(diffStat.stdout.trim() || '(empty)');

  console.log('\n--- git diff (tracked changes + untracked new files) ---');
  const diffTracked = await runGit(['diff'], repository);
  const untrackedFiles = statusAfter.stdout
    .split('\n')
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  const untrackedDiffs = await Promise.all(
    untrackedFiles.map((file) => runGit(['diff', '--no-index', '--', '/dev/null', file], repository)),
  );
  const diffAll = { stdout: diffTracked.stdout + untrackedDiffs.map((d) => d.stdout).join('') };
  console.log(diffAll.stdout || '(empty)');

  // --- 5. Claude review (read-only) ---------------------------------------
  console.log('\n--- Claude review (read-only) ---');
  const reviewerStart = Date.now();
  const review = await reviewCodingResult({
    task,
    delegation,
    workerFinalResponse: workerOutput.result,
    gitDiff: diffAll.stdout,
    gitDiffStat: diffStat.stdout,
    testResult: workerOutput.lastTestResult,
    gofmtCompleted: workerOutput.gofmtCompleted,
    goTestPassed: workerOutput.goTestPassed,
    patchApplied: workerOutput.patchApplied,
    trellisSpecExcerpt: trellisSpec?.text,
  });
  const reviewerDurationMs = Date.now() - reviewerStart;
  console.log(JSON.stringify(review, null, 2));
  console.log(`Reviewer duration: ${reviewerDurationMs}ms`);

  // --- 6. Model claim vs. objective reality --------------------------------
  const claimsSuccess = /\b(success|done|passed|completed|works|fixed)\b/i.test(workerOutput.result);
  const actuallySucceeded = workerOutput.patchApplied && workerOutput.gofmtCompleted && workerOutput.goTestPassed;
  const diffIsEmpty = diffAll.stdout.trim() === '';

  console.log('\n--- Model claim vs. objective reality ---');
  console.log(`Worker's final text reads as a success claim: ${claimsSuccess}`);
  console.log(`Objective outcome (patchApplied && formatCompleted && testPassed): ${actuallySucceeded}`);
  console.log(`Actual git diff is empty (no filesystem change at all): ${diffIsEmpty}`);
  if (claimsSuccess && !actuallySucceeded) {
    console.log('DISCREPANCY: worker\'s text claims success but the objective tool state disagrees.');
  } else if (!claimsSuccess && actuallySucceeded) {
    console.log('Note: worker under-claimed relative to the objective tool state (undersells but does not overstate).');
  } else {
    console.log('No discrepancy detected between the worker\'s claim and the objective tool state.');
  }

  // --- 7. Full trace --------------------------------------------------------
  console.log('\n--- Observability trace ---');
  console.log(
    JSON.stringify(
      {
        repository,
        supervisorDurationMs,
        workerDurationMs,
        reviewerDurationMs,
        workerIterations: telemetry.iterations.length,
        toolCallCounts: telemetry.toolCallCounts,
        toolErrorCounts: telemetry.toolErrorCounts,
        applyPatch: telemetry.applyPatch,
        testCalls: telemetry.testCalls,
        formatCalls: telemetry.formatCalls,
        finishReason: telemetry.finishReason,
        repairLoop: { attempts: workerOutput.attempts, status: workerOutput.status },
        objectiveState: {
          patchApplied: workerOutput.patchApplied,
          gofmtCompleted: workerOutput.gofmtCompleted,
          goTestPassed: workerOutput.goTestPassed,
          success: workerOutput.success,
        },
        trellis: {
          available: trellisAvailable,
          taskStarted: trellisTaskStarted,
          taskSlug: trellisTaskStarted ? trellisTaskSlug : undefined,
          specFilesUsed: trellisSpecFiles,
        },
      },
      null,
      2,
    ),
  );

  console.log('\n--- Full iteration log (JSON) ---');
  console.log(JSON.stringify(telemetry.iterations, null, 2));

  if (trellisTaskStarted) await finishTrellisTask(repository);

  console.log('\n=== Reminder: no commit, no push, no revert was performed by this script. ===');
}

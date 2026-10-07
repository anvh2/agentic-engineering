import type { IterationCompleteContext, IterationCompleteResult, OnIterationCompleteHandler } from '@mastra/core/agent';

export interface GoTestOutcome {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type RepairLoopStatus = 'pending' | 'test_passed' | 'test_failed' | 'blocked';

/**
 * Explicit, per-run state for the patch -> format -> test -> repair cycle
 * (Step 12). Deliberately not module-level or agent-level state: a fresh
 * tracker is created for each workflow run and its `state` object is the
 * only place this data lives, so a future durable/checkpointed version of
 * this workflow has a single, serializable object to persist between steps
 * instead of implicit state buried in a conversation or a global.
 */
export interface RepairLoopState {
  attempts: number;
  lastTestResult?: GoTestOutcome;
  status: RepairLoopStatus;
  /**
   * Objective, tool-confirmed state (Step 15.1) - true only once a real
   * applyPatch/[format tool] call has reported success in this run. Never
   * set from the model's own prose, so a model that claims a patch was
   * applied without ever calling applyPatch successfully cannot make this
   * true.
   */
  patchApplied: boolean;
  /**
   * True once the configured *format* tool (`runGoFmt` for a Go worker,
   * `runPrettier` for a JS worker - see `toolNames` on
   * createRepairLoopTracker) has reported success. Field name kept as
   * `gofmtCompleted` rather than renamed to something ecosystem-neutral,
   * to avoid rippling the rename through codingTaskOutputSchema and every
   * caller - the meaning is now "the format step completed", not
   * literally gofmt.
   */
  gofmtCompleted: boolean;
}

/** Which tool names to watch for the format/test steps. Defaults to the Go worker's tool names. */
export interface RepairLoopToolNames {
  format: string;
  test: string;
}

const DEFAULT_TOOL_NAMES: RepairLoopToolNames = { format: 'runGoFmt', test: 'runGoTest' };

function asGoTestOutcome(result: unknown): GoTestOutcome | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const candidate = result as Partial<GoTestOutcome>;
  if (typeof candidate.success !== 'boolean') return undefined;
  return {
    success: candidate.success,
    exitCode: typeof candidate.exitCode === 'number' ? candidate.exitCode : null,
    stdout: typeof candidate.stdout === 'string' ? candidate.stdout : '',
    stderr: typeof candidate.stderr === 'string' ? candidate.stderr : '',
  };
}

function isSuccessObject(result: unknown): result is { success: true } {
  return typeof result === 'object' && result !== null && (result as { success?: unknown }).success === true;
}

/**
 * applyPatch never returns `{ success: false }` - validation/apply failures
 * throw, and the AI SDK/Mastra tool-execution layer unwraps a thrown error
 * into a plain string `result` (confirmed against a live run: `toolResults[].error`
 * is never populated for this path). A failed call is therefore recognized as
 * "not a `{ success: true }` object", and its message recovered from whichever
 * of `result`/`error` is actually populated.
 */
function describeApplyPatchFailure(toolResult: { result: unknown; error?: Error }): string {
  if (typeof toolResult.result === 'string' && toolResult.result.trim() !== '') return toolResult.result;
  if (toolResult.error) return toolResult.error.message;
  return 'applyPatch failed for an unknown reason.';
}

/**
 * Watches an agent's tool telemetry (via onIterationComplete) for runGoTest
 * results and turns them into explicit, bounded repair-loop state - a
 * behavioral safety net alongside the worker's own instructions, not a
 * replacement for them. The worker's instructions ask it to stop after
 * `maxAttempts` failed repairs; this tracker enforces that:
 *
 * - On the attempt that reaches the limit, it injects feedback telling the
 *   model to stop and summarize, but still lets it produce a final answer
 *   (`continue` left undefined).
 * - If the model ignores that and drives runGoTest to fail again anyway, the
 *   next offending iteration is force-stopped (`continue: false`) - a model
 *   that doesn't cooperate can't turn this into an unbounded loop.
 *
 * Tool name matching against context.toolResults uses the tool's `id`
 * ("runGoTest"), which is what Mastra reports as `toolResults[].name`.
 */
/** Single source of truth for the repair-attempt bound, read fresh so it stays testable/configurable rather than cached at import time. */
export function resolveMaxRepairAttempts(): number {
  return Number(process.env.MAX_REPAIR_ATTEMPTS) || 3;
}

export function createRepairLoopTracker(
  maxAttempts: number,
  toolNames: RepairLoopToolNames = DEFAULT_TOOL_NAMES,
): {
  state: RepairLoopState;
  onIterationComplete: OnIterationCompleteHandler;
} {
  const state: RepairLoopState = { attempts: 0, status: 'pending', patchApplied: false, gofmtCompleted: false };

  const onIterationComplete = (context: IterationCompleteContext): IterationCompleteResult | void => {
    for (const toolResult of context.toolResults) {
      if (toolResult.name === 'applyPatch') {
        if (isSuccessObject(toolResult.result)) {
          state.patchApplied = true;
          continue;
        }

        // A rejected patch (e.g. "Patch is empty. Nothing to apply.") shares
        // the same bounded repair budget as a failing test - both are a
        // failed attempt at making progress, and neither should be able to
        // loop forever. Unlike a test failure, the exact rejection is
        // pushed into the conversation as explicit feedback (not just left
        // in the tool result) since a live run showed the model ignoring a
        // patch rejection it had already "seen" only as inline tool output.
        const message = describeApplyPatchFailure(toolResult);
        state.attempts += 1;

        if (state.attempts > maxAttempts) {
          state.status = 'blocked';
          return {
            continue: false,
            feedback: `Repair attempt limit (${maxAttempts}) was already reached and exceeded. Stopping now.`,
          };
        }

        if (state.attempts === maxAttempts) {
          state.status = 'blocked';
          return {
            feedback: `applyPatch failed:\n${message}\n\nYou have reached the maximum of ${maxAttempts} repair attempts. Do not apply another patch - stop now and write your final answer explaining the remaining failure and what you tried.`,
          };
        }

        return {
          feedback: `applyPatch failed:\n${message}\n\nThe file was not changed. Fix the diff (re-read the file first if needed) and call applyPatch again, or take a different approach.`,
        };
      }

      if (toolResult.name === toolNames.format) {
        if (!toolResult.error && isSuccessObject(toolResult.result)) state.gofmtCompleted = true;
        continue;
      }

      if (toolResult.name !== toolNames.test || toolResult.error) continue;
      const outcome = asGoTestOutcome(toolResult.result);
      if (!outcome) continue;

      state.lastTestResult = outcome;

      if (outcome.success) {
        state.status = 'test_passed';
        continue;
      }

      state.attempts += 1;

      if (state.attempts > maxAttempts) {
        state.status = 'blocked';
        return {
          continue: false,
          feedback: `Repair attempt limit (${maxAttempts}) was already reached and exceeded. Stopping now.`,
        };
      }

      if (state.attempts === maxAttempts) {
        state.status = 'blocked';
        return {
          feedback: `You have reached the maximum of ${maxAttempts} repair attempts and the tests are still failing. Do not apply another patch or run more tests - stop now and write your final answer explaining the remaining failure and what you tried.`,
        };
      }

      state.status = 'test_failed';
    }
  };

  return { state, onIterationComplete };
}

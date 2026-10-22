import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toOutcome } from './executor.ts';

test('workflow attempt telemetry maps to executor model calls; attempts without a response carry none', () => {
  const telemetry = { provider: 'codex', model: 'gpt-test', startedAt: 10, inferenceMs: 5, inputTokens: 7, outputTokens: null, usageSupport: 'tokens' };
  const outcome = toOutcome({
    runId: 'run-1', studioUrl: 'http://localhost:4111/x', status: 'success', error: undefined,
    result: {
      status: 'ESCALATED_TO_CLAUDE', reasons: [], codingAttempts: 2, runtimeRetries: 1,
      attempts: [
        { attempt: 1, filesMutated: [], durationMs: 1, runtimeRetries: 1 },
        { attempt: 2, filesMutated: [], durationMs: 1, runtimeRetries: 0, telemetry: { ...telemetry, attempt: 99 } },
        null,
      ],
    },
  } as never);
  assert.deepEqual(outcome.modelCalls, [{ ...telemetry, attempt: 2 }], 'the attempt number comes from the attempt, never from the telemetry body');
  assert.deepEqual(toOutcome({ runId: 'r', studioUrl: '', status: 'success', error: undefined, result: { status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0 } } as never).modelCalls, []);
});

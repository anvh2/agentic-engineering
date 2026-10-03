import assert from 'node:assert/strict';
import { isValidationError, type ValidationError } from '@mastra/core/tools';

/**
 * `Tool.execute` is typed to allow returning `void` (skipped input validation)
 * or a `ValidationError` alongside the tool's real output. Every test that
 * expects a *successful* call wants the real output typed directly instead
 * of re-narrowing that union at each call site.
 */
export async function callTool<TOutput>(
  promise: Promise<TOutput | ValidationError | void>,
): Promise<TOutput> {
  const result = await promise;
  assert.ok(result !== undefined, 'expected the tool call to produce output, got void');
  assert.ok(!isValidationError(result), () => `expected a successful result, got a validation error: ${JSON.stringify(result)}`);
  return result as TOutput;
}

import { unknownUsage, type ModelCall, type Usage } from './contract.ts';

/** Snapshot replacement, never additive SSE counters. Cached/reasoning counts are subsets, never added to totals. */
export function summarizeUsage(
  calls: readonly ModelCall[],
  scope: { objectiveId: string; taskId?: string; provider?: string; workerId?: string },
): Usage {
  const unique = new Map<string, ModelCall>();
  for (const call of calls) {
    if (
      call.objectiveId !== scope.objectiveId ||
      (scope.taskId && call.taskId !== scope.taskId) ||
      (scope.provider && call.provider !== scope.provider) ||
      (scope.workerId && call.workerId !== scope.workerId)
    )
      continue;
    const previous = unique.get(call.id);
    // A replayed pending observation cannot replace a completed measurement.
    if (!previous || previous.finishedAt === null || (call.finishedAt !== null && call.finishedAt >= previous.finishedAt))
      unique.set(call.id, call);
  }
  const rows = [...unique.values()];
  if (!rows.length) return unknownUsage();
  const result: Usage = { ...unknownUsage(), source: 'core.model-call', completeness: 'complete' };
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'latencyMs', 'actualCostUsd'] as const) {
    const values = rows.map((r) => r.usage[key]);
    // An incomplete sum would falsely look like a total. Preserve unknown for that dimension.
    result[key] = values.every((v) => v !== null) ? (values as number[]).reduce((a, b) => a + b, 0) : null;
  }
  if (rows.some((r) => r.status === 'RUNNING')) result.completeness = 'pending';
  else if (rows.some((r) => r.usage.completeness !== 'complete') || result.inputTokens === null || result.outputTokens === null)
    result.completeness = 'partial';
  // No price inference or cross-model price aggregation; individual call estimates retain their provenance.
  return result;
}

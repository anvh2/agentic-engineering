import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from './coding-task-trace.ts';
import type { CodingTask, CodingTaskResult } from './coding-task-runner.ts';

export const ENGINEERING_CONTEXT_ARTIFACT = 'engineering-context.json';

/**
 * Persists one task run's artifacts under `dir` (trace.jsonl is streamed there live by the trace sink):
 * contract.json, attempts.json (tool calls + verification output + model/token/latency metadata),
 * final.diff, summary.json and, when an engineering context was injected, engineering-context.json: the immutable
 * snapshot (schema version, fingerprint, approval status, design digests, exact prompt text) every attempt consumed.
 * Everything is redacted; the environment itself is never written.
 */
export async function persistRun(dir: string, summary: object, task: CodingTask, result: CodingTaskResult): Promise<void> {
  await mkdir(dir, { recursive: true });
  const write = (name: string, text: string) => writeFile(join(dir, name), redact(text));
  await write('contract.json', JSON.stringify(task, null, 2));
  await write('attempts.json', JSON.stringify(result.records, null, 2));
  await write('final.diff', result.finalDiff);
  const context = result.engineeringContext;
  if (context) await write(ENGINEERING_CONTEXT_ARTIFACT, JSON.stringify({ ...context, attemptFingerprints: result.records.map((r) => ({ attempt: r.attempt, fingerprint: r.engineeringContextFingerprint ?? null })) }, null, 2));
  await write(
    'summary.json',
    JSON.stringify({ ...summary, ...(context ? { engineeringContextFingerprint: context.fingerprint, designApproval: context.approval.status } : {}), modelCalls: result.modelCalls, implementationChanged: result.implementationChanged, verifiedStateHash: result.verifiedStateHash, editFailures: result.editFailures }, null, 2),
  );
}

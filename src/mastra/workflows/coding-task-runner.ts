import { preserveEofNewline } from './eof-newline.ts';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import type { IterationCompleteContext, IterationCompleteResult } from '@mastra/core/agent';
import { createPatch } from 'diff';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { REPOSITORY_ROOT_CONTEXT_KEY } from '../tools/repository-tools.ts';
import { runSandboxedCommand, sandboxStatus } from '../sandbox/sandbox.ts';
import { sharedModelCapacity, type ModelCapacity } from '../capacity/model-capacity.ts';
import { createRepairLoopTracker } from './repair-loop-tracker.ts';
import { harnessMetrics, type HarnessMetrics } from '../observability/metrics.ts';
import { createTraceSink, type TraceEvent, type TraceSink } from './coding-task-trace.ts';

/**
 * Harness-owned control loop for ONE bounded coding task.
 *
 * The worker proposes; this module verifies. Per coding attempt: fresh model
 * context -> worker edits -> harness diffs the filesystem (mutation policy)
 * -> harness formats -> harness runs the verification commands (plus any
 * harness-owned hidden tests) -> PASS only if the verifier exited 0 on the
 * exact state that was formatted. Nothing the model says, and nothing it
 * reports from its own tool calls, can produce PASS.
 *
 * Model-runtime failures (thrown errors, zero-step responses) are handled
 * separately from coding failures: one bounded runtime retry per coding
 * attempt that never consumes a coding attempt. If it is exhausted the task
 * stops and is reported as a runtime failure.
 */

const repoRelativePath = z
  .string()
  .min(1)
  .refine((p) => !isAbsolute(p) && !normalize(p).startsWith('..'), 'must be a repository-relative path');

export const codingTaskSchema = z.object({
  taskId: z.string().min(1),
  objective: z.string().min(1),
  /** The only files the worker may change. Everything else is immutable. */
  allowedFiles: z.array(repoRelativePath).min(1),
  /** Extra files shown to the worker (read-only), e.g. the visible test file. */
  contextFiles: z.array(repoRelativePath).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  /** argv arrays run by the harness from the repository root, in order; the first failing one is the failure fed back. */
  verificationCommands: z.array(z.array(z.string()).min(1)).min(1),
  constraints: z.array(z.string()).default([]),
  /**
   * Harness-owned verification files (path -> content). Never shown to the worker: written only
   * for verification, removed afterwards. Their path must not exist in the repository.
   */
  hiddenFiles: z.record(repoRelativePath, z.string()).default({}),
});

export type CodingTask = z.input<typeof codingTaskSchema>;

export interface ToolActivity {
  name: string;
  /** For edit tools only: whether the tool reported success. */
  ok?: boolean;
}

export type FailureCategory =
  | 'A_no_mutation'
  | 'B_patch_rejected'
  | 'C_wrong_implementation'
  | 'D_forbidden_mutation'
  | 'E_verifier_infrastructure'
  | 'F_model_runtime';

export interface AttemptRecord {
  /** Coding attempt number (1-based). A record with `runtimeError` never became a coding attempt. */
  attempt: number;
  durationMs: number;
  finishReason: string | undefined;
  modelCalls: number;
  toolCalls: ToolActivity[];
  filesMutated: string[];
  forbiddenFiles: string[];
  editFailures: number;
  /** Model-runtime retries used inside this attempt (0 or 1). Separate from coding retries. */
  runtimeRetries: number;
  /** Set only when the runtime retry was exhausted; the attempt did not count as a coding attempt. */
  runtimeError?: string;
  /** First chars of the model's final visible text - diagnostic only, never evidence. */
  workerText?: string;
  modelStats?: { inputTokens?: number; outputTokens?: number };
  formatter: { ran: boolean; ok: boolean } | null;
  verification: { command: string[]; exitCode: number | null; timedOut: boolean; output: string } | null;
  category?: FailureCategory;
}

export interface CodingTaskResult {
  verdict: 'PASS' | 'FAIL';
  /** Set when the task was refused before the worker ran because model-generated code cannot be isolated. */
  sandboxUnavailable?: string;
  failureCategory?: FailureCategory;
  /** Coding attempts consumed (runtime-failed invocations excluded). */
  attempts: number;
  modelCalls: number;
  /** Total model-runtime retries across the task. Reported separately from coding retries (attempts - 1). */
  runtimeRetries: number;
  /** True when a runtime retry was exhausted and the task stopped. */
  runtimeFailed: boolean;
  implementationChanged: boolean;
  forbiddenFilesChanged: string[];
  /** Every file whose content differs from the start of the task (allowed or not). Used to restore the tree on failure. */
  changedFiles: string[];
  editFailures: number;
  verifier: AttemptRecord['verification'];
  /** Hash of the allowed files at the moment the verifier last passed/failed; PASS always refers to this state. */
  verifiedStateHash: string | null;
  durationMs: number;
  finalDiff: string;
  records: AttemptRecord[];
  events: TraceEvent[];
}

/** Minimal slice of Agent the runner needs; lets tests substitute the model boundary. */
export interface WorkerLike {
  generate(
    prompt: string,
    options: Record<string, unknown>,
  ): Promise<{
    text?: string;
    finishReason?: string;
    steps?: unknown[];
    usage?: { inputTokens?: number; outputTokens?: number };
  }>;
}

export interface RunCodingTaskOptions {
  repoRoot: string;
  worker: WorkerLike;
  /** Coding attempts (verification failures), default 3. */
  maxAttempts?: number;
  /** Per model-call wall-clock cap. */
  modelTimeoutMs?: number;
  /** Pause before the single runtime retry. */
  runtimeRetryDelayMs?: number;
  modelLabel?: string;
  trace?: TraceSink;
  /** Operational metrics sink (observability only; never affects a run). Defaults to the process-wide instance. */
  metrics?: HarnessMetrics;
  /**
   * Cancellation (e.g. the Mastra run was cancelled): aborts the in-flight model call and starts no further attempt.
   * Reported as a runtime failure, so the caller restores the tree exactly as for any non-PASS.
   */
  signal?: AbortSignal;
  /** Machine-wide local-model concurrency limit (default: the shared lease database). Held only around each model call. */
  capacity?: ModelCapacity;
}

const EDIT_TOOLS = new Set(['applyPatch', 'writeFile']);
const MAX_RUNTIME_RETRIES = 1;
const MAX_FAILURE_CHARS = 2_000;

// ---- filesystem helpers -------------------------------------------------------

const IGNORED_DIRS = new Set(['.git', 'node_modules']);
const LARGE_FILE_BYTES = 2_000_000;
const sha = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

async function snapshotRepo(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.applypatch-')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        // Real repositories can hold large binaries: past this size, size+mtime stands in for content.
        const info = await stat(full);
        out.set(relative(root, full), info.size > LARGE_FILE_BYTES ? `large:${info.size}:${info.mtimeMs}` : sha(await readFile(full)));
      }
    }
  }
  await walk(root);
  return out;
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((p) => before.get(p) !== after.get(p)).sort();
}

async function hashFiles(root: string, files: string[]): Promise<string> {
  const h = createHash('sha256');
  for (const f of [...files].sort()) {
    h.update(f).update('\0');
    h.update(await readFile(join(root, f)).catch(() => Buffer.from('<missing>')));
    h.update('\0');
  }
  return h.digest('hex');
}

const exists = (p: string) => stat(p).then(() => true, () => false);

// ---- response introspection (observability only; never decides PASS) -----------

function extractToolActivity(response: { steps?: unknown[] }): { calls: ToolActivity[]; editFailures: number } {
  const calls: ToolActivity[] = [];
  let editFailures = 0;
  for (const step of response.steps ?? []) {
    for (const part of (step as { content?: unknown[] }).content ?? []) {
      const c = part as { type?: string; toolName?: string; output?: unknown; result?: unknown; isError?: boolean };
      if (c.type === 'tool-call' && c.toolName) calls.push({ name: c.toolName });
      if ((c.type === 'tool-result' || c.type === 'tool-error') && c.toolName && EDIT_TOOLS.has(c.toolName)) {
        let out: unknown = c.output ?? c.result;
        if (out && typeof out === 'object' && (out as { type?: string }).type === 'json') out = (out as { value?: unknown }).value;
        const ok = c.type === 'tool-result' && !c.isError && (out as { success?: unknown } | undefined)?.success === true;
        if (!ok) editFailures += 1;
        const call = [...calls].reverse().find((x) => EDIT_TOOLS.has(x.name) && x.ok === undefined);
        if (call) call.ok = ok;
      }
    }
  }
  return { calls, editFailures };
}

// ---- prompt (fresh context every attempt) ----------------------------------

async function buildPrompt(
  root: string,
  task: z.output<typeof codingTaskSchema>,
  previousFailure: string | undefined,
): Promise<string> {
  const files = [...new Set([...task.allowedFiles, ...task.contextFiles])];
  const sections = [
    `Task ${task.taskId}: ${task.objective}`,
    `You may modify ONLY: ${task.allowedFiles.join(', ')}. Every other file (including tests) is immutable; changing one fails the task.`,
  ];
  if (task.acceptanceCriteria.length) sections.push(`Acceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`);
  if (task.constraints.length) sections.push(`Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}`);
  sections.push(
    `The harness will format and run \`${task.verificationCommands.map((c) => c.join(' ')).join('` and `')}\` itself after you finish (possibly with additional checks you cannot see); its result is the only thing that counts.`,
  );
  sections.push('The current contents of every relevant file are included below, so no exploration is needed.');
  for (const f of files) {
    const content = await readFile(join(root, f), 'utf8').catch(() => '(file does not exist)');
    sections.push(`--- ${f}${task.allowedFiles.includes(f) ? ' (you may modify)' : ' (read-only)'} ---\n${content}`);
  }
  if (previousFailure) {
    sections.push(`A previous attempt did not pass verification. The files above are in their CURRENT state. Verifier output:\n${previousFailure}`);
  }
  return sections.join('\n\n');
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `...${text.slice(text.length - max)}`;
}

/** Per-attempt failure class, judged from harness evidence only. */
export function classifyAttempt(record: AttemptRecord, forbiddenNow: boolean): FailureCategory {
  if (forbiddenNow) return 'D_forbidden_mutation';
  if (record.runtimeError) return 'F_model_runtime';
  if (record.verification && record.verification.exitCode === null && !record.verification.timedOut) return 'E_verifier_infrastructure';
  if (record.filesMutated.length === 0) {
    return record.toolCalls.some((t) => EDIT_TOOLS.has(t.name)) ? 'B_patch_rejected' : 'A_no_mutation';
  }
  return 'C_wrong_implementation';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the loop ----------------------------------------------------------------

export async function runCodingTask(taskInput: CodingTask, options: RunCodingTaskOptions): Promise<CodingTaskResult> {
  const task = codingTaskSchema.parse(taskInput);
  const { repoRoot, worker } = options;
  const maxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.modelTimeoutMs ?? 300_000;
  const modelLabel = options.modelLabel ?? 'worker';
  const trace = options.trace ?? createTraceSink();
  const metrics = options.metrics ?? harnessMetrics;
  const taskStart = Date.now();

  for (const hidden of Object.keys(task.hiddenFiles)) {
    if (await exists(join(repoRoot, hidden))) throw new Error(`hidden verification file "${hidden}" already exists in the repository`);
  }

  // Fail closed: the worker's tools and the verifier execute model-written code; without OS isolation nothing runs,
  // not even the model (whatever it wrote could never be verified).
  const sandbox = await sandboxStatus();
  if (!sandbox.available) {
    const reason = sandbox.reason ?? 'unknown';
    trace.emit('task_failed', { attempts: 0, category: 'F_model_runtime', reason: `sandbox unavailable: ${reason}` });
    return {
      verdict: 'FAIL',
      sandboxUnavailable: reason,
      failureCategory: 'F_model_runtime',
      attempts: 0,
      modelCalls: 0,
      runtimeRetries: 0,
      runtimeFailed: true,
      implementationChanged: false,
      forbiddenFilesChanged: [],
      changedFiles: [],
      editFailures: 0,
      verifier: null,
      verifiedStateHash: null,
      durationMs: Date.now() - taskStart,
      finalDiff: '',
      records: [],
      events: trace.events,
    };
  }

  const original = await snapshotRepo(repoRoot);
  const originalContents = new Map<string, string>();
  for (const f of task.allowedFiles) originalContents.set(f, await readFile(join(repoRoot, f), 'utf8').catch(() => ''));

  trace.emit('task_started', {
    taskId: task.taskId,
    objective: task.objective,
    allowedFiles: task.allowedFiles,
    model: modelLabel,
    maxAttempts,
    maxRuntimeRetriesPerAttempt: MAX_RUNTIME_RETRIES,
  });

  const records: AttemptRecord[] = [];
  let codingAttempts = 0;
  let previousFailure: string | undefined;
  let verifiedStateHash: string | null = null;
  let passed = false;
  let runtimeFailed = false;
  let forbidden: string[] = [];

  while (codingAttempts < maxAttempts && !passed && !runtimeFailed && forbidden.length === 0) {
    if (options.signal?.aborted) {
      runtimeFailed = true;
      trace.emit('attempt_failed', { attempt: codingAttempts + 1, category: 'F_model_runtime', kind: 'runtime', reason: 'cancelled' });
      break;
    }
    const attemptNo = codingAttempts + 1;
    const attemptStart = Date.now();
    const before = await snapshotRepo(repoRoot);
    const record: AttemptRecord = {
      attempt: attemptNo,
      durationMs: 0,
      finishReason: undefined,
      modelCalls: 0,
      toolCalls: [],
      filesMutated: [],
      forbiddenFiles: [],
      editFailures: 0,
      runtimeRetries: 0,
      formatter: null,
      verification: null,
    };
    records.push(record);
    trace.emit('attempt_started', { attempt: attemptNo, maxAttempts });

    // Last known hash of each file, so iteration-level writes can report before/after.
    const knownHash = new Map(before);

    // ---- model invocation with one bounded runtime retry ----
    let responded = false;
    for (let runtimeTry = 0; runtimeTry <= MAX_RUNTIME_RETRIES && !responded; runtimeTry += 1) {
      const requestContext = new RequestContext();
      requestContext.set(REPOSITORY_ROOT_CONTEXT_KEY, repoRoot);
      const tracker = createRepairLoopTracker(3);
      const modelStart = Date.now();
      let failure: string | undefined;

      const onIterationComplete = async (ctx: IterationCompleteContext): Promise<IterationCompleteResult | void> => {
        if (ctx.text?.trim()) trace.emit('worker_status', { text: ctx.text.trim().slice(0, 300), diagnostic: true });
        for (const call of ctx.toolCalls ?? []) {
          const args = (call.args ?? {}) as { path?: unknown; content?: unknown };
          const path = typeof args.path === 'string' ? args.path : undefined;
          const result = ctx.toolResults?.find((r) => r.id === call.id);
          const r = result?.result as { success?: unknown } | undefined;
          const ok = result
            ? !result.error && (EDIT_TOOLS.has(call.name) ? r?.success === true : !(r && typeof r === 'object' && r.success === false))
            : undefined;
          trace.emit('tool_call_started', { name: call.name, path });
          trace.emit('tool_call_finished', { name: call.name, path, ok });
          if (call.name === 'readFile' && path) trace.emit('file_read', { path });
          if (EDIT_TOOLS.has(call.name) && path) {
            const bytes = typeof args.content === 'string' ? Buffer.byteLength(args.content) : undefined;
            const now = await readFile(join(repoRoot, path)).then(sha, () => '(missing)');
            trace.emit('file_write', { path, tool: call.name, ok, bytes, hashBefore: knownHash.get(path) ?? '(new)', hashAfter: now });
            if (now !== '(missing)') knownHash.set(path, now);
          }
        }
        return tracker.onIterationComplete(ctx);
      };

      let permit: { release(): void } | undefined;
      try {
        const waitStart = Date.now();
        permit = await (options.capacity ?? sharedModelCapacity()).acquire(`${modelLabel}:${task.taskId}:pid${process.pid}`, options.signal);
        trace.emit('model_started', { model: modelLabel, attempt: attemptNo, runtimeTry, capacityWaitMs: Date.now() - waitStart });
        const response = await worker.generate(await buildPrompt(repoRoot, task, previousFailure), {
          requestContext,
          onIterationComplete,
          abortSignal: options.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal]) : AbortSignal.timeout(timeoutMs),
        });
        const steps = response.steps ? response.steps.length : 1;
        if (steps === 0) {
          // Mastra can return (not throw) an aborted/failed run with zero steps - e.g. finishReason
          // 'tripwire' after a provider 500 or a timeout. A runtime failure, not a worker decision.
          failure = `no model response (finishReason=${response.finishReason ?? 'none'})`;
        } else {
          const activity = extractToolActivity(response);
          record.finishReason = response.finishReason;
          record.modelCalls += steps;
          record.toolCalls = activity.calls;
          record.editFailures = activity.editFailures;
          record.workerText = (response.text ?? '').slice(0, 200);
          record.modelStats = { inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens };
          metrics.workerInference(modelLabel, (Date.now() - modelStart) / 1000, 'ok');
          trace.emit('model_finished', {
            finishReason: response.finishReason,
            durationMs: Date.now() - modelStart,
            steps,
            inputTokens: response.usage?.inputTokens,
            outputTokens: response.usage?.outputTokens,
          });
          responded = true;
        }
      } catch (err) {
        failure = (err as Error).message;
      } finally {
        permit?.release();
      }

      if (!responded) {
        metrics.workerInference(modelLabel, (Date.now() - modelStart) / 1000, 'error');
        trace.emit('model_finished', { error: failure, durationMs: Date.now() - modelStart });
        if (runtimeTry < MAX_RUNTIME_RETRIES && !options.signal?.aborted) {
          record.runtimeRetries += 1;
          metrics.retry('runtime');
          trace.emit('runtime_retry', { attempt: attemptNo, retry: record.runtimeRetries, reason: failure });
          await sleep(options.runtimeRetryDelayMs ?? 2_000);
        } else {
          record.runtimeError = failure;
          break; // retry budget spent, or cancelled: no further model call
        }
      }
    }

    if (record.runtimeError) {
      // Runtime retry exhausted: report a runtime failure; this is not a coding attempt.
      runtimeFailed = true;
      record.durationMs = Date.now() - attemptStart;
      record.category = 'F_model_runtime';
      trace.emit('attempt_failed', { attempt: attemptNo, category: record.category, kind: 'runtime', reason: record.runtimeError });
      break;
    }
    codingAttempts += 1;

    // ---- mutation policy: judged from the filesystem, not from tool telemetry ----
    const afterWorker = await snapshotRepo(repoRoot);
    record.filesMutated = changedPaths(before, afterWorker);
    record.forbiddenFiles = record.filesMutated.filter((f) => !task.allowedFiles.includes(f));
    for (const f of record.filesMutated) {
      trace.emit('file_hash', { path: f, before: before.get(f) ?? '(absent)', after: afterWorker.get(f) ?? '(absent)', source: 'filesystem' });
    }
    forbidden = changedPaths(original, afterWorker).filter((f) => !task.allowedFiles.includes(f));

    if (forbidden.length === 0) {
      // ---- harness-owned formatting (itself a mutation), then verification of that exact state ----
      let formatterOk = true;
      for (const f of task.allowedFiles.filter((p) => p.endsWith('.go'))) {
        if (!(await exists(join(repoRoot, f)))) continue;
        const command = ['gofmt', '-w', f];
        trace.emit('verification_started', { command, phase: 'format' });
        const r = await runSandboxedCommand(command[0], command.slice(1), { cwd: repoRoot, root: repoRoot, timeoutMs: 10_000 });
        trace.emit('verification_finished', { command, phase: 'format', exitCode: r.exitCode, timedOut: r.timedOut, output: tail(r.stderr || r.stdout, 500) });
        if (!r.success) {
          formatterOk = false;
          previousFailure = `gofmt failed on ${f}:\n${tail(r.stderr || r.stdout, MAX_FAILURE_CHARS)}`;
        }
      }
      // Non-Go files have no formatter; the harness only normalizes the EOF newline so a whole-file rewrite
      // cannot leave an unrelated one-byte diff. The verifier below then runs on this exact state.
      for (const f of task.allowedFiles.filter((p) => !p.endsWith('.go'))) {
        const target = join(repoRoot, f);
        if (!(await exists(target))) continue;
        const current = await readFile(target, 'utf8');
        const fixed = preserveEofNewline(originalContents.get(f), current);
        if (fixed !== current) {
          await writeFile(target, fixed);
          trace.emit('verification_finished', { command: ['normalize-eof', f], phase: 'format', exitCode: 0, timedOut: false, output: 'restored EOF newline state' });
        }
      }
      record.formatter = { ran: true, ok: formatterOk };
      const stateAfterFormat = await hashFiles(repoRoot, task.allowedFiles);

      if (formatterOk) {
        // Hidden harness-owned tests exist only for the duration of verification.
        for (const [path, content] of Object.entries(task.hiddenFiles)) {
          await mkdir(dirname(join(repoRoot, path)), { recursive: true });
          await writeFile(join(repoRoot, path), content);
        }
        try {
          for (const command of task.verificationCommands) {
            trace.emit('verification_started', { command, phase: 'verify' });
            const started = Date.now();
            const r = await runSandboxedCommand(command[0], command.slice(1), { cwd: repoRoot, root: repoRoot, timeoutMs: 120_000 });
            metrics.verification((Date.now() - started) / 1000, r.success ? 'pass' : r.timedOut ? 'timeout' : 'fail');
            const output = tail(`${r.stdout}${r.stderr}`.trim(), MAX_FAILURE_CHARS);
            record.verification = { command, exitCode: r.exitCode, timedOut: r.timedOut, output };
            trace.emit('verification_finished', { command, phase: 'verify', exitCode: r.exitCode, timedOut: r.timedOut, durationMs: Date.now() - started, output });
            if (!r.success) {
              previousFailure = `$ ${command.join(' ')}\nexit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}\n${output}`;
              break;
            }
          }
        } finally {
          for (const path of Object.keys(task.hiddenFiles)) await rm(join(repoRoot, path), { force: true });
        }
      }

      // PASS requires every verification command to have succeeded AND the verified state to be the final state.
      const stateAfterVerify = await hashFiles(repoRoot, task.allowedFiles);
      const lastCommand = task.verificationCommands[task.verificationCommands.length - 1];
      const allRan = formatterOk && record.verification?.exitCode === 0 && record.verification.command === lastCommand;
      if (allRan && stateAfterVerify === stateAfterFormat) {
        // Verification executes worker-written code; whatever it left changed outside the allowed files is a forbidden
        // mutation exactly as if the worker had written it (the pre-verification check above cannot see it).
        const afterVerification = await snapshotRepo(repoRoot);
        const sideEffects = changedPaths(afterWorker, afterVerification).filter((f) => !task.allowedFiles.includes(f));
        if (sideEffects.length > 0) {
          forbidden = sideEffects;
          record.forbiddenFiles = [...new Set([...record.forbiddenFiles, ...sideEffects])];
          for (const f of sideEffects) {
            trace.emit('file_hash', { path: f, before: afterWorker.get(f) ?? '(absent)', after: afterVerification.get(f) ?? '(absent)', source: 'verification' });
          }
        } else {
          passed = true;
          verifiedStateHash = stateAfterVerify;
        }
      } else if (allRan) {
        previousFailure = 'The verification command modified the source files; verification is invalid.';
      }
    }

    record.durationMs = Date.now() - attemptStart;
    metrics.codingAttempt(passed ? 'pass' : 'fail');
    if (!passed) {
      record.category = classifyAttempt(record, forbidden.length > 0);
      trace.emit('attempt_failed', {
        attempt: attemptNo,
        category: record.category,
        kind: 'coding',
        reason: forbidden.length > 0 ? `forbidden mutation: ${forbidden.join(', ')}` : record.verification?.output.split('\n')[0],
      });
      if (codingAttempts < maxAttempts && forbidden.length === 0) {
        metrics.retry('coding');
        trace.emit('coding_retry', { fromAttempt: attemptNo, toAttempt: codingAttempts + 1 });
      }
    }
  }

  // ---- result ----
  const finalSnapshot = await snapshotRepo(repoRoot);
  const implementationChanged = changedPaths(original, finalSnapshot).some((f) => task.allowedFiles.includes(f));
  let finalDiff = '';
  for (const f of task.allowedFiles) {
    const now = await readFile(join(repoRoot, f), 'utf8').catch(() => '');
    if (now !== originalContents.get(f)) finalDiff += createPatch(f, originalContents.get(f) ?? '', now);
  }
  const last = records[records.length - 1];
  const failureCategory = passed ? undefined : (last?.category ?? 'F_model_runtime');
  const result: CodingTaskResult = {
    verdict: passed ? 'PASS' : 'FAIL',
    failureCategory,
    attempts: codingAttempts,
    modelCalls: records.reduce((n, r) => n + r.modelCalls, 0),
    runtimeRetries: records.reduce((n, r) => n + r.runtimeRetries, 0),
    runtimeFailed,
    implementationChanged,
    forbiddenFilesChanged: forbidden,
    changedFiles: changedPaths(original, finalSnapshot),
    editFailures: records.reduce((n, r) => n + r.editFailures, 0),
    verifier: [...records].reverse().find((r) => r.verification)?.verification ?? null,
    verifiedStateHash,
    durationMs: Date.now() - taskStart,
    finalDiff,
    records,
    events: trace.events,
  };
  metrics.workerTask(modelLabel, passed ? 'pass' : runtimeFailed ? 'runtime_failure' : 'fail');
  trace.emit(passed ? 'task_passed' : 'task_failed', {
    attempts: codingAttempts,
    category: failureCategory,
    runtimeRetries: result.runtimeRetries,
    durationMs: result.durationMs,
  });
  return result;
}

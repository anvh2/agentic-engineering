import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import { runControlledCommand } from '../../workers/tools/execution-tools.ts';
import { sandboxStatus } from '../sandbox/sandbox.ts';
import {
  codingTaskSchema,
  runCodingTask,
  type AttemptRecord,
  type CodingTask,
  type CodingTaskResult,
  type RunCodingTaskOptions,
  type WorkerLike,
} from './coding-task-runner.ts';
import { persistRun } from './coding-task-artifacts.ts';
import { createTraceSink, redact, type TraceSink } from './coding-task-trace.ts';

/**
 * Engineering Lead -> local coding worker delegation.
 *
 *   Lead writes a DelegationRequest (contract + its own assessment)
 *     -> deterministic gate decides route: qwen | claude   (no model involved)
 *     -> qwen route: bounded runCodingTask (max 3 coding attempts, fresh context each)
 *     -> runtime verifier owns PASS/FAIL
 *     -> PASS: verified change is left UNCOMMITTED in the working tree for the Lead to review
 *     -> anything else: the tree is restored and the task is handed back to Claude with evidence
 *
 * The worker never owns the verdict, and nothing here commits, pushes or loops past the attempt cap.
 */

export const leadAssessmentSchema = z.object({
  complexity: z.enum(['small', 'medium', 'large']),
  risk: z.enum(['low', 'medium', 'high']),
  ambiguity: z.enum(['none', 'some', 'significant']),
  /** Why the Lead believes this is (or is not) a bounded task a small local model can do. */
  rationale: z.string().min(1),
});

export const delegationRequestSchema = z.object({
  contract: codingTaskSchema,
  assessment: leadAssessmentSchema,
});

export type DelegationRequest = z.input<typeof delegationRequestSchema>;

export interface DelegationPolicy {
  maxAllowedFiles: number;
  /** Languages the worker has a measured track record on. Extend only with benchmark evidence. */
  allowedExtensions: string[];
  /** Binaries the Lead may name as verification commands. */
  allowedVerificationBinaries: string[];
  /** Hard ceiling on coding attempts; requests can only lower it. */
  maxAttempts: number;
}

export const DEFAULT_POLICY: DelegationPolicy = {
  maxAllowedFiles: 1,
  allowedExtensions: ['.go'],
  allowedVerificationBinaries: ['go', 'gofmt'],
  maxAttempts: 3,
};

export const TEST_FILE = /(_test\.go$|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__)\/)/;

export type Language = 'go' | 'js';

/**
 * Policy for JavaScript tasks (plain .js/.mjs/.cjs only). TypeScript is deliberately NOT enabled: it needs its own
 * type-check verifier allow-list and benchmark evidence first. The binary allow-list is just `npx`; the exact argv shape
 * is enforced by validateJsVerification, because `npx <anything>` would otherwise be arbitrary code execution.
 */
export const JS_POLICY: DelegationPolicy = {
  maxAllowedFiles: 1,
  allowedExtensions: ['.js', '.mjs', '.cjs'],
  allowedVerificationBinaries: ['npx'],
  maxAttempts: 3,
};

/** The one language all allowed files belong to, or undefined for mixed / unsupported files. */
export function languageOf(files: string[]): Language | undefined {
  const languages = new Set(
    files.map((f) => (DEFAULT_POLICY.allowedExtensions.includes(extname(f)) ? 'go' : JS_POLICY.allowedExtensions.includes(extname(f)) ? 'js' : 'other')),
  );
  if (languages.size === 1) {
    const [only] = [...languages];
    if (only === 'go' || only === 'js') return only;
  }
  return undefined;
}

export function policyFor(language: Language | undefined): DelegationPolicy {
  return language === 'js' ? JS_POLICY : DEFAULT_POLICY;
}

/** Name of the registered Mastra agent that does the editing for a language. */
export function workerAgentIdFor(language: Language | undefined): 'codingWorkerGo' | 'codingWorkerJs' {
  return language === 'js' ? 'codingWorkerJs' : 'codingWorkerGo';
}

const JS_VERIFY_FLAGS = new Set(['--runInBand', '--ci']);

/**
 * JS verification must be exactly `npx --no-install jest [--runInBand|--ci] <test file>...`.
 *  - `--no-install`: npx may never fetch and run a package from the network.
 *  - flags are an allow-list: `--config`, `--setupFiles`, `--runner`, `--testEnvironment`... all execute arbitrary files.
 *  - at least one test path (no whole-suite runs); each is repo-relative, free of `..`, looks like a test file, and is
 *    either an existing file or a runtime-owned hiddenFiles entry.
 */
export async function validateJsVerification(command: string[], contract: CodingTask, repoRoot: string): Promise<string[]> {
  const label = command.join(' ');
  if (command[0] !== 'npx' || command[1] !== '--no-install' || command[2] !== 'jest') {
    return [`verification command "${label}" must start with "npx --no-install jest"`];
  }
  const reasons: string[] = [];
  const args = command.slice(3);
  const paths = args.filter((a) => !a.startsWith('-'));
  for (const arg of args.filter((a) => a.startsWith('-'))) {
    if (!JS_VERIFY_FLAGS.has(arg)) reasons.push(`jest flag "${arg}" is not allow-listed (allowed: ${[...JS_VERIFY_FLAGS].join(', ')})`);
  }
  if (paths.length === 0) reasons.push('jest verification must name at least one test file (whole-suite runs are not delegated)');
  for (const path of paths) {
    const normalized = normalize(path);
    if (isAbsolute(path) || normalized.startsWith('..') || normalized !== path) {
      reasons.push(`jest test path "${path}" must be a normalized repo-relative path without ".."`);
      continue;
    }
    if (!TEST_FILE.test(path)) reasons.push(`jest test path "${path}" is not a test file`);
    const hidden = Object.hasOwn(contract.hiddenFiles ?? {}, path);
    const info = await lstat(join(repoRoot, path)).catch(() => undefined);
    if (!hidden && !info) reasons.push(`jest test path "${path}" does not exist and is not a hiddenFiles entry`);
    if (info?.isSymbolicLink()) reasons.push(`jest test path "${path}" is a symlink`);
  }
  return reasons;
}

export type Route = { route: 'qwen' } | { route: 'claude'; reasons: string[] };

/** Deterministic gate. Anything it cannot positively clear stays with Claude. */
export async function routeTask(
  request: DelegationRequest,
  repoRoot: string,
  explicitPolicy?: DelegationPolicy,
): Promise<Route> {
  const parsed = delegationRequestSchema.safeParse(request);
  if (!parsed.success) {
    return { route: 'claude', reasons: parsed.error.issues.map((i) => `invalid request: ${i.path.join('.')}: ${i.message}`) };
  }
  const { contract, assessment } = parsed.data;
  const reasons: string[] = [];
  const language = languageOf(contract.allowedFiles);
  const policy = explicitPolicy ?? policyFor(language);
  if (!explicitPolicy && contract.allowedFiles.length > 0 && !language) {
    reasons.push('allowed files must all be .go, or all be .js/.mjs/.cjs (mixed or other file types are not delegated)');
  }

  if (assessment.complexity !== 'small') reasons.push(`complexity is "${assessment.complexity}", only "small" tasks are delegated`);
  if (assessment.risk !== 'low') reasons.push(`risk is "${assessment.risk}", only "low" risk tasks are delegated`);
  if (assessment.ambiguity !== 'none') reasons.push(`ambiguity is "${assessment.ambiguity}", ambiguous tasks stay with Claude`);

  if (contract.allowedFiles.length > policy.maxAllowedFiles) {
    reasons.push(`${contract.allowedFiles.length} allowed files exceeds the limit of ${policy.maxAllowedFiles}`);
  }
  if (contract.acceptanceCriteria.length === 0) reasons.push('no acceptance criteria');
  if (contract.constraints.length === 0) reasons.push('no constraints');
  if (!contract.constraints.some((c) => /test/i.test(c) && /immutable|must not|do not|never/i.test(c))) {
    reasons.push('constraints must state that tests are immutable');
  }

  for (const file of contract.allowedFiles) {
    if (!policy.allowedExtensions.includes(extname(file))) reasons.push(`${file}: extension not in ${policy.allowedExtensions.join(', ')}`);
    if (TEST_FILE.test(file)) reasons.push(`${file}: test files are the oracle and can never be worker-editable`);
    const info = await lstat(join(repoRoot, file)).catch(() => undefined);
    if (info?.isSymbolicLink()) reasons.push(`${file}: symlinks are not allowed`);
    if (!info) {
      const parent = await lstat(join(repoRoot, dirname(file))).catch(() => undefined);
      if (!parent?.isDirectory()) reasons.push(`${file}: does not exist and its directory does not exist`);
    }
  }
  for (const file of contract.contextFiles) {
    if (!(await lstat(join(repoRoot, file)).catch(() => undefined))) reasons.push(`context file ${file} does not exist`);
  }
  for (const command of contract.verificationCommands) {
    if (!policy.allowedVerificationBinaries.includes(command[0])) reasons.push(`verification binary "${command[0]}" is not allow-listed`);
    else if (policy === JS_POLICY) reasons.push(...(await validateJsVerification(command, contract, repoRoot)));
  }

  // Model-written code is only ever executed inside the OS sandbox; without it nothing is delegated (fail closed).
  const sandbox = await sandboxStatus();
  if (!sandbox.available) reasons.push(`OS sandbox unavailable (${sandbox.reason}); model-generated code is never executed without isolation`);

  // The repository must be a git work tree and the files the worker may touch must be clean,
  // so a failed run can be restored exactly.
  const inside = await runControlledCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, timeoutMs: 10_000 });
  if (!inside.success) {
    reasons.push('repository is not a git work tree');
  } else {
    const status = await runControlledCommand('git', ['status', '--porcelain', '--', ...contract.allowedFiles], { cwd: repoRoot, timeoutMs: 10_000 });
    if (status.stdout.trim() !== '') reasons.push(`allowed files have uncommitted changes: ${status.stdout.trim().replace(/\n/g, '; ')}`);
  }

  return reasons.length === 0 ? { route: 'qwen' } : { route: 'claude', reasons };
}

export interface EscalationReport {
  taskId: string;
  reason: 'coding_attempts_exhausted' | 'forbidden_mutation';
  codingAttempts: number;
  attempts: { attempt: number; category: string | undefined; filesMutated: string[]; verifierOutputTail: string | undefined }[];
  lastVerifierOutput: string | undefined;
  /** What the worker last produced. It has been reverted from the tree; kept for reference only. */
  workerFinalDiff: string;
  forbiddenFilesChanged: string[];
  contract: CodingTask;
  note: string;
}

export type EngineeringStatus =
  | 'PASS' // verified by the runtime; change left uncommitted in the working tree
  | 'ESCALATED_TO_CLAUDE' // worker exhausted its coding attempts (or broke the mutation policy)
  | 'RUNTIME_FAILURE' // model runtime unavailable; not a coding failure, not auto-escalated
  | 'KEPT_BY_CLAUDE'; // gate refused delegation; worker never invoked

export interface EngineeringResult {
  taskId: string;
  status: EngineeringStatus;
  reasons: string[];
  run?: CodingTaskResult;
  escalation?: EscalationReport;
  /** The verified diff on PASS. */
  diff: string;
  /** True if the runtime had to restore the working tree. */
  restored: boolean;
  artifactDir?: string;
}

/** Puts every file the worker touched back exactly as it was: tracked -> checkout, untracked -> delete. Never commits. */
export async function restoreWorkingTree(repoRoot: string, changedFiles: string[]): Promise<void> {
  for (const file of changedFiles) {
    const tracked = await runControlledCommand('git', ['ls-files', '--error-unmatch', '--', file], { cwd: repoRoot, timeoutMs: 10_000 });
    if (tracked.success) {
      await runControlledCommand('git', ['checkout', '--', file], { cwd: repoRoot, timeoutMs: 10_000 });
    } else {
      await rm(join(repoRoot, file), { force: true });
    }
  }
}

function buildEscalation(request: z.output<typeof delegationRequestSchema>, run: CodingTaskResult): EscalationReport {
  const failed = run.records.filter((r: AttemptRecord) => !r.runtimeError);
  return {
    taskId: request.contract.taskId,
    reason: run.forbiddenFilesChanged.length > 0 ? 'forbidden_mutation' : 'coding_attempts_exhausted',
    codingAttempts: run.attempts,
    attempts: failed.map((r) => ({ attempt: r.attempt, category: r.category, filesMutated: r.filesMutated, verifierOutputTail: r.verification?.output })),
    lastVerifierOutput: run.verifier?.output,
    workerFinalDiff: run.finalDiff,
    forbiddenFilesChanged: run.forbiddenFilesChanged,
    contract: request.contract,
    note: 'The local worker could not complete this task within its coding-attempt budget. Its changes were reverted; the diff is for reference only. Claude should take over.',
  };
}

export interface DelegateOptions {
  repoRoot: string;
  worker: WorkerLike;
  policy?: DelegationPolicy;
  artifactDir?: string;
  trace?: TraceSink;
  modelLabel?: string;
  runOptions?: Pick<RunCodingTaskOptions, 'modelTimeoutMs' | 'runtimeRetryDelayMs' | 'signal'>;
}

/**
 * Runs an already-cleared delegation through the runtime-owned runner (the ONE source of coding execution
 * semantics), restores the tree on anything but PASS, and builds the result/escalation. Does not re-gate:
 * callers route first (routeTask). Used by delegateCodingTask and by the Mastra coding-task-workflow.
 */
export async function executeDelegation(requestInput: DelegationRequest, options: DelegateOptions): Promise<EngineeringResult> {
  const policy = options.policy ?? DEFAULT_POLICY; // only maxAttempts is read here; both language policies share it
  const { repoRoot } = options;
  const request = delegationRequestSchema.parse(requestInput);
  const taskId = request.contract.taskId;
  const trace =
    options.trace ??
    createTraceSink({ jsonlPath: options.artifactDir ? join(options.artifactDir, 'trace.jsonl') : undefined });

  const run = await runCodingTask(request.contract, {
    repoRoot,
    worker: options.worker,
    modelLabel: options.modelLabel,
    maxAttempts: policy.maxAttempts,
    trace,
    ...options.runOptions,
  });

  let status: EngineeringStatus;
  let escalation: EscalationReport | undefined;
  let restored = false;
  const reasons: string[] = [];

  if (run.verdict === 'PASS') {
    status = 'PASS';
  } else {
    await restoreWorkingTree(repoRoot, run.changedFiles);
    restored = run.changedFiles.length > 0;
    if (run.sandboxUnavailable) {
      status = 'RUNTIME_FAILURE';
      reasons.push(`sandbox_unavailable: ${run.sandboxUnavailable}`);
    } else if (run.runtimeFailed) {
      status = 'RUNTIME_FAILURE';
      reasons.push(`model runtime failed after its bounded retry: ${run.records.at(-1)?.runtimeError ?? 'unknown'}`);
    } else {
      status = 'ESCALATED_TO_CLAUDE';
      escalation = buildEscalation(request, run);
      reasons.push(escalation.reason);
    }
  }

  const result: EngineeringResult = { taskId, status, reasons, run, escalation, diff: status === 'PASS' ? run.finalDiff : '', restored, artifactDir: options.artifactDir };

  if (options.artifactDir) {
    await mkdir(options.artifactDir, { recursive: true });
    await persistRun(options.artifactDir, { taskId, status, verdict: run.verdict, failureCategory: run.failureCategory, attempts: run.attempts, runtimeRetries: run.runtimeRetries, durationMs: run.durationMs }, request.contract, run);
    if (escalation) await writeFile(join(options.artifactDir, 'escalation.json'), redact(JSON.stringify(escalation, null, 2)));
    await writeFile(
      join(options.artifactDir, 'result.json'),
      redact(JSON.stringify({ taskId, status, reasons, restored, attempts: run.attempts, runtimeRetries: run.runtimeRetries, failureCategory: run.failureCategory, assessment: request.assessment }, null, 2)),
    );
  }
  return result;
}

export async function delegateCodingTask(requestInput: DelegationRequest, options: DelegateOptions): Promise<EngineeringResult> {
  const taskId = (requestInput as { contract?: { taskId?: string } })?.contract?.taskId ?? 'unknown';
  const route = await routeTask(requestInput, options.repoRoot, options.policy);
  if (route.route === 'claude') {
    return { taskId, status: 'KEPT_BY_CLAUDE', reasons: route.reasons, diff: '', restored: false };
  }
  return executeDelegation(requestInput, options);
}

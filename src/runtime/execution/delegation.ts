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
import { denyAllApprovals, type ApprovalVerifier } from './design-approval.ts';
import { knowledgeLanguageForFiles, type EngineeringKnowledgeCatalog } from '../knowledge/engineering-knowledge.ts';
import { LANGUAGE_ADAPTERS, delegatableLanguage } from './language-adapters.ts';

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
  /**
   * Which worker provider runs this task (default: the local model). This is only a REQUEST: any provider other than the
   * default additionally needs the operator's allow-list (worker-provider.ts), enforced by the scheduler and again by the
   * workflow, so writing it into a plan authorizes nothing.
   */
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
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

/** Frozen copy of a registry policy: the ceiling cannot be widened by mutating an exported policy object. */
const frozenPolicy = (p: DelegationPolicy): DelegationPolicy =>
  Object.freeze({ ...p, allowedExtensions: Object.freeze([...p.allowedExtensions]) as string[], allowedVerificationBinaries: Object.freeze([...p.allowedVerificationBinaries]) as string[] });

export const DEFAULT_POLICY: DelegationPolicy = frozenPolicy(LANGUAGE_ADAPTERS.go.policy);
export const TEST_FILE = /(_test\.go$|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__)\/)/;
export type Language = 'go' | 'js';

/** JS keeps the same bounded Jest policy; TypeScript remains disabled until it has a verified adapter. */
export const JS_POLICY: DelegationPolicy = frozenPolicy(LANGUAGE_ADAPTERS.js.policy);

export function languageOf(files: string[]): Language | undefined {
  return delegatableLanguage(files.map((file) => extname(file)));
}

export function policyFor(language: Language | undefined): DelegationPolicy {
  return language === 'js' ? JS_POLICY : DEFAULT_POLICY;
}

/**
 * The permissions a run may actually use: the registry ceiling for the detected language, narrowed (never widened) by a
 * caller-supplied policy. A copied, hand-built or permissive policy therefore cannot add an extension, a verifier binary,
 * more files or more attempts than the language adapter allows, and it cannot change which argv validator runs - that follows
 * the language, never the identity of the policy object.
 */
export function effectivePolicy(language: Language | undefined, requested?: DelegationPolicy): DelegationPolicy {
  const ceiling = policyFor(language);
  if (!requested) return ceiling;
  const within = (values: readonly string[], allowed: readonly string[]) => values.filter((v) => allowed.includes(v));
  return Object.freeze({
    maxAllowedFiles: Math.min(ceiling.maxAllowedFiles, requested.maxAllowedFiles),
    maxAttempts: Math.min(ceiling.maxAttempts, requested.maxAttempts),
    allowedExtensions: within(requested.allowedExtensions, ceiling.allowedExtensions),
    allowedVerificationBinaries: within(requested.allowedVerificationBinaries, ceiling.allowedVerificationBinaries),
  });
}

export function workerAgentIdFor(language: Language | undefined): 'codingWorkerGo' | 'codingWorkerJs' {
  return language === 'js' ? LANGUAGE_ADAPTERS.js.workerAgentId : LANGUAGE_ADAPTERS.go.workerAgentId;
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
  options: { approvals?: ApprovalVerifier; knowledgeCatalog?: EngineeringKnowledgeCatalog } = {},
): Promise<Route> {
  const parsed = delegationRequestSchema.safeParse(request);
  if (!parsed.success) {
    return { route: 'claude', reasons: parsed.error.issues.map((i) => `invalid request: ${i.path.join('.')}: ${i.message}`) };
  }
  const { contract, assessment } = parsed.data;
  const reasons: string[] = [];
  const language = languageOf(contract.allowedFiles);
  // An injected policy may reduce permissions for a test or trusted caller, but is intersected with the
  // language's registry ceiling: it can never enable an unbenchmarked language, widen a verifier allow-list or
  // select a weaker argv validator.
  const policy = effectivePolicy(language, explicitPolicy);
  if (contract.allowedFiles.length > 0 && !language) {
    reasons.push('allowed files must all be .go, or all be .js/.mjs/.cjs (mixed or other file types are not delegated)');
  }

  // Pinned curated knowledge must resolve, in the runtime's own catalog, to exactly the digest the Lead pinned. Otherwise the
  // task stays with Claude with a reason, instead of failing late inside the runner after a worker slot was spent.
  if (contract.knowledge) {
    try {
      if (!options.knowledgeCatalog) throw new Error('no trusted runtime catalog is configured');
      const lang = knowledgeLanguageForFiles(contract.allowedFiles);
      if (!lang) throw new Error('implementation language is unknown or mixed');
      const selection = options.knowledgeCatalog.resolve({ language: lang, ids: contract.knowledge.ids });
      if (selection.omitted.length) throw new Error('selection exceeds the context budget');
      if (selection.digest !== contract.knowledge.selectionDigest) throw new Error('selection digest differs from the pinned digest (changed, replaced or revoked)');
    } catch (err) {
      reasons.push(`pinned knowledge rejected: ${(err as Error).message}`);
    }
  }

  if (assessment.complexity !== 'small') reasons.push(`complexity is "${assessment.complexity}", only "small" tasks are delegated`);
  if (assessment.risk !== 'low') reasons.push(`risk is "${assessment.risk}", only "low" risk tasks are delegated`);
  if (assessment.ambiguity !== 'none') reasons.push(`ambiguity is "${assessment.ambiguity}", ambiguous tasks stay with Claude`);

  if (contract.allowedFiles.length > policy.maxAllowedFiles) {
    reasons.push(`${contract.allowedFiles.length} allowed files exceeds the limit of ${policy.maxAllowedFiles}`);
  }
  // An attached design must verify against the runtime's approval records (default: deny); an arbitrary approvalRef never routes to a worker.
  if (contract.approvedDesign) {
    const verdict = (options.approvals ?? denyAllApprovals)({ approvalRef: contract.approvedDesign.approvalRef, design: contract.approvedDesign, taskId: contract.taskId, allowedFiles: contract.allowedFiles });
    if (!verdict.ok) reasons.push(`approved design rejected (${verdict.code}): ${verdict.reason}`);
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
    else if (language === 'js') reasons.push(...(await validateJsVerification(command, contract, repoRoot)));
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
  runOptions?: Pick<RunCodingTaskOptions, 'modelTimeoutMs' | 'runtimeRetryDelayMs' | 'signal' | 'runId'>;
  /** Verifies an attached approvedDesign (default: deny all, i.e. fail closed). Used by routing and again by the runner. */
  approvals?: ApprovalVerifier;
  knowledgeCatalog?: EngineeringKnowledgeCatalog;
}

/**
 * Runs an already-cleared delegation through the runtime-owned runner (the ONE source of coding execution
 * semantics), restores the tree on anything but PASS, and builds the result/escalation. Does not re-gate:
 * callers route first (routeTask). Used by delegateCodingTask and by the Mastra coding-task-workflow.
 */
export async function executeDelegation(requestInput: DelegationRequest, options: DelegateOptions): Promise<EngineeringResult> {
  const { repoRoot } = options;
  const request = delegationRequestSchema.parse(requestInput);
  // Only maxAttempts is read here, but it is clamped to the language ceiling like every other permission.
  const policy = effectivePolicy(languageOf(request.contract.allowedFiles), options.policy);
  const taskId = request.contract.taskId;
  const trace =
    options.trace ??
    createTraceSink({ jsonlPath: options.artifactDir ? join(options.artifactDir, 'trace.jsonl') : undefined });

  const run = await runCodingTask(request.contract, {
    repoRoot,
    worker: options.worker,
    modelLabel: options.modelLabel,
    maxAttempts: policy.maxAttempts,
    approvals: options.approvals,
    knowledgeCatalog: options.knowledgeCatalog,
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
      redact(JSON.stringify({ taskId, status, reasons, restored, attempts: run.attempts, runtimeRetries: run.runtimeRetries, failureCategory: run.failureCategory, assessment: request.assessment, ...(run.engineeringContext ? { engineeringContextFingerprint: run.engineeringContext.fingerprint, designApproval: run.engineeringContext.approval.status } : {}) }, null, 2)),
    );
  }
  return result;
}

export async function delegateCodingTask(requestInput: DelegationRequest, options: DelegateOptions): Promise<EngineeringResult> {
  const taskId = (requestInput as { contract?: { taskId?: string } })?.contract?.taskId ?? 'unknown';
  const route = await routeTask(requestInput, options.repoRoot, options.policy, { approvals: options.approvals });
  if (route.route === 'claude') {
    return { taskId, status: 'KEPT_BY_CLAUDE', reasons: route.reasons, diff: '', restored: false };
  }
  return executeDelegation(requestInput, options);
}

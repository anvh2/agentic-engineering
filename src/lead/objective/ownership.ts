import { lstat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { TEST_FILE, languageOf, policyFor, validateJsVerification } from '../../runtime/execution/delegation.ts';
import type { PlannedTask } from './types.ts';

/**
 * Task ownership policy.
 *
 *   LOCAL_WORKER    small, bounded, mechanically verifiable: must pass every static check the runtime's delegation gate
 *                   (routeTask) applies, so a plan can never promise a delegation the gate would refuse.
 *   CLAUDE_LEAD     everything the Lead keeps: architecture, cross-file work, TypeScript/JSX, tests that are the oracle.
 *   HUMAN_DECISION  ambiguous or high-risk: surfaced, never silently delegated.
 *
 * Environment checks routeTask makes at claim time (OS sandbox available, allowed files clean in the git work tree) are
 * not repeatable at plan time and stay with the runtime; the plan only promises what is statically decidable.
 */

export interface OwnershipContext {
  repoRoot: string;
  /** Files that earlier tasks in the DAG (transitive dependencies) create or change; they may not exist yet. */
  ancestorFiles: ReadonlySet<string>;
}

function parentDirs(file: string): string[] {
  const dirs: string[] = [];
  for (let d = dirname(file); d !== '.' && d !== '/'; d = dirname(d)) dirs.push(d);
  return dirs;
}

async function isDirectory(path: string): Promise<boolean> {
  return Boolean((await lstat(path).catch(() => undefined))?.isDirectory());
}

export interface Ineligibility {
  /** assessment: too complex/risky/ambiguous. scope: unbounded or unsupported mutation scope. criteria: nothing to judge by. verification: a command the runtime will not run. */
  kind: 'assessment' | 'scope' | 'criteria' | 'verification';
  message: string;
}

/** Reasons the task cannot be a LOCAL_WORKER task; empty means eligible. Read-only (lstat only). */
export async function workerIneligibility(task: PlannedTask, ctx: OwnershipContext): Promise<Ineligibility[]> {
  const reasons: Ineligibility[] = [];
  const add = (kind: Ineligibility['kind'], message: string) => reasons.push({ kind, message });
  const { assessment } = task;
  if (assessment.complexity !== 'small') add('assessment', `complexity is "${assessment.complexity}"; only "small" tasks are delegated`);
  if (assessment.risk !== 'low') add('assessment', `risk is "${assessment.risk}"; only "low" risk tasks are delegated`);
  if (assessment.ambiguity !== 'none') add('assessment', `ambiguity is "${assessment.ambiguity}"; ambiguous tasks stay with the Lead`);

  // bounded mutation scope
  const language = languageOf(task.allowedFiles);
  const policy = policyFor(language);
  if (task.allowedFiles.length === 0) add('scope', 'no allowedFiles: the mutation scope is unbounded');
  else if (!language) add('scope', 'allowed files must all be .go, or all be .js/.mjs/.cjs (mixed or other file types are not delegated)');
  if (task.allowedFiles.length > policy.maxAllowedFiles) add('scope', `${task.allowedFiles.length} allowed files exceeds the limit of ${policy.maxAllowedFiles}`);

  const ancestorDirs = new Set([...ctx.ancestorFiles].flatMap(parentDirs));
  for (const file of task.allowedFiles) {
    if (!policy.allowedExtensions.includes(extname(file))) add('scope', `${file}: extension not in ${policy.allowedExtensions.join(', ')}`);
    if (TEST_FILE.test(file)) add('scope', `${file}: test files are the oracle and can never be worker-editable`);
    if (/(^|\/)(\.git|node_modules)(\/|$)/.test(file) || basename(file).startsWith('.applypatch-')) add('scope', `${file}: protected path`);
    const info = await lstat(join(ctx.repoRoot, file)).catch(() => undefined);
    if (info?.isSymbolicLink()) add('scope', `${file}: symlinks are not allowed`);
    if (!info && !ctx.ancestorFiles.has(file)) {
      const parent = dirname(file);
      if (parent !== '.' && !(await isDirectory(join(ctx.repoRoot, parent))) && !ancestorDirs.has(parent)) add('scope', `${file}: does not exist and neither does its directory (and no earlier task creates it)`);
    }
  }
  for (const file of task.contextFiles) {
    if (!(await lstat(join(ctx.repoRoot, file)).catch(() => undefined)) && !ctx.ancestorFiles.has(file)) add('scope', `context file ${file} does not exist (and no earlier task creates it)`);
  }

  if (task.acceptanceCriteria.length === 0) add('criteria', 'no acceptance criteria');
  if (task.constraints.length === 0) add('criteria', 'no constraints');
  if (!task.constraints.some((c) => /test/i.test(c) && /immutable|must not|do not|never/i.test(c))) add('criteria', 'constraints must state that tests are immutable');

  // verification must be one the runtime will run
  if (task.verificationCommands.length === 0) add('verification', 'no verification commands: nothing mechanical decides PASS');
  const oracle = { ...Object.fromEntries([...ctx.ancestorFiles].map((f) => [f, ''])), ...task.hiddenFiles };
  for (const command of task.verificationCommands) {
    if (!policy.allowedVerificationBinaries.includes(command[0])) add('verification', `verification binary "${command[0]}" is not allow-listed (allowed: ${policy.allowedVerificationBinaries.join(', ')})`);
    else if (language === 'js') {
      // a test file an earlier task creates is acceptable here; the runtime re-checks against the real worktree at claim time
      for (const message of await validateJsVerification(command, { taskId: task.id, objective: task.title, allowedFiles: task.allowedFiles, contextFiles: [], acceptanceCriteria: [], verificationCommands: [command], constraints: [], hiddenFiles: oracle }, ctx.repoRoot)) add('verification', message);
    }
  }
  return reasons;
}

// ---- verification commands for tasks the runtime does not sandbox -----------------------------------------------------

const FORBIDDEN_BINARIES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'sudo', 'su', 'doas', 'curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'rsync', 'eval', 'exec', 'rm', 'dd', 'mkfs', 'chmod', 'chown']);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse']);
const NPM_SCRIPT_COMMANDS = new Set(['test', 'run', 'run-script']);

/**
 * Policy for any verification command in a plan, whoever runs it: an argv array naming a bare binary, never a shell,
 * network fetcher, privilege escalation or a git command that writes. (Worker tasks are held to the stricter
 * allow-list in workerIneligibility on top of this.)
 */
export function unsafeCommandReasons(command: string[]): string[] {
  const [binary, sub] = command;
  const label = command.join(' ');
  const reasons: string[] = [];
  if (!binary) return ['empty command'];
  if (command.some((a) => a.includes('\0'))) reasons.push(`"${label}": arguments may not contain NUL`);
  if (binary.includes('/') || binary.includes('\\')) reasons.push(`"${label}": the binary must be a bare name resolved from PATH, not a path`);
  if (FORBIDDEN_BINARIES.has(basename(binary))) reasons.push(`"${label}": binary "${binary}" is not permitted in a plan (shell, network, privilege or destructive tool)`);
  if (binary === 'git' && !READ_ONLY_GIT.has(sub ?? '')) reasons.push(`"${label}": only read-only git commands (${[...READ_ONLY_GIT].join(', ')}) are permitted; plans never push or mutate history`);
  if (binary === 'npx' && sub !== '--no-install') reasons.push(`"${label}": npx must be invoked as "npx --no-install" (no network installs)`);
  if (binary === 'npm' && !NPM_SCRIPT_COMMANDS.has(sub ?? '')) reasons.push(`"${label}": npm may only run "test" or a package script (no install or publish)`);
  return reasons;
}

/** Batch integrationCommands run in the integration worktree; the integrator allow-lists go, gofmt and validated jest. */
export async function integrationCommandReasons(command: string[], repoRoot: string, ancestorFiles: ReadonlySet<string>): Promise<string[]> {
  const reasons = unsafeCommandReasons(command);
  if (!['go', 'gofmt', 'npx'].includes(command[0])) reasons.push(`"${command.join(' ')}": integration commands may only use go, gofmt or npx --no-install jest`);
  else if (command[0] === 'npx') {
    const oracle = Object.fromEntries([...ancestorFiles].map((f) => [f, '']));
    reasons.push(...(await validateJsVerification(command, { taskId: 'integration', objective: 'integration', allowedFiles: [], contextFiles: [], acceptanceCriteria: [], verificationCommands: [command], constraints: [], hiddenFiles: oracle }, repoRoot)));
  }
  return reasons;
}

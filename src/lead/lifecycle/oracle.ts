import { copyFile, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { redact } from '../../runtime/execution/coding-task-trace.ts';
import type { CommandRunner } from '../../runtime/integration/integrate.ts';
import type { SchedulerStore, TaskRow } from '../../runtime/scheduler/store.ts';
import { baseRefName, type WorktreeManager } from '../../runtime/worktree/worktree.ts';
import { canonicalJson, commandPolicyProblems, exportCommit, isInconclusive, linkDependencyPaths, sha256 } from './exec.ts';
import { LifecycleError, type LifecycleRow, type LifecycleStore, type OracleNegativeControl, type PinnedOracle } from './store.ts';

/**
 * The objective-level acceptance oracle: an independent judge of the INTEGRATED result, not of any single task.
 *
 *  - It is pinned (every file hashed, commands and negative-control mode fixed) BEFORE the first worker claim, and the pin is
 *    refused once any task of the batch has been claimed.
 *  - It lives outside everything a worker or reviewer can reach: the repository, the worktrees, the artifact roots. The pin
 *    refuses a directory that overlaps any of them, and refuses files that escape the directory through a symlink.
 *  - Nothing the lifecycle does writes to it. Acceptance re-hashes it first; any difference stops with ESCALATED and runs nothing.
 *  - It runs against a throwaway export of a commit (`git archive`: no .git, nothing a worker could have left behind) with the
 *    oracle files copied in, under the OS sandbox, once on the integration tip and once on the batch base (negative control).
 *  - ACCEPTED requires the tip to pass AND, when applicable, the base to FAIL for a real reason (an exit code, not a timeout).
 */

export interface OracleSpecInput {
  /** Absolute directory holding the oracle files. */
  dir: string;
  /** Files inside `dir` (relative paths) that are copied into the exported tree at the same relative path. */
  files: string[];
  /** argv commands run in the exported tree, in order; the first failing one decides. */
  commands: string[][];
  negativeControl?: OracleNegativeControl;
}

export interface PinOracleDeps {
  store: SchedulerStore;
  lifecycle: LifecycleStore;
  worktrees: WorktreeManager;
  /** Directories workers/reviewers can write or read (artifact roots...) in addition to the repository and the worktrees. */
  forbiddenRoots?: string[];
}

const overlaps = (a: string, b: string): boolean => {
  const rel = relative(a, b);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  const rel2 = relative(b, a);
  return inside || rel2 === '' || (!rel2.startsWith('..') && !isAbsolute(rel2));
};

async function realOrResolved(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

export function specHashOf(oracle: Pick<PinnedOracle, 'files' | 'commands' | 'negativeControl'>): string {
  return sha256(canonicalJson({ files: oracle.files, commands: oracle.commands, negativeControl: oracle.negativeControl }));
}

async function hashFiles(dir: string, files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of files) {
    if (!f || isAbsolute(f) || f.split('/').includes('..')) throw new LifecycleError('invalid', `oracle file "${f}" must be a relative path without ..`);
    const real = await realpath(join(dir, f)).catch(() => undefined);
    if (!real) throw new LifecycleError('invalid', `oracle file ${f} does not exist in ${dir}`);
    if (relative(dir, real).startsWith('..')) throw new LifecycleError('invalid', `oracle file ${f} resolves outside ${dir} (symlink escape)`);
    if (!(await stat(real)).isFile()) throw new LifecycleError('invalid', `oracle file ${f} is not a regular file`);
    out[f] = sha256(await readFile(real));
  }
  return out;
}

/** Pins the oracle for an objective's batch and registers the lifecycle (phase PINNED). Must happen before any worker runs. */
export async function pinOracle(deps: PinOracleDeps, input: { objectiveId: string; batchId: string; spec: OracleSpecInput; actor: string }): Promise<LifecycleRow> {
  const { store, worktrees } = deps;
  const batch = store.getBatch(input.batchId);
  if (!batch) throw new LifecycleError('not_found', `batch ${input.batchId} not found`);
  const claimed = store.listTasks({ batchId: input.batchId }).filter((t) => t.claims > 0 || !['BACKLOG', 'READY', 'BLOCKED'].includes(t.state));
  if (claimed.length > 0) throw new LifecycleError('invalid', `oracle_pin_too_late: the oracle must be pinned before any worker runs; ${claimed.map((t) => `${t.id} (${t.state})`).join(', ')} already started`);

  const { spec } = input;
  if (!isAbsolute(spec.dir)) throw new LifecycleError('invalid', 'the oracle directory must be an absolute path');
  const dir = await realpath(spec.dir).catch(() => undefined);
  if (!dir || !(await stat(dir)).isDirectory()) throw new LifecycleError('invalid', `oracle directory ${spec.dir} does not exist`);
  const protectedRoots = [batch.repository, worktrees.root, ...(deps.forbiddenRoots ?? [])];
  for (const root of protectedRoots) {
    if (overlaps(dir, await realOrResolved(root))) throw new LifecycleError('invalid', `oracle_not_isolated: ${dir} overlaps ${root}, which workers can reach; keep the oracle outside the repository, the worktrees and the artifact roots`);
  }
  if (spec.files.length === 0) throw new LifecycleError('invalid', 'an oracle needs at least one file');
  if (spec.commands.length === 0) throw new LifecycleError('invalid', 'an oracle needs at least one command');
  for (const c of spec.commands) {
    const problems = commandPolicyProblems(c);
    if (problems.length > 0) throw new LifecycleError('invalid', `oracle command "${c.join(' ')}" refused: ${problems.join('; ')}`);
  }
  const negativeControl: OracleNegativeControl = spec.negativeControl ?? { mode: 'required' };
  if (negativeControl.mode === 'not_applicable' && !negativeControl.reason.trim()) throw new LifecycleError('invalid', 'a negative control that is not applicable needs a reason');

  const files = await hashFiles(dir, spec.files);
  const base = await worktrees.withRepoLock(batch.repository, () => worktrees.ensureIntegrationBranch(batch)); // fixes refs/lead/base/<batch> now: the control runs against exactly this
  const partial = { files, commands: spec.commands, negativeControl };
  const oracle: PinnedOracle = { dir, ...partial, specHash: specHashOf(partial), pinnedAt: store.now(), pinnedBy: input.actor };
  return deps.lifecycle.create({ objectiveId: input.objectiveId, batchId: input.batchId, oracle, baseCommit: base.baseCommit, actor: input.actor });
}

/** Re-hashes the pinned files. `ok` is false if anything was edited, replaced or removed since the pin. */
export async function verifyPinnedOracle(oracle: PinnedOracle): Promise<{ ok: boolean; mismatches: { file: string; pinned: string; now: string }[] }> {
  const mismatches: { file: string; pinned: string; now: string }[] = [];
  for (const [file, pinned] of Object.entries(oracle.files)) {
    const now = await readFile(join(oracle.dir, file)).then(sha256, () => '(missing)');
    if (now !== pinned) mismatches.push({ file, pinned, now });
  }
  return { ok: mismatches.length === 0, mismatches };
}

export interface CommandEvidence {
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** sha256 of the complete output; `outputTail` is its redacted last part. */
  outputSha256: string;
  outputTail: string;
}

export interface OracleRun {
  label: 'candidate' | 'negative_control';
  commit: string;
  treeId: string;
  startedAt: number;
  durationMs: number;
  commands: CommandEvidence[];
  /** Every executed command exited 0 and all commands ran. */
  passed: boolean;
  /** No executed command was inconclusive (never started, timed out, sandbox unavailable). */
  conclusive: boolean;
  evidenceHash: string;
}

export interface AcceptanceRecord {
  objectiveId: string;
  batchId: string;
  verdict: 'ACCEPTED' | 'NOT_ACCEPTED' | 'ESCALATED';
  /** Machine-readable cause: accepted | oracle_failed | negative_control_passed | negative_control_inconclusive | oracle_inconclusive | oracle_tampered | oracle_path_occupied | oracle_pinned_late | integration_provenance_broken. */
  reason: string;
  detail: string;
  oracle: { specHash: string; files: Record<string, string>; unchanged: boolean; mismatches: { file: string; pinned: string; now: string }[]; pinnedAt: number; pinnedBeforeFirstClaim: boolean };
  integration: { branch: string; tip: string; baseCommit: string; tasks: { taskId: string; implementedBy: string | null; workerHead: string | null; integratedCommit: string | null; runIds: string[] }[] };
  candidate: OracleRun | null;
  negativeControl: OracleRun | { skipped: string } | null;
  decidedAt: number;
  evidenceHash: string;
}

export interface AcceptanceDeps {
  store: SchedulerStore;
  lifecycle: LifecycleStore;
  worktrees: WorktreeManager;
  /** Runs one argv in a directory. Production: the sandbox runner. */
  run: CommandRunner;
}

/** The tasks that must be DONE for the objective: the plan's tasks, each followed through any correction that replaced it. */
export function requiredTasks(store: SchedulerStore, batchId: string): TaskRow[] {
  const originals = store.listTasks({ batchId }).filter((t) => t.correctionOf === null);
  return originals.map((t) => store.resolveDependency(t.id) ?? t);
}

async function runOracleOn(deps: AcceptanceDeps, oracle: PinnedOracle, batch: { repository: string; linkPaths: string[] }, commit: string, label: OracleRun['label']): Promise<{ run: OracleRun } | { occupied: string }> {
  const repository = batch.repository;
  const treeId = (await deps.worktrees.git(repository, ['rev-parse', `${commit}^{tree}`])).stdout.trim();
  const exported = await exportCommit(repository, commit, 'agentic-oracle-');
  const startedAt = Date.now();
  try {
    for (const file of Object.keys(oracle.files)) {
      const target = join(exported.tree, file);
      if (existsSync(target)) return { occupied: file }; // a worker-created file at the oracle's path: refuse, never silently overwrite
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(oracle.dir, file), target);
      const copied = sha256(await readFile(target));
      if (copied !== oracle.files[file]) return { occupied: `${file} (changed while being copied)` };
    }
    await linkDependencyPaths(repository, exported.tree, batch.linkPaths);
    const commands: CommandEvidence[] = [];
    let passed = true;
    for (const command of oracle.commands) {
      const started = Date.now();
      const r = await deps.run(command, exported.tree);
      commands.push({ command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: Date.now() - started, outputSha256: sha256(r.output), outputTail: redact(r.output.trim().slice(-1500)) });
      if (r.exitCode !== 0) {
        passed = false;
        break;
      }
    }
    const body = { label, commit, treeId, startedAt, durationMs: Date.now() - startedAt, commands, passed, conclusive: !commands.some(isInconclusive) };
    return { run: { ...body, evidenceHash: sha256(canonicalJson(body)) } };
  } finally {
    await exported.dispose();
  }
}

/**
 * Runs the pinned oracle against the integrated result and decides the objective's verdict. It RECORDS nothing in the
 * lifecycle: the caller commits the phase change (conditionally), so a cancellation that lands while the oracle runs is
 * respected and the result is kept as late evidence instead of becoming a verdict.
 */
export async function runAcceptance(deps: AcceptanceDeps, objectiveId: string): Promise<AcceptanceRecord> {
  const { store, lifecycle, worktrees } = deps;
  const lc = lifecycle.require(objectiveId);
  const batch = store.getBatch(lc.batchId);
  if (!batch) throw new LifecycleError('not_found', `batch ${lc.batchId} not found`);
  const oracle = lc.oracle;
  const required = requiredTasks(store, lc.batchId);
  const notDone = required.filter((t) => t.state !== 'DONE');
  if (notDone.length > 0) throw new LifecycleError('invalid', `acceptance needs every required task DONE; not done: ${notDone.map((t) => `${t.id} (${t.state})`).join(', ')}`);

  const tip = await worktrees.integrationTip(batch);
  const integrationBranch = `lead-integration/${batch.id}`;
  const firstClaim = store.events().filter((e) => e.to === 'CLAIMED' && store.getTask(e.taskId)?.batchId === lc.batchId).reduce<number | null>((min, e) => (min === null || e.at < min ? e.at : min), null);
  const pinnedBeforeFirstClaim = firstClaim === null || oracle.pinnedAt <= firstClaim;
  const tasks: AcceptanceRecord['integration']['tasks'] = required.map((t) => {
    const integ = t.artifacts.integration as { integratedCommit?: string } | undefined;
    const direct = t.artifacts.claudeDirect as { commit?: string } | undefined;
    return { taskId: t.id, implementedBy: t.implementedBy, workerHead: t.headCommit, integratedCommit: integ?.integratedCommit ?? direct?.commit ?? null, runIds: t.runIds };
  });
  const integrationBase = (await worktrees.git(batch.repository, ['rev-parse', '--verify', baseRefName(batch.id)])).stdout.trim() || lc.baseCommit;

  const finish = (verdict: AcceptanceRecord['verdict'], reason: string, detail: string, extra: Partial<Pick<AcceptanceRecord, 'candidate' | 'negativeControl'>> & { check: Awaited<ReturnType<typeof verifyPinnedOracle>> }): AcceptanceRecord => {
    const body = {
      objectiveId,
      batchId: lc.batchId,
      verdict,
      reason,
      detail,
      oracle: { specHash: oracle.specHash, files: oracle.files, unchanged: extra.check.ok, mismatches: extra.check.mismatches, pinnedAt: oracle.pinnedAt, pinnedBeforeFirstClaim },
      integration: { branch: integrationBranch, tip, baseCommit: integrationBase, tasks },
      candidate: extra.candidate ?? null,
      negativeControl: extra.negativeControl ?? null,
      decidedAt: store.now(),
    };
    return { ...body, evidenceHash: sha256(canonicalJson(body)) };
  };

  // 1. integrity first: nothing runs against an oracle that is not exactly the pinned one
  const check = await verifyPinnedOracle(oracle);
  if (!check.ok) return finish('ESCALATED', 'oracle_tampered', `oracle files changed since the pin: ${check.mismatches.map((m) => m.file).join(', ')}; nothing was run`, { check });
  if (!pinnedBeforeFirstClaim) return finish('ESCALATED', 'oracle_pinned_late', `the oracle was pinned at ${oracle.pinnedAt}, after the first worker claim at ${firstClaim}`, { check });

  // 2. provenance: every required task's integrated commit must really be on the integration branch
  for (const t of tasks) {
    const ok = t.integratedCommit && (await worktrees.git(batch.repository, ['merge-base', '--is-ancestor', t.integratedCommit, tip])).success;
    if (!ok) return finish('ESCALATED', 'integration_provenance_broken', `task ${t.taskId}: integrated commit ${t.integratedCommit ?? '(none recorded)'} is not an ancestor of the integration tip ${tip.slice(0, 10)}`, { check });
  }

  // 3. the candidate, then the negative control (always run for evidence; judged below)
  const cand = await runOracleOn(deps, oracle, batch, tip, 'candidate');
  if ('occupied' in cand) return finish('ESCALATED', 'oracle_path_occupied', `the integrated tree already contains ${cand.occupied}, a path the oracle owns`, { check });
  let neg: AcceptanceRecord['negativeControl'];
  if (oracle.negativeControl.mode === 'required') {
    const n = await runOracleOn(deps, oracle, batch, integrationBase, 'negative_control');
    if ('occupied' in n) return finish('ESCALATED', 'oracle_path_occupied', `the batch base already contains ${n.occupied}, a path the oracle owns`, { check, candidate: cand.run });
    neg = n.run;
  } else {
    neg = { skipped: oracle.negativeControl.reason };
  }

  const c = cand.run;
  const negRun = neg && 'commands' in neg ? neg : null;
  if (!c.conclusive) return finish('ESCALATED', 'oracle_inconclusive', 'the oracle could not give a verdict on the integrated tree (a command did not start or timed out)', { check, candidate: c, negativeControl: neg });
  if (!c.passed) return finish('NOT_ACCEPTED', 'oracle_failed', `the oracle fails on the integrated tree: ${c.commands.at(-1)!.command.join(' ')} -> exit ${c.commands.at(-1)!.exitCode}`, { check, candidate: c, negativeControl: neg });
  if (negRun && !negRun.conclusive) return finish('NOT_ACCEPTED', 'negative_control_inconclusive', 'the oracle passed, but its negative control could not be judged (a command did not start or timed out), so the pass proves nothing', { check, candidate: c, negativeControl: neg });
  if (negRun && negRun.passed) return finish('NOT_ACCEPTED', 'negative_control_passed', 'the oracle also passes on the untouched batch base: it does not discriminate, so its pass proves nothing', { check, candidate: c, negativeControl: neg });
  return finish('ACCEPTED', 'accepted', negRun ? `oracle passes on ${tip.slice(0, 10)} and fails on the base ${integrationBase.slice(0, 10)}` : `oracle passes on ${tip.slice(0, 10)}; negative control not applicable`, { check, candidate: c, negativeControl: neg });
}

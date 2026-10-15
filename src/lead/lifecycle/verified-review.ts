import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { redact } from '../../runtime/execution/coding-task-trace.ts';
import { scrubForWorker } from '../../runtime/execution/worker-feedback.ts';
import type { CommandRunner } from '../../runtime/integration/integrate.ts';
import { ENGINEERING_CONTEXT_ARTIFACT } from '../../runtime/execution/coding-task-artifacts.ts';
import { denyAllApprovals, type ApprovalVerifier, type VerifiedApproval } from '../../runtime/execution/design-approval.ts';
import { expectedEngineeringContext, verifyEngineeringContext } from '../../runtime/execution/engineering-context.ts';
import { EngineeringKnowledgeCatalog, knowledgeLanguageForFiles, type KnowledgeSelection } from '../../runtime/knowledge/engineering-knowledge.ts';
import { capacityFindings, resolveCapacity, type ResolvedCapacity } from '../../runtime/execution/delegation-capacity.ts';
import { EvidenceError, addedLineSecurityFindings, parseNumstatZ, readGitEvidence } from '../../runtime/review/change-review.ts';
import type { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { ownedFilesOf } from '../../runtime/scheduler/types.ts';
import type { WorktreeManager } from '../../runtime/worktree/worktree.ts';
import { canonicalJson, commandPolicyProblems, exportCommit, isInconclusive, linkDependencyPaths, sha256 } from './exec.ts';
import type { CommandEvidence } from './oracle.ts';

/**
 * Verified review: the decision a reviewer takes on a task that reached REVIEW_PENDING, made from evidence the runtime
 * itself can re-derive, never from the worker's account of itself.
 *
 *   APPROVE          every check holds and an independent re-run of the task verifier on the exact reviewed commit passed.
 *   REPAIR_REQUIRED  the evidence is sound but the change is wrong or unacceptable in a way a correction can fix.
 *   ESCALATE         the evidence itself cannot be trusted or the situation is ambiguous (stale epoch, moved branch, missing
 *                    provenance, a verifier that gave no verdict, a security finding). A human decides; nothing is retried.
 *
 * The verdict maps onto the existing review decisions (APPROVED / REJECTED_WITH_FEEDBACK / ESCALATED_TO_HUMAN); there is no
 * parallel review state. This module only reads and runs; it writes nothing to the scheduler or to the worker's worktree.
 */

export type ReviewVerdictKind = 'APPROVE' | 'REPAIR_REQUIRED' | 'ESCALATE';

export interface ReviewCheck {
  name: string;
  ok: boolean;
  /** What a failure of this check means: 'evidence' (untrustworthy/ambiguous -> ESCALATE), 'correctable' (-> REPAIR_REQUIRED), 'info' (recorded only). */
  class: 'evidence' | 'correctable' | 'info';
  detail: string;
}

export interface ReviewEvidence {
  baseCommit: string | null;
  headCommit: string | null;
  branchTip: string | null;
  claimEpoch: number;
  /** The worker identity of the claim whose result this review is about (from the audit trail, not from the review request). */
  claimOwner: string | null;
  claimSeq: number | null;
  reviewPendingSeq: number | null;
  runId: string | null;
  runIds: string[];
  codingAttempts: number | null;
  artifactDir: string | null;
  /** sha256 of each worker artifact file that exists, so the evidence can be re-checked later. */
  artifactHashes: Record<string, string>;
  changedFiles: string[];
  diffSha256: string | null;
  /** Size of the complete base..head diff the hash and the checks below were computed from (never a truncated copy). */
  diffBytes: number | null;
  /** Added + deleted lines per changed file in the reviewed commit. */
  changedLines: Record<string, number>;
  /** The delegation capacity policy the commit was judged by, and whether it was the task's own or the default. */
  capacity: ResolvedCapacity;
  /** What the worker's run reported about its own verifier. Recorded, never relied on. */
  workerSelfReport: { command: string[]; exitCode: number | null } | null;
  /** The runtime's own re-run of the task verifier on the exported reviewed commit. */
  independentVerification: CommandEvidence[] | null;
}

export interface ReviewVerdict {
  verdict: ReviewVerdictKind;
  taskId: string;
  reviewId: number;
  round: number;
  checks: ReviewCheck[];
  /** Short machine-friendly causes of a non-APPROVE verdict. */
  reasons: string[];
  /** For REPAIR_REQUIRED: the bounded, redacted feedback handed to the correction task. */
  feedback: string | null;
  evidence: ReviewEvidence;
  verifiedAt: number;
  verdictHash: string;
}

export interface VerifiedReviewDeps {
  store: SchedulerStore;
  worktrees: WorktreeManager;
  /** Runs one argv in a directory (production: sandbox runner). */
  run: CommandRunner;
  /** Warn-level findings the reviewer accepts without a correction. Default: whitespace_reindent. */
  acknowledgeWarnings?: readonly string[];
  /** Re-verifies an attached approvedDesign against the runtime's approval records (default: deny all, so such a task escalates). */
  approvals?: ApprovalVerifier;
  /** Independently resolves task-pinned guidance from the trusted catalog. */
  knowledgeCatalog?: EngineeringKnowledgeCatalog;
}

const REPAIRABLE_WARNINGS = new Set(['comment_removed', 'too_large']);
const MAX_FEEDBACK_CHARS = 2000;

/** Text that becomes the correction task's prompt: redacted, control-stripped and scrubbed of host identity (worker-feedback.ts). */
const clean = (text: string): string => scrubForWorker(text);

async function declaredContextFingerprint(dir: string): Promise<string | undefined> {
  try {
    const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as { engineeringContextFingerprint?: unknown };
    return typeof result.engineeringContextFingerprint === 'string' ? result.engineeringContextFingerprint : undefined;
  } catch {
    return undefined;
  }
}

/** [ok, class, detail] for the recorded snapshot: it must verify against its own text, match result.json, and be what every attempt consumed. */
function contextIntegrity(raw: string, declared: string | undefined, expected: string | undefined): [boolean, ReviewCheck['class'], string] {
  let snapshot: { fingerprint?: string; manifestHash?: string; text?: string; attemptFingerprints?: { attempt: number; fingerprint: string | null }[] };
  try {
    snapshot = JSON.parse(raw);
  } catch {
    return [false, 'evidence', `${ENGINEERING_CONTEXT_ARTIFACT} is not valid JSON`];
  }
  const verified = verifyEngineeringContext({ fingerprint: String(snapshot.fingerprint), manifestHash: String(snapshot.manifestHash), text: String(snapshot.text) });
  if (!verified.ok) return [false, 'evidence', verified.reason];
  if (declared !== snapshot.fingerprint) return [false, 'evidence', `result.json declares ${String(declared)} but the snapshot is ${snapshot.fingerprint}`];
  if (expected === undefined) return [false, 'evidence', 'the worker recorded an engineering context but the task contract has none to compare it with'];
  if (expected !== snapshot.fingerprint) return [false, 'evidence', `the worker consumed context ${snapshot.fingerprint}, not the one the task contract pins (${expected})`];
  const stray = (snapshot.attemptFingerprints ?? []).filter((a) => a.fingerprint !== snapshot.fingerprint);
  if (stray.length > 0) return [false, 'evidence', `attempt(s) ${stray.map((a) => a.attempt).join(', ')} did not consume the pinned context`];
  return [true, 'info', `engineering context ${snapshot.fingerprint} matches the task contract and was consumed by ${(snapshot.attemptFingerprints ?? []).length} attempt(s)`];
}

export async function verifyReview(deps: VerifiedReviewDeps, taskId: string): Promise<ReviewVerdict> {
  const { store, worktrees } = deps;
  const task = store.requireTask(taskId);
  if (task.state !== 'REVIEW_PENDING') throw new Error(`task ${taskId} is ${task.state}, not REVIEW_PENDING`);
  const review = store.latestReview(taskId);
  if (!review || review.decision) throw new Error(`task ${taskId} has no undecided review`);
  const batch = store.getBatch(task.batchId);
  if (!batch) throw new Error(`batch ${task.batchId} not found`);
  const req = review.request as Record<string, any>;
  const acknowledged = new Set(deps.acknowledgeWarnings ?? ['whitespace_reindent']);

  const checks: ReviewCheck[] = [];
  const add = (name: string, ok: boolean, cls: ReviewCheck['class'], detail: string) => checks.push({ name, ok, class: cls, detail });
  const git = (args: string[]) => worktrees.git(batch.repository, args);

  const evidence: ReviewEvidence = {
    baseCommit: task.baseCommit,
    headCommit: task.headCommit,
    branchTip: null,
    claimEpoch: task.claimEpoch,
    claimOwner: null,
    claimSeq: null,
    reviewPendingSeq: null,
    runId: typeof req.runId === 'string' ? req.runId : null,
    runIds: task.runIds,
    codingAttempts: typeof req.codingAttempts === 'number' ? req.codingAttempts : null,
    artifactDir: typeof task.artifacts.artifactDir === 'string' ? task.artifacts.artifactDir : null,
    artifactHashes: {},
    changedFiles: [],
    diffSha256: null,
    diffBytes: null,
    changedLines: {},
    capacity: resolveCapacity(task.spec.capacity),
    workerSelfReport: req.verifier ? { command: req.verifier.command, exitCode: req.verifier.exitCode } : null,
    independentVerification: null,
  };

  // ---- provenance: is this review really about the result of the current claim? --------------------------------------
  const requestMatches = req.taskId === task.id && Boolean(task.headCommit) && req.headCommit === task.headCommit && req.baseCommit === task.baseCommit;
  add('review_request_matches_task', requestMatches, 'evidence', requestMatches ? `review #${review.id} names ${task.headCommit!.slice(0, 10)}` : `review request (${String(req.taskId)}, ${String(req.headCommit)}) does not match the task row (${task.id}, ${String(task.headCommit)})`);

  const events = store.events(taskId);
  const reviewPending = [...events].reverse().find((e) => e.to === 'REVIEW_PENDING' && e.from === 'VERIFYING');
  const claim = reviewPending ? [...events].reverse().find((e) => e.to === 'CLAIMED' && e.seq < reviewPending.seq) : undefined;
  evidence.reviewPendingSeq = reviewPending?.seq ?? null;
  evidence.claimSeq = claim?.seq ?? null;
  evidence.claimOwner = claim?.actor ?? null;
  const claimEpoch = (claim?.detail as { epoch?: number } | null)?.epoch;
  const fenceOk = Boolean(reviewPending && claim && claimEpoch === task.claimEpoch && reviewPending.actor === claim.actor);
  add(
    'epoch_and_lease_evidence',
    fenceOk,
    'evidence',
    fenceOk
      ? `result written by ${claim!.actor} under claim epoch ${claimEpoch}, the task's current epoch`
      : `the audit trail does not show REVIEW_PENDING written by the owner of the current claim epoch ${task.claimEpoch} (claim epoch ${String(claimEpoch)}, claim owner ${claim?.actor ?? 'none'}, result written by ${reviewPending?.actor ?? 'none'}): a stale or forged result`,
  );

  const runIdOk = Boolean(evidence.runId) && task.runIds.includes(evidence.runId!);
  add('run_identity', runIdOk, 'evidence', runIdOk ? `workflow run ${evidence.runId} is recorded on the task` : `the review names run ${String(evidence.runId)}, which is not among the task's recorded runs (${task.runIds.join(', ') || 'none'})`);

  // The reviewer verifies the design approval itself, independently of whatever the worker run recorded. A design that was
  // revoked, superseded, altered or never approved since the run is evidence the review cannot rest on.
  const designContract = task.spec.request?.contract;
  let verifiedApproval: VerifiedApproval | undefined;
  if (designContract?.approvedDesign) {
    const verdict = (deps.approvals ?? denyAllApprovals)({ approvalRef: designContract.approvedDesign.approvalRef, design: designContract.approvedDesign, taskId: designContract.taskId, allowedFiles: designContract.allowedFiles });
    if (verdict.ok) verifiedApproval = verdict.approval;
    add('design_approval', verdict.ok, 'evidence', verdict.ok ? `design approval ${verdict.approval.approvalId} (revision ${verdict.approval.revision}) verified: approved by ${verdict.approval.role} ${verdict.approval.approverId} under grant ${verdict.approval.grantId}` : `the attached design is not verifiably approved (${verdict.code}): ${verdict.reason}`);
  }

  if (evidence.artifactDir) {
    const dir = evidence.artifactDir;
    if (!existsSync(dir)) {
      add('worker_artifacts', false, 'evidence', `artifact directory ${dir} is recorded but missing`);
    } else {
      for (const name of ['contract.json', 'attempts.json', 'result.json', 'final.diff', ENGINEERING_CONTEXT_ARTIFACT]) {
        const buf = await readFile(join(dir, name)).catch(() => undefined);
        if (buf) evidence.artifactHashes[name] = sha256(buf);
      }
      let contradicts = '';
      if (evidence.artifactHashes['result.json']) {
        try {
          const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as { status?: string };
          if (result.status && result.status !== 'PASS') contradicts = `result.json says ${result.status}`;
        } catch {
          contradicts = 'result.json is not valid JSON';
        }
      }
      add('worker_artifacts', contradicts === '', 'evidence', contradicts || `${Object.keys(evidence.artifactHashes).length} artifact file(s) hashed in ${dir}`);

      // The pinned engineering context the worker consumed: self-consistent, and the same one result.json and every attempt name.
      // The expected fingerprint is recomputed from the task contract the scheduler persisted, never from the worker's own artifacts.
      // Curated knowledge the task pinned: recomputed here from the runtime's own catalog, never from the worker's artifacts.
      // A task that pinned knowledge can only be reviewed if that exact selection still resolves to the pinned digest.
      const pinned = task.spec.request?.contract.knowledge;
      let selection: KnowledgeSelection | undefined;
      if (pinned) {
        let detail: string;
        try {
          const lang = knowledgeLanguageForFiles(task.spec.request!.contract.allowedFiles);
          if (!lang) throw new Error('implementation language is unknown or mixed');
          if (!deps.knowledgeCatalog) throw new Error('no trusted runtime catalog is configured for review');
          const resolved = deps.knowledgeCatalog.resolve({ language: lang, ids: pinned.ids });
          if (resolved.omitted.length) throw new Error('the selection exceeds the context budget');
          if (resolved.digest !== pinned.selectionDigest) throw new Error(`selection digest ${resolved.digest.slice(0, 12)} differs from the pinned ${pinned.selectionDigest.slice(0, 12)} (an entry was changed, replaced or revoked)`);
          selection = resolved;
          detail = `${resolved.entries.length} pinned knowledge entr${resolved.entries.length === 1 ? 'y' : 'ies'} recomputed to ${resolved.digest.slice(0, 12)}`;
        } catch (err) {
          detail = `the pinned knowledge cannot be re-resolved: ${(err as Error).message}`;
        }
        add('knowledge_selection', selection !== undefined, 'evidence', detail);
      }
      const expected = pinned && !selection ? undefined : expectedEngineeringContext(task.spec.request?.contract, verifiedApproval, selection);
      const declared = await declaredContextFingerprint(dir);
      const snapshotRaw = await readFile(join(dir, ENGINEERING_CONTEXT_ARTIFACT), 'utf8').catch(() => undefined);
      if (snapshotRaw === undefined) {
        const required = declared !== undefined || Boolean(task.spec.request?.contract.approvedDesign) || Boolean(pinned);
        add('engineering_context', !required, 'evidence', !required ? 'no engineering context was recorded for this run (legacy task with no attached design)' : `the run was given a design (result.json declares ${declared ?? 'none'}) but ${ENGINEERING_CONTEXT_ARTIFACT} is missing`);
      } else {
        add('engineering_context', ...contextIntegrity(snapshotRaw, declared, expected?.fingerprint));
      }
    }
  } else {
    add('worker_artifacts', true, 'info', 'no artifact directory recorded for this run (the review request and the audit trail are the provenance)');
  }

  // ---- the commit itself ---------------------------------------------------------------------------------------------
  const branch = task.branch;
  const tip = branch ? (await git(['rev-parse', '--verify', `refs/heads/${branch}`])).stdout.trim() : '';
  evidence.branchTip = tip || null;
  add('reviewed_commit_is_branch_tip', Boolean(tip) && tip === task.headCommit, 'evidence', tip === task.headCommit ? `${branch} is at the reviewed commit` : `${branch ?? '(no branch)'} is at ${tip || 'nothing'}, not at the reviewed ${String(task.headCommit)}`);

  const base = task.baseCommit ?? '';
  const head = task.headCommit ?? '';
  let changed: string[] = [];
  let evidenceComplete = false;
  if (base && head) {
    const lineage = (await git(['merge-base', '--is-ancestor', base, head])).success && head !== base;
    add('commit_lineage', lineage, 'evidence', lineage ? 'the reviewed commit descends from the task base' : `${head.slice(0, 10)} does not descend from the task base ${base.slice(0, 10)}`);
    // The complete change set and diff, or no verdict on them: readGitEvidence refuses truncated, failed or timed-out output.
    // --no-renames: a rename record names only the destination, which would hide a deleted source path from the scope check.
    try {
      const repo = batch.repository;
      changed = (await readGitEvidence(repo, ['diff', '--no-renames', '--name-only', '-z', base, head])).stdout.split('\0').filter(Boolean);
      const diff = (await readGitEvidence(repo, ['diff', '--no-renames', base, head])).stdout;
      const lines = parseNumstatZ((await readGitEvidence(repo, ['diff', '--no-renames', '--numstat', '-z', base, head])).stdout);
      evidence.changedFiles = changed;
      evidence.diffSha256 = sha256(diff);
      evidence.diffBytes = Buffer.byteLength(diff);
      evidence.changedLines = Object.fromEntries(lines);
      evidenceComplete = true;
      add('complete_evidence', true, 'evidence', `complete diff of ${changed.length} file(s), ${evidence.diffBytes} bytes, read without truncation`);

      // Re-derived from the complete committed diff, independently of the findings recorded at PASS time.
      const security = addedLineSecurityFindings('reviewed commit', diff).filter((f) => f.severity === 'block');
      add('committed_diff_security', security.length === 0, 'evidence', security.length === 0 ? 'no blocked pattern on any added line of the complete diff' : security.map((f) => f.detail).join(' | ').slice(0, 1200));
      const hard = capacityFindings(lines, evidence.capacity).filter((f) => f.severity === 'block');
      add('delegation_capacity', hard.length === 0, 'evidence', hard.length === 0 ? `${[...lines.values()].reduce((a, b) => a + b, 0)} changed line(s) within maxChangedLinesPerTask ${evidence.capacity.maxChangedLinesPerTask} (${evidence.capacity.source} policy)` : hard.map((f) => f.detail).join(' | '));
    } catch (err) {
      if (!(err instanceof EvidenceError)) throw err;
      changed = [];
      add('complete_evidence', false, 'evidence', `the reviewed commit's change set could not be read completely: ${err.message}`);
    }
  } else {
    add('commit_lineage', false, 'evidence', 'the task has no recorded base or head commit');
  }

  // ---- allowed-file compliance, recomputed from the commit (not from the worker's report) ------------------------------
  const owned = ownedFilesOf(task.spec);
  const outside = changed.filter((f) => !owned.includes(f));
  add('allowed_files', evidenceComplete && changed.length > 0 && outside.length === 0, 'evidence', !evidenceComplete ? 'not judged: the change set is incomplete' : outside.length > 0 ? `the reviewed commit changes files outside the task's allowed files: ${outside.join(', ')}` : changed.length === 0 ? 'the reviewed commit changes nothing' : `only allowed files changed: ${changed.join(', ')}`);

  // ---- deterministic findings recorded at PASS time -----------------------------------------------------------------
  const findings = (Array.isArray(req.findings) ? req.findings : []) as { code: string; severity: string; detail: string }[];
  for (const f of findings) {
    if (f.severity === 'block') add(`finding:${f.code}`, false, 'evidence', `a blocking finding reached review: ${f.detail}`);
    else if (acknowledged.has(f.code)) add(`finding:${f.code}`, true, 'info', `acknowledged: ${f.detail}`);
    else if (REPAIRABLE_WARNINGS.has(f.code)) add(`finding:${f.code}`, false, 'correctable', f.detail);
    else add(`finding:${f.code}`, false, 'evidence', `unacknowledged ${f.code} finding needs a human: ${f.detail}`);
  }

  // ---- independent verification, only when the evidence it would verify is itself sound ------------------------------
  const contract = task.spec.request?.contract;
  if (!contract) {
    add('independent_verification', false, 'evidence', 'the task has no coding contract to verify against');
  } else if (checks.some((c) => !c.ok && c.class === 'evidence')) {
    add('independent_verification', false, 'info', 'skipped: the evidence above is already untrustworthy, so a verifier pass would prove nothing');
  } else {
    const refused = contract.verificationCommands.flatMap((c) => commandPolicyProblems(c).map((p) => `${c.join(' ')}: ${p}`));
    if (refused.length > 0) {
      add('independent_verification', false, 'evidence', `verification command refused by policy: ${refused.join('; ')}`);
    } else {
      const exported = await exportCommit(batch.repository, head, 'agentic-review-');
      try {
        await linkDependencyPaths(batch.repository, exported.tree, batch.linkPaths);
        const hidden = Object.entries(contract.hiddenFiles ?? {});
        const occupied = hidden.find(([path]) => existsSync(join(exported.tree, path)));
        if (occupied) {
          add('independent_verification', false, 'evidence', `the reviewed commit contains ${occupied[0]}, a path reserved for the runtime-owned test`);
        } else {
          for (const [path, content] of hidden) {
            await mkdir(dirname(join(exported.tree, path)), { recursive: true });
            await writeFile(join(exported.tree, path), content);
          }
          const results: CommandEvidence[] = [];
          for (const command of contract.verificationCommands) {
            const started = Date.now();
            const r = await deps.run(command, exported.tree);
            results.push({ command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: Date.now() - started, outputSha256: sha256(r.output), outputTail: redact(r.output.trim().slice(-1500)) });
            if (r.exitCode !== 0) break;
          }
          evidence.independentVerification = results;
          const last = results[results.length - 1];
          if (results.some(isInconclusive)) add('independent_verification', false, 'evidence', `the verifier gave no verdict: ${last.command.join(' ')} -> ${last.timedOut ? 'timed out' : 'did not run'}`);
          else if (last.exitCode !== 0) add('independent_verification', false, 'correctable', `$ ${last.command.join(' ')}\nexit code: ${last.exitCode}\n${clean(last.outputTail).slice(-800)}`);
          else add('independent_verification', true, 'evidence', `${results.length} verification command(s) passed on the exported reviewed commit`);
        }
      } finally {
        await exported.dispose();
      }
    }
  }
  add('worker_self_report', true, 'info', evidence.workerSelfReport ? `worker reported ${evidence.workerSelfReport.command.join(' ')} -> exit ${evidence.workerSelfReport.exitCode} (recorded, not relied on)` : 'the worker reported no verifier result');

  // ---- verdict ---------------------------------------------------------------------------------------------------
  const failedEvidence = checks.filter((c) => !c.ok && c.class === 'evidence');
  const failedCorrectable = checks.filter((c) => !c.ok && c.class === 'correctable');
  const verdict: ReviewVerdictKind = failedEvidence.length > 0 ? 'ESCALATE' : failedCorrectable.length > 0 ? 'REPAIR_REQUIRED' : 'APPROVE';
  const reasons = verdict === 'ESCALATE' ? failedEvidence.map((c) => c.name) : verdict === 'REPAIR_REQUIRED' ? failedCorrectable.map((c) => c.name) : [];
  const feedback = verdict === 'REPAIR_REQUIRED' ? clean(failedCorrectable.map((c) => `- ${c.name}: ${c.detail}`).join('\n')).slice(0, MAX_FEEDBACK_CHARS) : null;
  const body = { verdict, taskId, reviewId: review.id, round: review.round, checks, reasons, feedback, evidence, verifiedAt: store.now() };
  return { ...body, verdictHash: sha256(canonicalJson(body)) };
}

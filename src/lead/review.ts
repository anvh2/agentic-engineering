import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redact } from '../runtime/execution/coding-task-trace.ts';
import { denyAllApprovals, type ApprovalVerifier } from '../runtime/execution/design-approval.ts';
import { expectedEngineeringContext } from '../runtime/execution/engineering-context.ts';
import { describeCapacity, type ResolvedCapacity } from '../runtime/execution/delegation-capacity.ts';
import type { ReviewRow, SchedulerStore, TaskRow } from '../runtime/scheduler/store.ts';
import { taskSpecSchema, type SchedulerConfig, type TaskSpec } from '../runtime/scheduler/types.ts';

/**
 * Engineering Lead review queue. A runtime PASS only creates a review request; the decision is the Lead's, recorded
 * once, and it is the only way a task reaches APPROVED. No unattended Claude invocation exists here: review is an
 * explicit command (`lead review ...`) over persisted requests, optionally batched into one pack to save tokens.
 * Each task still gets its own decision.
 */

export const REVIEW_CHECKLIST = [
  'Functional correctness against every acceptance criterion',
  'Architecture / convention compatibility with the surrounding code',
  'Diff minimality: no unrelated changes, no whitespace-only edits',
  'EOF newline preserved',
  'Security (injection, secrets, unsafe I/O, new network or process access)',
  'Test coverage of the behavior (the oracle is runtime-owned; is it sufficient?)',
  'Maintainability and integration risk (conflicts with other pending tasks)',
] as const;

/** The design the worker was held to, shown only if the runtime verifies its approval, so reviewer and worker see the same text. */
function renderEngineeringContext(task: TaskRow, approvals: ApprovalVerifier): string[] {
  const contract = task.spec.request?.contract;
  const design = contract?.approvedDesign;
  if (!contract) return [];
  if (!design) return ['', '**Engineering context:** no HLD/LLD attached (legacy task, NOT approved).'];
  const verdict = approvals({ approvalRef: design.approvalRef, design, taskId: contract.taskId, allowedFiles: contract.allowedFiles });
  if (!verdict.ok) return ['', `**Engineering context:** the attached design is NOT verified as approved (${verdict.code}: ${verdict.reason}). Do not review against it; escalate.`];
  const context = expectedEngineeringContext(contract, verdict.approval);
  return [
    '',
    `**Engineering context** (fingerprint ${context?.fingerprint ?? 'n/a'}; approval ${verdict.approval.approvalId} revision ${verdict.approval.revision}, approved by ${verdict.approval.role} ${verdict.approval.approverId} under grant ${verdict.approval.grantId}). The worker prompt contained exactly this text; review against it and do not rewrite it:`,
    '', '_HLD_', design.hld, '', '_LLD_', design.lld, ...(design.adr?.length ? ['', '_ADR_', ...design.adr.map((a) => `- ${a}`)] : []),
  ];
}

export function pendingReviews(store: SchedulerStore): { review: ReviewRow; task: TaskRow }[] {
  return store
    .listReviews({ pendingOnly: true })
    .map((review) => ({ review, task: store.requireTask(review.taskId) }))
    .filter(({ task }) => task.state === 'REVIEW_PENDING');
}

/** One Markdown pack with every pending review (criteria, findings, verifier evidence, diff), for a single batched pass. */
export function renderReviewPack(store: SchedulerStore, taskIds?: string[], approvals: ApprovalVerifier = denyAllApprovals): string {
  const items = pendingReviews(store).filter(({ task }) => !taskIds || taskIds.includes(task.id));
  const out: string[] = [`# Review pack: ${items.length} task(s) awaiting the Engineering Lead`, '', 'Checklist applied to EVERY task:', ...REVIEW_CHECKLIST.map((c) => `- ${c}`), ''];
  for (const { review, task } of items) {
    const r = review.request;
    out.push(`## ${task.id}: ${task.title}  (review #${review.id}, round ${review.round})`, '');
    out.push(`- worker: ${task.assignedWorker}, coding attempts: ${r.codingAttempts}, mastra run: ${r.runId ?? 'n/a'}`);
    out.push(`- branch: ${r.branch} @ ${String(r.headCommit).slice(0, 10)} (base ${String(r.baseCommit).slice(0, 10)})`);
    out.push(`- verifier: ${r.verifier ? `${(r.verifier.command as string[]).join(' ')} -> exit ${r.verifier.exitCode}` : 'n/a'}`);
    if (r.capacity) out.push(`- delegation capacity: ${describeCapacity(r.capacity as ResolvedCapacity)}; changed lines: ${Object.entries((r.changedLines ?? {}) as Record<string, number>).map(([f, n]) => `${f} ${n}`).join(', ') || 'none'}`);
    if (r.feedbackAddressed) out.push(`- addresses earlier feedback: ${r.feedbackAddressed}`);
    out.push(...renderEngineeringContext(task, approvals));
    out.push('', `**Objective:** ${r.objective}`, '', '**Acceptance criteria:**', ...(r.acceptanceCriteria as string[]).map((c) => `- ${c}`), '');
    const findings = r.findings as { code: string; severity: string; detail: string }[];
    out.push(findings.length ? '**Deterministic findings (acknowledge each):**' : '**Deterministic findings:** none', ...findings.map((f) => `- [${f.severity}] ${f.code}: ${f.detail}`), '');
    out.push('```diff', String(r.diff).trimEnd(), '```', '');
  }
  return redact(out.join('\n'));
}

export async function writeReviewPack(store: SchedulerStore, path: string, taskIds?: string[]): Promise<{ path: string; tasks: number }> {
  const text = renderReviewPack(store, taskIds);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return { path, tasks: pendingReviews(store).filter(({ task }) => !taskIds || taskIds.includes(task.id)).length };
}

/** Builds the bounded correction task for a rejection: same contract and files, plus the reviewer's feedback made explicit. */
export function buildCorrectionSpec(task: TaskRow, feedback: string): TaskSpec {
  const n = task.corrections + 1;
  const root = task.id.replace(/-fix\d+$/, '');
  const id = `${root}-fix${n}`;
  const original = task.spec.request!;
  return taskSpecSchema.parse({
    ...task.spec,
    id,
    title: `${task.spec.title} (correction ${n})`,
    request: {
      ...original,
      contract: {
        ...original.contract,
        taskId: `${original.contract.taskId.replace(/-fix\d+$/, '')}-fix${n}`,
        objective: `${original.contract.objective}\n\nA previous implementation was REJECTED in review. Address this feedback exactly, change nothing else:\n${feedback}`,
        acceptanceCriteria: [...(original.contract.acceptanceCriteria ?? []), `Reviewer feedback is addressed: ${feedback}`],
      },
    },
  });
}

export function reviewDecision(
  store: SchedulerStore,
  config: Pick<SchedulerConfig, 'maxReviewCorrections'>,
  input: { taskId: string; decision: NonNullable<ReviewRow['decision']>; reviewer?: string; feedback?: string },
): { task: TaskRow; correctionId?: string } {
  const task = store.requireTask(input.taskId);
  const correctionSpec = input.decision === 'REJECTED_WITH_FEEDBACK' && input.feedback && task.spec.request ? buildCorrectionSpec(task, input.feedback) : undefined;
  const result = store.applyReviewDecision({
    taskId: input.taskId,
    decision: input.decision,
    reviewer: input.reviewer ?? 'claude-engineering-lead',
    feedback: input.feedback ?? null,
    maxCorrections: config.maxReviewCorrections,
    correctionSpec,
  });
  store.promote('review', { batchId: task.batchId });
  return result;
}

/** An escalated worker task the Lead decides to implement itself. The reason is recorded and counted in the metrics. */
export function takeOverEscalated(store: SchedulerStore, taskId: string, reason: string): TaskRow {
  if (!reason.trim()) throw new Error('taking a task over requires a recorded reason');
  const t = store.transition(taskId, 'READY', { actor: 'claude-engineering-lead', reason: `taken over by Claude: ${reason}`, expectFrom: 'ESCALATED', patch: { executor: 'claude', failureCategory: null } });
  store.setArtifacts(taskId, { claudeReason: reason, escalatedFrom: 'worker' });
  return t;
}

/** The Lead starts a Claude-kept task (READY -> CODING). Completion is `completeClaudeTask` in integrate.ts. */
export function startClaudeTask(store: SchedulerStore, taskId: string): TaskRow {
  const t = store.requireTask(taskId);
  if (t.executor !== 'claude') throw new Error(`task ${taskId} is a worker task`);
  return store.transition(taskId, 'CODING', { actor: 'claude-engineering-lead', reason: 'Claude implements directly', expectFrom: 'READY', patch: { assignedWorker: 'claude' } });
}

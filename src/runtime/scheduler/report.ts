import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import type { SchedulerStore, TaskRow } from './store.ts';
import { TASK_STATES } from './types.ts';
import type { WorktreeManager } from '../worktree/worktree.ts';

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const rate = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);

export interface Metrics {
  totalTasks: number;
  /** Planned for a local worker (spec.executor === 'worker'), correction tasks excluded. */
  eligibleTasks: number;
  claudeKeptTasks: number;
  tasksDelegated: number;
  /** Delegated tasks the harness verified (reached post-run checks) / delegated tasks that ran to a harness verdict. */
  workerPassRate: number | null;
  reviewsDecided: number;
  reviewAcceptanceRate: number | null;
  doneByWorker: number;
  doneByClaude: number;
  /** DONE by a local worker / implementation tasks planned (corrections excluded): the number to optimize. */
  acceptedLocalImplementationRate: number | null;
  avgCodingMs: number | null;
  avgVerifyMs: number | null;
  localInferenceMs: number;
  avgEndToEndMs: number | null;
  integrationAttempts: number;
  integrationFailureRate: number | null;
  runtimeRetries: number;
  codingAttempts: number;
  failuresByCategory: Record<string, number>;
  byState: Record<string, number>;
  /** Claude token usage is not observable from the scheduler (reviews happen in the Lead's own session). */
  claudeReviewTokens: null;
}

export function computeMetrics(store: SchedulerStore, batchId?: string): Metrics {
  const tasks = store.listTasks({ batchId });
  const originals = tasks.filter((t) => !t.correctionOf);
  const delegated = tasks.filter((t) => t.claims > 0 && t.spec.executor === 'worker');
  const events = store.events().filter((e) => tasks.some((t) => t.id === e.taskId));
  const reached = (id: string, state: string) => events.some((e) => e.taskId === id && e.to === state);
  const verdicts = delegated.filter((t) => reached(t.id, 'VERIFYING') || (reached(t.id, 'ESCALATED') && t.failureCategory !== 'runtime_unavailable'));
  const passed = delegated.filter((t) => reached(t.id, 'VERIFYING'));
  const reviews = store.listReviews().filter((r) => r.decision && tasks.some((t) => t.id === r.taskId));
  const doneByWorker = tasks.filter((t) => t.state === 'DONE' && t.implementedBy === 'worker');
  const doneByClaude = tasks.filter((t) => t.state === 'DONE' && t.implementedBy === 'claude');
  const implementation = originals.filter((t) => t.spec.kind === 'implementation');
  // a correction chain counts once: the original is "accepted by a worker" if it or a descendant correction is DONE by a worker
  const acceptedOriginals = implementation.filter((o) => {
    let t: TaskRow | undefined = o;
    for (let i = 0; t && i < 10; i++) {
      if (t.state === 'DONE') return t.implementedBy === 'worker';
      t = t.supersededBy ? store.getTask(t.supersededBy) : undefined;
    }
    return false;
  });
  const integrationEnded = tasks.filter((t) => t.state === 'DONE' || t.failureCategory?.startsWith('integration_') || t.failureCategory === 'diverged_after_review');
  const integrationFailed = integrationEnded.filter((t) => t.state !== 'DONE');
  const failures: Record<string, number> = {};
  for (const t of tasks) if (t.failureCategory && !['DONE'].includes(t.state)) failures[t.failureCategory] = (failures[t.failureCategory] ?? 0) + 1;
  const byState = Object.fromEntries(TASK_STATES.map((s) => [s, tasks.filter((t) => t.state === s).length]).filter(([, n]) => (n as number) > 0));
  return {
    totalTasks: tasks.length,
    eligibleTasks: originals.filter((t) => t.spec.executor === 'worker').length,
    claudeKeptTasks: originals.filter((t) => t.spec.executor === 'claude').length,
    tasksDelegated: delegated.length,
    workerPassRate: rate(passed.length, verdicts.length),
    reviewsDecided: reviews.length,
    reviewAcceptanceRate: rate(reviews.filter((r) => r.decision === 'APPROVED').length, reviews.length),
    doneByWorker: doneByWorker.length,
    doneByClaude: doneByClaude.length,
    acceptedLocalImplementationRate: rate(acceptedOriginals.length, implementation.length),
    avgCodingMs: avg(delegated.filter((t) => t.codingMs > 0).map((t) => t.codingMs)),
    avgVerifyMs: avg(delegated.filter((t) => t.verifyMs > 0).map((t) => t.verifyMs)),
    localInferenceMs: delegated.reduce((a, t) => a + t.codingMs, 0),
    avgEndToEndMs: avg(tasks.filter((t) => t.state === 'DONE' && t.finishedAt).map((t) => t.finishedAt! - t.createdAt)),
    integrationAttempts: integrationEnded.length,
    integrationFailureRate: rate(integrationFailed.length, integrationEnded.length),
    runtimeRetries: delegated.reduce((a, t) => a + t.runtimeRetries, 0),
    codingAttempts: delegated.reduce((a, t) => a + t.attempts, 0),
    failuresByCategory: failures,
    byState,
    claudeReviewTokens: null,
  };
}

/** Human-readable backlog: a generated VIEW of the database, never read back as state. */
export function renderBacklog(store: SchedulerStore, batchId?: string): string {
  const tasks = store.listTasks({ batchId });
  const rows = tasks.map((t) => {
    const c = t.spec.request?.contract;
    return `| ${t.id} | ${t.state} | ${t.priority} | ${t.spec.dependsOn.join(', ') || '-'} | ${t.language ?? '-'} | ${(c?.allowedFiles ?? t.spec.ownedFiles).join('<br>') || '-'} | ${t.spec.risk}/${t.spec.complexity} | ${t.assignedWorker ?? '-'} | ${t.runId ?? '-'} | ${t.attempts} | ${t.reviewOutcome ?? '-'} |`;
  });
  const sections = tasks.map((t) => {
    const c = t.spec.request?.contract;
    return [
      `### ${t.id}: ${t.title}`,
      `State **${t.state}**${t.stateReason ? ` (${t.stateReason})` : ''}${t.failureCategory ? `, failure: ${t.failureCategory}` : ''}. Executor: ${t.executor}${t.spec.keptReason ? ` (kept: ${t.spec.keptReason})` : ''}.`,
      c ? `\n**Objective:** ${c.objective}\n\n**Acceptance:**\n${c.acceptanceCriteria.map((a) => `- ${a}`).join('\n')}\n\n**Verification:** ${c.verificationCommands.map((v) => `\`${v.join(' ')}\``).join(', ')}\n\n**Constraints:** ${c.constraints.join('; ')}\n\n**Context files:** ${c.contextFiles.join(', ') || '-'}` : '',
      '',
    ].join('\n');
  });
  return [`# Backlog${batchId ? `: ${batchId}` : ''}`, '', '_Generated from the scheduler database. Edit the plan JSON, not this file._', '', '| Task | State | Pri | Depends on | Lang | Allowed files | Risk/Cx | Worker | Mastra run | Attempts | Review |', '|---|---|---|---|---|---|---|---|---|---|---|', ...rows, '', ...sections].join('\n');
}

export interface ReconcileIssue {
  taskId?: string;
  kind: 'missing_worktree' | 'orphan_worktree' | 'stale_lease' | 'review_missing' | 'terminal_with_lease' | 'corrupt_row';
  detail: string;
}

/** Compares database state with the filesystem/git. Reports only; nothing is deleted or modified. */
export async function reconcileState(store: SchedulerStore, worktrees: WorktreeManager, batchId?: string): Promise<ReconcileIssue[]> {
  const issues: ReconcileIssue[] = [];
  for (const c of store.corruptRows()) {
    issues.push({ taskId: c.table === 'tasks' ? c.id : undefined, kind: 'corrupt_row', detail: `${c.table} row quarantined${c.state ? ` (state ${c.state})` : ''}: ${c.error}. Repair or remove it by hand; scheduling skips it meanwhile` });
  }
  const tasks = store.listTasks({ batchId });
  const now = store.now();
  for (const t of tasks) {
    if (t.worktreePath && !existsSync(t.worktreePath) && ['CLAIMED', 'CODING', 'VERIFYING', 'REVIEW_PENDING', 'APPROVED', 'INTEGRATING'].includes(t.state)) {
      issues.push({ taskId: t.id, kind: 'missing_worktree', detail: `${t.state} task's worktree ${t.worktreePath} is gone` });
    }
    if (['CLAIMED', 'CODING', 'VERIFYING'].includes(t.state) && t.leaseOwner && t.leaseExpiresAt !== null && t.leaseExpiresAt < now) {
      issues.push({ taskId: t.id, kind: 'stale_lease', detail: `lease of ${t.leaseOwner} expired ${Math.round((now - t.leaseExpiresAt) / 1000)}s ago; run \`resume\`` });
    }
    if (t.state === 'REVIEW_PENDING' && !store.latestReview(t.id)) issues.push({ taskId: t.id, kind: 'review_missing', detail: 'REVIEW_PENDING without a review request' });
    if (['DONE', 'CANCELLED', 'ESCALATED', 'REVIEW_PENDING'].includes(t.state) && t.leaseOwner) issues.push({ taskId: t.id, kind: 'terminal_with_lease', detail: `${t.state} still carries lease ${t.leaseOwner}` });
  }
  const known = new Set<string>();
  for (const t of store.listTasks()) if (t.worktreePath) known.add(await realpath(t.worktreePath).catch(() => t.worktreePath!));
  const repositories = new Set(store.listBatches().filter((b) => !batchId || b.id === batchId).map((b) => b.repository));
  for (const repository of repositories) {
    for (const path of await worktrees.listManagedPaths(repository).catch(() => [])) {
      if (!known.has(path) && !path.endsWith('/_integration')) issues.push({ kind: 'orphan_worktree', detail: `${path} is a worktree with no task row` });
    }
  }
  return issues;
}

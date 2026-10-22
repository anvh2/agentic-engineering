import {
  unknownUsage,
  type ControlAgent,
  type ControlTask,
  type ModelCall,
  type Snapshot,
  type Usage,
} from '../../../src/integrations/control-center/contract.ts';
import { summarizeUsage } from '../../../src/integrations/control-center/usage.ts';

const activeStates = new Set(['READY', 'CLAIMED', 'CODING', 'VERIFYING']);
export function currentTasks(snapshot: Snapshot, agent?: ControlAgent, task?: ControlTask): ControlTask[] {
  return snapshot.tasks.filter(
    (t) =>
      t.objectiveId === snapshot.objectiveId &&
      (task ? t.id === task.id : agent?.assignmentIds.includes(t.id)) &&
      activeStates.has(t.state) &&
      !t.stale,
  );
}
export function observedActivity(agent: ControlAgent, tasks: ControlTask[], connected: boolean, now: number): ControlAgent['activity'] {
  if (!connected) return 'UNKNOWN';
  if (
    ['RUNNING', 'VERIFYING'].includes(agent.activity) &&
    (!tasks.length || tasks.every((t) => t.leaseExpiresAt !== null && t.leaseExpiresAt <= now))
  )
    return 'UNKNOWN';
  return agent.activity;
}
export function claimElapsed(task: ControlTask, now: number, connected: boolean): number | null {
  if (!connected || task.stale || task.activeSince === null || (task.leaseExpiresAt !== null && task.leaseExpiresAt <= now)) return null;
  return Math.max(0, now - task.activeSince);
}
export function uniqueCalls(calls: ModelCall[]): ModelCall[] {
  const out = new Map<string, ModelCall>();
  for (const call of calls) {
    const previous = out.get(call.id);
    if (!previous || previous.finishedAt === null || (call.finishedAt !== null && call.finishedAt >= previous.finishedAt))
      out.set(call.id, call);
  }
  return [...out.values()];
}
export function usageForCalls(calls: ModelCall[], objectiveId: string | null): Usage {
  if (objectiveId === null) return unknownUsage();
  const unique = uniqueCalls(calls.filter((c) => c.objectiveId === objectiveId));
  const usage = summarizeUsage(unique, { objectiveId });
  // Cost is displayed only with explicit model and pricing provenance, never inferred from aliases or tokens.
  const price = unique[0]?.usage.estimatedCost;
  if (
    price &&
    price.modelId.trim() &&
    price.modelId !== 'UNKNOWN' &&
    price.pricingSource.trim() &&
    unique.every(
      (c) =>
        c.modelId === price.modelId &&
        c.usage.estimatedCost?.modelId === price.modelId &&
        c.usage.estimatedCost?.pricingSource === price.pricingSource &&
        c.usage.estimatedCost?.pricedAt === price.pricedAt,
    )
  ) {
    usage.estimatedCost = { ...price, usd: unique.reduce((sum, c) => sum + c.usage.estimatedCost!.usd, 0) };
  }
  return usage;
}
export function inspectorObservations(snapshot: Snapshot, agent?: ControlAgent, task?: ControlTask) {
  const tasks = snapshot.tasks.filter(
    (t) => t.objectiveId === snapshot.objectiveId && (task ? t.id === task.id : t.provider === agent?.provider),
  );
  const assigned = currentTasks(snapshot, agent, task);
  const calls = uniqueCalls(
    snapshot.calls.filter(
      (c) => c.objectiveId === snapshot.objectiveId && tasks.some((t) => t.id === c.taskId && t.provider === c.provider),
    ),
  );
  const current = calls.filter((c) => assigned.some((t) => t.id === c.taskId && t.runId === c.runId));
  const ids = new Set(current.map((c) => c.id));
  const historical = calls.filter((c) => !ids.has(c.id));
  return {
    assigned,
    current,
    historical,
    currentUsage: usageForCalls(current, snapshot.objectiveId),
    historicalUsage: usageForCalls(historical, snapshot.objectiveId),
    history: tasks
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .flatMap<{ id: string | null; task: ControlTask }>((t) =>
        t.runIds.length ? [...new Set(t.runIds)].reverse().map((id) => ({ id, task: t })) : [{ id: null, task: t }],
      ),
  };
}
export function taskUsage(snapshot: Snapshot, task: ControlTask): Usage {
  if (task.usage.source !== 'unavailable') return task.usage;
  return usageForCalls(
    snapshot.calls.filter((c) => c.taskId === task.id && c.provider === task.provider),
    snapshot.objectiveId,
  );
}
export function priced(usage: Usage): boolean {
  const price = usage.estimatedCost;
  return !!price && !!price.modelId.trim() && price.modelId !== 'UNKNOWN' && !!price.pricingSource.trim();
}

/** Why a value is absent. A missing value is labelled, never shown as zero. */
export type Absence = 'NOT RECORDED' | 'UNAVAILABLE' | 'NOT APPLICABLE' | 'NO ACTIVE RUN' | 'UNKNOWN';
/** Usage with no telemetry source is NOT RECORDED; a disconnected source is UNAVAILABLE; partial gaps stay UNKNOWN. */
export function usageAbsence(usage: Usage, connected: boolean): Absence {
  if (!connected) return 'UNAVAILABLE';
  if (usage.source === 'unavailable' || usage.completeness === 'unavailable') return 'NOT RECORDED';
  return 'UNKNOWN';
}
export function usageValue(value: number | null, usage: Usage, connected: boolean): number | Absence {
  return value === null ? usageAbsence(usage, connected) : value;
}
const leased = new Set(['CLAIMED', 'CODING', 'VERIFYING']);
/** Claim elapsed applies only to a leased task; an expired lease is UNKNOWN, not idle. */
export function claimElapsedOrAbsence(task: ControlTask, now: number, connected: boolean): number | Absence {
  if (!connected) return 'UNAVAILABLE';
  if (!leased.has(task.state)) return 'NOT APPLICABLE';
  return claimElapsed(task, now, connected) ?? 'UNKNOWN';
}
/** States an operator must act on or inspect: work stopped without a passing integration. */
export const ATTENTION_STATES: readonly ControlTask['state'][] = ['BLOCKED', 'ESCALATED', 'RUNTIME_FAILURE', 'REVIEW_REJECTED'];
export const needsAttention = (task: ControlTask) => ATTENTION_STATES.includes(task.state);

import { z } from 'zod';

/**
 * Delegation capacity: how much change one delegated task may produce and still be reviewed as one unit. It replaces the
 * review gate's silent 80-line default with a policy that is part of the task spec, persisted with it, shown at plan
 * validation before any claim, and recorded in the review evidence.
 *
 * Two kinds of limit, never mixed:
 *
 *   quality (repairable)  warnChangedLinesPerFile -> `too_large` (warn). The verified review asks for a correction inside the
 *                         task's existing correction budget; on a paid provider only with the operator's authorization.
 *   safety  (hard)        maxChangedLinesPerTask  -> `capacity_exceeded` (block). The task is ESCALATED for a human. Nothing
 *                         retries it and nothing raises the limit on its own: the operator cancels it, or re-plans the work
 *                         with an explicit, larger policy that is still bounded by CAPACITY_CEILING.
 *
 * A task without a policy is judged by DEFAULT_DELEGATION_CAPACITY, and the evidence says `source: 'default'`, so the
 * limit that judged a change is never implicit. A partial or incoherent policy is rejected when the spec is parsed: there
 * is no field-by-field fallback to defaults.
 */

/** The hard limit a plan may never raise past. Changing it is a code review, not a plan edit. */
export const CAPACITY_CEILING = Object.freeze({ maxChangedLinesPerTask: 2_000 });

export const delegationCapacitySchema = z
  .object({
    /** Quality threshold per allowed file (added + deleted lines). Above it the review raises a repairable `too_large`. */
    warnChangedLinesPerFile: z.number().int().min(1),
    /** Safety limit for the whole task (added + deleted lines over every allowed file). Above it the change is blocked. */
    maxChangedLinesPerTask: z.number().int().min(1).max(CAPACITY_CEILING.maxChangedLinesPerTask),
  })
  .strict()
  .refine((p) => p.warnChangedLinesPerFile <= p.maxChangedLinesPerTask, {
    message: 'warnChangedLinesPerFile must not exceed maxChangedLinesPerTask (a quality warning above the hard limit could never fire)',
  });
export type DelegationCapacity = z.output<typeof delegationCapacitySchema>;

/** Conservative defaults: the review-time threshold M8 ran with (80 per file) and a hard task limit five times that. */
export const DEFAULT_DELEGATION_CAPACITY: Readonly<DelegationCapacity> = Object.freeze({ warnChangedLinesPerFile: 80, maxChangedLinesPerTask: 400 });

export interface ResolvedCapacity extends DelegationCapacity {
  /** 'task': the spec carried the policy. 'default': it carried none and DEFAULT_DELEGATION_CAPACITY applied. */
  source: 'task' | 'default';
}

export function resolveCapacity(policy: DelegationCapacity | undefined): ResolvedCapacity {
  return policy ? { ...delegationCapacitySchema.parse(policy), source: 'task' } : { ...DEFAULT_DELEGATION_CAPACITY, source: 'default' };
}

export function describeCapacity(c: ResolvedCapacity): string {
  return `warn above ${c.warnChangedLinesPerFile} changed lines per file (repairable), block above ${c.maxChangedLinesPerTask} per task (escalates to a human) [${c.source === 'task' ? 'task policy' : 'default policy'}]`;
}

export type CapacityFindingCode = 'too_large' | 'capacity_exceeded';

export interface CapacityFinding {
  code: CapacityFindingCode;
  severity: 'warn' | 'block';
  detail: string;
}

/** Judges measured changed-line counts (file -> added + deleted) against a resolved policy. At the limit is within it. */
export function capacityFindings(changedLines: ReadonlyMap<string, number>, policy: ResolvedCapacity): CapacityFinding[] {
  const findings: CapacityFinding[] = [];
  const label = policy.source === 'task' ? 'task policy' : 'default policy';
  let total = 0;
  for (const [file, lines] of changedLines) {
    total += lines;
    if (lines > policy.warnChangedLinesPerFile) {
      findings.push({ code: 'too_large', severity: 'warn', detail: `${file}: ${lines} changed lines exceeds the ${label}'s warnChangedLinesPerFile of ${policy.warnChangedLinesPerFile}; review for unrelated edits` });
    }
  }
  if (total > policy.maxChangedLinesPerTask) {
    findings.push({
      code: 'capacity_exceeded',
      severity: 'block',
      detail: `${total} changed lines across ${changedLines.size} file(s) exceeds the ${label}'s maxChangedLinesPerTask of ${policy.maxChangedLinesPerTask}: a hard limit, escalated to a human (cancel, or re-plan with an explicit larger policy, at most ${CAPACITY_CEILING.maxChangedLinesPerTask})`,
    });
  }
  return findings;
}

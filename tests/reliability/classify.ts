/**
 * Failure classification for Reliability Lab evidence (M10). Rule-based and conservative: a record is labelled only when the
 * evidence carries the signature that justifies the label, and everything else is `unknown` - never a guess.
 *
 *   product_defect  the runtime broke one of its own contracts (a cancel confirmed against the wrong resource, a provider
 *                   process alive after a confirmed cancel, a second execution after a timeout, a late spawn)
 *   test_race       the runtime behaved correctly; the test assumed an interleaving the product never promised
 *   environmental   the machine, not the code: ports, disk, file descriptors, a missing binary or sandbox
 *   unknown         none of the above is supported by the evidence
 */

export const EVIDENCE_SCHEMA = 'agentic.reliability-evidence/1';

export type Category = 'pass' | 'product_defect' | 'test_race' | 'environmental' | 'unknown';

export interface EngagedEntry {
  kind: 'lease' | 'waiter';
  holder: string;
  pid: number;
  /** Capacity resource of the entry, when the scenario could read it. */
  resource?: string;
  alive?: boolean;
}

export interface Evidence {
  schema: typeof EVIDENCE_SCHEMA;
  scenario: string;
  run: number;
  ok: boolean;
  durationMs: number;
  failure?: { message: string; stack?: string };
  runtime?: {
    taskState?: string;
    failureCategory?: string | null;
    cancelOutcome?: string | null;
    processes?: { pid: number; groupGone: boolean }[];
    engaged?: EngagedEntry[];
    taskResource?: string;
    claims?: number;
    requeued?: string[];
    faultsFired?: string[];
    prompts?: number;
  };
  [key: string]: unknown;
}

export interface Classification {
  category: Category;
  reasons: string[];
}

const ENVIRONMENTAL = [/EADDRINUSE/, /ENOSPC/, /EMFILE|ENFILE/, /ECONNREFUSED/, /spawn \S+ ENOENT/, /sandbox-exec is not usable/, /Ollama not reachable/, /no space left on device/i];

export function classify(e: Evidence): Classification {
  if (e.ok) return { category: 'pass', reasons: [] };
  const message = e.failure?.message ?? '';
  const rt = e.runtime ?? {};

  const env = ENVIRONMENTAL.find((re) => re.test(message));
  if (env) return { category: 'environmental', reasons: [`failure message matches ${env}`] };

  // Product contracts, checked on the runtime's own report before any interpretation of the test's assertion.
  const defects: string[] = [];
  const foreign = (rt.engaged ?? []).filter((x) => rt.taskResource && x.resource && x.resource !== rt.taskResource);
  if (foreign.length && (rt.cancelOutcome === 'still_active' || /still_active|model still engaged/.test(message))) defects.push(`cancel blocked by ${foreign.length} permit(s) on another resource (${foreign.map((x) => `${x.resource}:${x.holder}`).join(', ')}) than the task's ${rt.taskResource}`);
  const deadButEngaged = (rt.engaged ?? []).filter((x) => x.alive === false);
  if (deadButEngaged.length && rt.cancelOutcome === 'still_active') defects.push(`cancel blocked by permit(s) of dead process(es) ${deadButEngaged.map((x) => x.pid).join(', ')}`);
  const orphans = (rt.processes ?? []).filter((p) => !p.groupGone);
  if (orphans.length && rt.cancelOutcome === 'stopped') defects.push(`cancel reported stopped while provider group(s) ${orphans.map((p) => p.pid).join(', ')} are alive`);
  if ((rt.claims ?? 1) > 1 || (rt.requeued ?? []).length > 0) defects.push(`duplicate execution: claims=${rt.claims ?? '?'} requeued=${JSON.stringify(rt.requeued ?? [])}`);
  if ((rt.faultsFired ?? []).includes('provider.before-spawn') && rt.cancelOutcome === 'stopped' && (rt.processes ?? []).length > 0 && /before.*spawn/i.test(e.scenario)) defects.push('a provider process was spawned after the cancel at provider.before-spawn (late spawn)');
  if (defects.length) return { category: 'product_defect', reasons: defects };

  // The known test race (M10 F1): the test waited for a CLI that the runtime correctly never started / never let become ready.
  if (/timed out waiting for: .*CLI to be running/.test(message)) {
    const clean = rt.cancelOutcome === undefined || rt.cancelOutcome === 'stopped';
    const gone = (rt.processes ?? []).every((p) => p.groupGone);
    if (clean && gone) return { category: 'test_race', reasons: ['the test waited for the provider CLI to report in, but the runtime timed out first and stopped cleanly (no live process, cancel confirmed)'] };
  }
  if (/still_active|model still engaged/.test(message) && (rt.engaged ?? []).length && !foreign.length) {
    return { category: 'unknown', reasons: ['cancel unconfirmed by a permit on the task\'s own resource: either the provider really is still running or another run shares the task id on that resource; the evidence does not say which'] };
  }
  return { category: 'unknown', reasons: [message ? `unclassified failure: ${message.slice(0, 200)}` : 'failed without a message'] };
}

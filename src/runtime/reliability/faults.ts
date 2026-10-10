import { appendFileSync } from 'node:fs';

/**
 * Deterministic fault injection at named execution boundaries (M10 Reliability Lab). It lets a test force an interleaving
 * that otherwise depends on machine load - "the budget expires before the CLI is spawned", "the run is cancelled right after
 * the permit is granted" - instead of hoping for it or widening a timeout until it stops happening.
 *
 * Inert unless the process was started with AGENTIC_FAULTS_ENABLE=test. A plan without that switch does nothing at all (no
 * delay, no log), so no configuration mistake can slow down or break production work. The plan travels by environment so it
 * reaches the Mastra server child process the HTTP smoke harness starts (tests/provider-smoke/http-backend.ts).
 *
 *   AGENTIC_FAULTS_ENABLE=test
 *   AGENTIC_FAULTS='{"provider.before-spawn": {"delayMs": 60000}, "runner.after-permit": {"throw": "boom", "times": 1}}'
 *   AGENTIC_FAULTS_LOG=/path/faults.jsonl      one JSON line per firing: the evidence that the boundary was reached
 *
 * A delay is abortable: the caller's AbortSignal ends it at once with the signal's reason, exactly as the real boundary
 * would observe a cancel. A plan naming an unknown boundary is refused (a typo must not silently test nothing).
 */

export const FAULT_POINTS = [
  'runner.before-permit', //   coding runner, before it queues for the model capacity permit
  'runner.after-permit', //    coding runner, permit held, before the model call starts
  'provider.before-spawn', //  provider adapter, immediately before its model-call process is spawned
] as const;
export type FaultPointName = (typeof FAULT_POINTS)[number];

export const FAULTS_ENABLE_ENV = 'AGENTIC_FAULTS_ENABLE';
export const FAULTS_ENV = 'AGENTIC_FAULTS';
export const FAULTS_LOG_ENV = 'AGENTIC_FAULTS_LOG';

export interface FaultAction {
  /** Wait this long (abortable) before continuing. */
  delayMs?: number;
  /** Throw an Error with this message at the boundary. */
  throw?: string;
  /** Fire at most this many times per process (default: every time). */
  times?: number;
}
export type FaultPlan = Partial<Record<FaultPointName, FaultAction>>;

export class FaultPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaultPlanError';
  }
}

export function parseFaultPlan(raw: string): FaultPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FaultPlanError(`${FAULTS_ENV} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new FaultPlanError(`${FAULTS_ENV} must be an object of fault point -> action`);
  const plan: FaultPlan = {};
  for (const [point, action] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(FAULT_POINTS as readonly string[]).includes(point)) throw new FaultPlanError(`unknown fault point "${point}" (known: ${FAULT_POINTS.join(', ')})`);
    const a = action as Record<string, unknown>;
    if (!a || typeof a !== 'object') throw new FaultPlanError(`fault point ${point}: the action must be an object`);
    for (const key of Object.keys(a)) if (!['delayMs', 'throw', 'times'].includes(key)) throw new FaultPlanError(`fault point ${point}: unknown action field "${key}"`);
    if (a.delayMs !== undefined && (typeof a.delayMs !== 'number' || !Number.isFinite(a.delayMs) || a.delayMs < 0)) throw new FaultPlanError(`fault point ${point}: delayMs must be a non-negative number`);
    if (a.throw !== undefined && (typeof a.throw !== 'string' || !a.throw)) throw new FaultPlanError(`fault point ${point}: throw must be a non-empty string`);
    if (a.times !== undefined && (!Number.isInteger(a.times) || (a.times as number) < 1)) throw new FaultPlanError(`fault point ${point}: times must be a positive integer`);
    plan[point as FaultPointName] = { ...(a.delayMs !== undefined ? { delayMs: a.delayMs as number } : {}), ...(a.throw !== undefined ? { throw: a.throw as string } : {}), ...(a.times !== undefined ? { times: a.times as number } : {}) };
  }
  return plan;
}

const fired = new Map<string, number>();

export function faultEnv(plan: FaultPlan, logPath?: string): Record<string, string> {
  parseFaultPlan(JSON.stringify(plan)); // refuse a bad plan where it is written, not only where it fires
  return { [FAULTS_ENABLE_ENV]: 'test', [FAULTS_ENV]: JSON.stringify(plan), ...(logPath ? { [FAULTS_LOG_ENV]: logPath } : {}) };
}

/** The boundary. Resolves immediately (and does nothing) unless fault injection is enabled AND the plan names this point. */
export async function faultPoint(name: FaultPointName, options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const env = options.env ?? process.env;
  if (env[FAULTS_ENABLE_ENV] !== 'test') return;
  const raw = env[FAULTS_ENV];
  if (!raw) return;
  const action = parseFaultPlan(raw)[name];
  if (!action) return;
  const key = `${raw}\u0000${name}`;
  const count = (fired.get(key) ?? 0) + 1;
  if (action.times !== undefined && count > action.times) return;
  fired.set(key, count);
  const log = env[FAULTS_LOG_ENV];
  if (log) appendFileSync(log, JSON.stringify({ point: name, pid: process.pid, at: Date.now(), firing: count, action }) + '\n');
  if (action.throw) throw new Error(`injected fault at ${name}: ${action.throw}`);
  if (action.delayMs) await abortableDelay(action.delayMs, options.signal);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(reasonOf(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(reasonOf(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const reasonOf = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted')));

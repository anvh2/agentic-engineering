/**
 * Lifecycle hook policy: SessionStart, PreCompact, PreToolUse, PostToolUse, SessionEnd.
 *
 * This module only produces DECISIONS. It never executes a shell, starts a scheduler, grants permissions, installs a
 * machine-wide hook or reads transcripts. Callers (the runtime) enforce the decision; a rejected PreToolUse for a write or
 * execute class tool means the tool MUST NOT run (fail closed).
 *
 * Differences from the first PR #53 revision (audit F-07 and friends):
 *  - Tools are classified by a RUNTIME-OWNED table. An unknown tool is rejected, never "allowed because it has no path".
 *  - A write-class tool without a path is rejected (it used to pass the path allowlist by omission).
 *  - Events are strictly validated (exact keys, types, lengths); malformed input is a rejection, never an exception.
 *  - Fingerprints use canonical JSON, so key order cannot change an event's identity.
 *  - `HookSession` enforces ordering and idempotency: a replay of an identical event is reported as a replay (no second
 *    side effect), a conflicting event at the same sequence number is rejected, and nothing is accepted after SessionEnd.
 */
import { hashValue, scanForSecrets, canonicalJson } from './canonical.ts';

export type HookPhase = 'SessionStart' | 'PreCompact' | 'PreToolUse' | 'PostToolUse' | 'SessionEnd';
export type HookEvent = Readonly<{
  sessionId: string; seq: number; phase: HookPhase; taskId: string;
  tool?: string; relativePath?: string; outcome?: 'ok' | 'failed';
}>;
export type HookDecision = Readonly<{ accepted: boolean; reason: string; eventFingerprint: string; replay?: boolean }>;

export type ToolClass = 'read' | 'write' | 'execute';
/** Runtime-owned. Adding a tool here is a code change reviewed with the permission model, not a prompt or manifest edit. */
export const TOOL_CLASSES: Readonly<Record<string, ToolClass>> = Object.freeze(Object.assign(Object.create(null) as Record<string, ToolClass>, {
  listFiles: 'read', readFile: 'read', searchFiles: 'read', gitStatus: 'read', gitDiff: 'read',
  writeFile: 'write', applyPatch: 'write',
  runGoFmt: 'execute', runGoTest: 'execute', runJestTest: 'execute', runPrettier: 'execute',
}));
/** Own-property lookup only: names such as `constructor` or `toString` are never tools. */
export const toolClassOf = (tool: string): ToolClass | undefined => (Object.hasOwn(TOOL_CLASSES, tool) ? TOOL_CLASSES[tool] : undefined);

export interface HookPolicy {
  taskId: string;
  /** Tool ids this task may use at all. */
  tools: readonly string[];
  /** Exact relative paths this task may modify (the task's allowedFiles). */
  paths: readonly string[];
}

const PHASES: readonly string[] = ['SessionStart', 'PreCompact', 'PreToolUse', 'PostToolUse', 'SessionEnd'];
const KEYS = new Set(['sessionId', 'seq', 'phase', 'taskId', 'tool', 'relativePath', 'outcome']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const MAX_PATH = 400;

export function safeRelativePath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH && !p.startsWith('/') && !p.includes('\\') && !/[\u0000-\u001f\u007f]/.test(p)
    && p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

type Parsed = { ok: true; event: HookEvent } | { ok: false; reason: string };
function parseEvent(raw: unknown): Parsed {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'malformed hook' };
  const e = raw as Record<string, unknown>;
  for (const key of Object.keys(e)) if (!KEYS.has(key)) return { ok: false, reason: 'malformed hook: unexpected field' };
  if (typeof e.sessionId !== 'string' || !ID.test(e.sessionId) || typeof e.taskId !== 'string' || !ID.test(e.taskId)
    || typeof e.seq !== 'number' || !Number.isSafeInteger(e.seq) || e.seq < 0 || typeof e.phase !== 'string' || !PHASES.includes(e.phase)) return { ok: false, reason: 'malformed hook' };
  if (e.tool !== undefined && (typeof e.tool !== 'string' || !ID.test(e.tool))) return { ok: false, reason: 'malformed hook' };
  if (e.relativePath !== undefined && !safeRelativePath(e.relativePath)) return { ok: false, reason: 'path outside allowlist' };
  if (e.outcome !== undefined && e.outcome !== 'ok' && e.outcome !== 'failed') return { ok: false, reason: 'malformed hook' };
  return { ok: true, event: e as unknown as HookEvent };
}

const fingerprintOf = (raw: unknown): string => {
  try { return hashValue(raw); } catch { return hashValue({ unfingerprintable: true }); }
};

/** Stateless validation of one event against one task policy. Never throws. */
export function inspectHook(raw: unknown, policy: HookPolicy): HookDecision {
  const fingerprint = fingerprintOf(raw);
  const fail = (reason: string): HookDecision => Object.freeze({ accepted: false, reason, eventFingerprint: fingerprint });
  try {
    const parsed = parseEvent(raw);
    if (!parsed.ok) return fail(parsed.reason);
    const event = parsed.event;
    if (event.taskId !== policy.taskId) return fail('hook outside task scope');
    if (event.phase === 'PreToolUse' || event.phase === 'PostToolUse') {
      if (!event.tool) return fail('tool event without a tool');
      const cls = toolClassOf(event.tool);
      if (!cls) return fail('unknown tool');
      if (!policy.tools.includes(event.tool)) return fail('tool outside allowlist');
      if (cls === 'write') {
        if (!event.relativePath) return fail('write tool requires a path');
        if (!policy.paths.includes(event.relativePath)) return fail('path outside allowlist');
      }
    } else if (event.tool !== undefined || event.relativePath !== undefined) {
      return fail('tool fields on a non-tool event');
    }
    if (event.phase !== 'PostToolUse' && event.outcome !== undefined) return fail('outcome only valid after a tool');
    return Object.freeze({ accepted: true, reason: 'lifecycle event accepted', eventFingerprint: fingerprint });
  } catch {
    return fail('hook inspection failed closed');
  }
}

/**
 * Per-session ordering and idempotency. Sequence numbers are contiguous from 0. Pass `restore` events (already accepted and
 * persisted) to resume a session without re-running its side effects.
 */
export class HookSession {
  private nextSeq = 0;
  private ended = false;
  private open: { tool: string; relativePath: string | undefined } | undefined;
  private readonly seen = new Map<number, string>();
  private readonly policy: HookPolicy;
  readonly sessionId: string;
  // No parameter properties: Node's strip-only TypeScript mode cannot compile them.
  constructor(policy: HookPolicy, sessionId: string) {
    if (!ID.test(sessionId)) throw new Error('hook: invalid session id');
    this.policy = policy;
    this.sessionId = sessionId;
  }

  /**
   * Rebuilds a session from events that were already accepted and persisted (restart, resume). Every stored event is re-validated
   * against the policy and the ordering rules, so a corrupted or tampered log is an error here rather than silent state.
   * Afterwards a replay of any stored event reports `replay: true`, and the caller must not repeat its side effect.
   */
  static restore(policy: HookPolicy, sessionId: string, events: readonly unknown[]): HookSession {
    const session = new HookSession(policy, sessionId);
    events.forEach((event, index) => {
      const decision = session.accept(event);
      if (!decision.accepted || decision.replay) throw new Error(`hook: stored event ${index} is not valid for this session (${decision.reason})`);
    });
    return session;
  }

  /** Exposed for persistence: the next sequence number this session will accept. */
  get next(): number { return this.nextSeq; }

  accept(raw: unknown): HookDecision {
    const base = inspectHook(raw, this.policy);
    if (!base.accepted) return base;
    const event = raw as HookEvent;
    const reject = (reason: string): HookDecision => Object.freeze({ accepted: false, reason, eventFingerprint: base.eventFingerprint });
    if (event.sessionId !== this.sessionId) return reject('hook belongs to another session');
    const previous = this.seen.get(event.seq);
    if (previous !== undefined) {
      return previous === base.eventFingerprint ? Object.freeze({ ...base, replay: true, reason: 'replay of an already accepted event' }) : reject('conflicting event for this sequence number');
    }
    if (this.ended) return reject('session already ended');
    if (event.seq !== this.nextSeq) return reject('out-of-order sequence');
    if (event.phase === 'SessionStart' && event.seq !== 0) return reject('SessionStart must be first');
    if (event.seq === 0 && event.phase !== 'SessionStart') return reject('session must start with SessionStart');
    if (event.phase === 'PreToolUse') {
      if (this.open) return reject('previous tool call has no PostToolUse');
      this.open = { tool: event.tool!, relativePath: event.relativePath };
    } else if (event.phase === 'PostToolUse') {
      if (!this.open || this.open.tool !== event.tool || this.open.relativePath !== event.relativePath) return reject('PostToolUse without matching PreToolUse');
      this.open = undefined;
    } else if ((event.phase === 'PreCompact' || event.phase === 'SessionEnd') && this.open) {
      return reject('tool call still open');
    }
    if (event.phase === 'SessionEnd') this.ended = true;
    this.seen.set(event.seq, base.eventFingerprint);
    this.nextSeq = event.seq + 1;
    return base;
  }
}

export type SessionSummary = Readonly<{
  taskId: string; checkpointDigest: string;
  completedSteps: readonly string[]; pendingSteps: readonly string[]; unverifiedClaims: readonly string[];
}>;

/** Lossless projection of durable state for a fresh context. Over budget is an error, never silent truncation. */
export function compactSession(summary: SessionSummary, maxBytes = 4096): string {
  if (!/^[a-f0-9]{64}$/.test(summary.checkpointDigest) || !Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 65536) throw new Error('hook: invalid checkpoint/budget');
  const projection = {
    taskId: summary.taskId, checkpointDigest: summary.checkpointDigest,
    completedSteps: summary.completedSteps, pendingSteps: summary.pendingSteps, unverifiedClaims: summary.unverifiedClaims,
  };
  if (scanForSecrets(projection).length) throw new Error('hook: session summary contains a credential');
  const output = canonicalJson(projection);
  if (Buffer.byteLength(output) > maxBytes) throw new Error('hook: context would truncate durable state');
  return output;
}

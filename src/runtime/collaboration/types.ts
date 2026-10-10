import { z } from 'zod';
import type { Measured, ProviderUsage } from '../execution/worker-provider.ts';

/**
 * Engineering collaboration contracts (M9). A discussion is an append-only, hash-chained event stream per thread, stored
 * beside the scheduler tables (src/runtime/collaboration/store.ts). Nothing here grants authority: a decision is a record of
 * what the participants concluded, never an authorization, a task transition or a permission (see DecisionPayload).
 */

export const COLLABORATION_SCHEMA = 'agentic.collaboration/1';
export const MEETING_RECORD_SCHEMA = 'agentic.meeting-record/1';

/**
 * Hard ceilings. A session's own limits must sit inside them; content above a size limit is refused, never truncated
 * (a truncated contribution is a different contribution). Changing them is a code review, not a configuration edit.
 */
export const COLLABORATION_CEILINGS = Object.freeze({
  maxParticipants: 8,
  maxAgendaItems: 10,
  maxRounds: 10,
  maxInvocations: 100,
  maxTokens: 2_000_000,
  maxBodyChars: 16_000,
  maxEvidence: 32,
  maxActionItems: 20,
  /** Replay is O(events) per command; a thread past this is refused (fail closed) rather than slowed down silently. */
  maxEventsPerThread: 5_000,
});

export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'ids are 1-128 chars of [A-Za-z0-9._:-], starting alphanumeric');

// ---- identities ------------------------------------------------------------------------------------------------

export const AGENT_KINDS = ['lead', 'worker', 'reviewer', 'operator'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const ENGINEERING_ROLES = ['engineering_lead', 'architect', 'implementer', 'reviewer', 'verifier', 'operator'] as const;
export type EngineeringRole = (typeof ENGINEERING_ROLES)[number];

/** A configured agent. Messages carry a snapshot of it taken from the directory, never from the caller. */
export const participantIdentitySchema = z
  .object({
    id: idSchema,
    role: z.enum(ENGINEERING_ROLES),
    kind: z.enum(AGENT_KINDS),
    displayName: z.string().min(1).max(120).optional(),
    /** Worker provider id (ollama, codex, gemini, ...) or the Lead's runtime; absent for a human operator. */
    provider: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((a) => (a.kind === 'operator') === (a.role === 'operator'), { message: 'only an operator identity may hold the operator role' });
export type ParticipantIdentity = z.output<typeof participantIdentitySchema>;

// ---- references ------------------------------------------------------------------------------------------------

/** Objective / batch / task this thread or message is about. Batch and task ids are checked against the scheduler. */
export const workRefSchema = z
  .object({
    objectiveId: idSchema.optional(),
    batchId: idSchema.optional(),
    taskId: idSchema.optional(),
  })
  .strict();
export type WorkRef = z.output<typeof workRefSchema>;

export const EVIDENCE_KINDS = ['message', 'event', 'task', 'commit', 'file', 'trace', 'artifact', 'review'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * A pointer to something a claim rests on. `message`/`event` must exist in the same thread, `task` in the scheduler;
 * `commit` is a hex SHA, `file` a repository-relative path. trace/artifact/review are opaque references (a Mastra trace id,
 * an artifact path, a review id) recorded as given.
 */
export const evidenceRefSchema = z
  .object({
    kind: z.enum(EVIDENCE_KINDS),
    ref: z.string().min(1).max(512),
    note: z.string().max(500).optional(),
  })
  .strict();
export type EvidenceRef = z.output<typeof evidenceRefSchema>;

/** What a caller reports about the model call that produced a message. Provider and model come from the directory. */
export const invocationInputSchema = z
  .object({
    runId: z.string().min(1).max(200).optional(),
    traceId: z.string().min(1).max(200).optional(),
    inferenceMs: z.number().int().min(0).optional(),
    usage: z
      .object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().optional(), quota: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();
export type InvocationInput = z.input<typeof invocationInputSchema>;

/** Stored model-invocation reference. Anything not reported is the literal 'UNKNOWN' (never 0, never absent). */
export interface InvocationRef {
  provider: string;
  model: string;
  runId: string | null;
  traceId: string | null;
  inferenceMs: Measured<number>;
  usage: ProviderUsage;
}

// ---- messages --------------------------------------------------------------------------------------------------

export const MESSAGE_KINDS = ['proposal', 'objection', 'question', 'answer', 'support', 'comment', 'withdrawal', 'correction', 'decision', 'pass'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** What each kind may reply to (parentId). `null` = no parent allowed; listed kinds = parent required and of that kind. */
export const PARENT_RULES: Record<MessageKind, 'none' | 'optional' | readonly MessageKind[]> = {
  proposal: 'optional',
  objection: ['proposal'],
  question: 'optional',
  answer: ['question'],
  support: ['proposal'],
  comment: 'optional',
  /** Only the author's own proposal or objection; the original stays in the history. */
  withdrawal: ['proposal', 'objection'],
  /** Only the author's own message; corrections append, they never rewrite. */
  correction: MESSAGE_KINDS.filter((k) => k !== 'correction' && k !== 'pass' && k !== 'decision'),
  decision: 'none',
  pass: 'none',
};

/**
 * A decision records an outcome over proposals. It is strict on purpose: there is no field through which a discussion
 * could authorize a repair, change a task, widen a file scope or grant a provider. Those stay operator actions in the
 * lifecycle and scheduler (LifecycleStore.authorize, AGENTIC_ALLOW_PROVIDERS), which never read this record.
 */
export const decisionPayloadSchema = z
  .object({
    outcome: z.enum(['accept', 'reject', 'defer']),
    proposalIds: z.array(idSchema).min(1).max(10),
    rationale: z.string().min(1).max(4_000),
    actionItems: z
      .array(z.object({ owner: idSchema, description: z.string().min(1).max(1_000) }).strict())
      .max(COLLABORATION_CEILINGS.maxActionItems)
      .default([]),
  })
  .strict();
export type DecisionPayload = z.output<typeof decisionPayloadSchema>;

export interface MessageView {
  id: string;
  seq: number;
  threadId: string;
  sessionId: string | null;
  round: number | null;
  turn: number | null;
  at: number;
  author: ParticipantIdentity;
  parentId: string | null;
  kind: MessageKind;
  body: string;
  refs: WorkRef;
  evidence: EvidenceRef[];
  invocation: InvocationRef | null;
  decision: DecisionPayload | null;
  /** Ids of later corrections and withdrawals that target this message (derived on replay; the message itself is unchanged). */
  correctedBy: string[];
  withdrawnBy: string | null;
}

// ---- threads and sessions --------------------------------------------------------------------------------------

export interface ThreadInfo {
  id: string;
  title: string;
  refs: WorkRef;
  participants: ParticipantIdentity[];
  createdBy: ParticipantIdentity;
  createdAt: number;
}

export const sessionLimitsSchema = z
  .object({
    maxRounds: z.number().int().min(1).max(COLLABORATION_CEILINGS.maxRounds),
    maxInvocations: z.number().int().min(1).max(COLLABORATION_CEILINGS.maxInvocations),
    /** Optional token budget. With one, a turn whose usage is UNKNOWN makes the budget unverifiable and the session stops. */
    maxTokens: z.number().int().min(1).max(COLLABORATION_CEILINGS.maxTokens).optional(),
  })
  .strict();
export type SessionLimits = z.output<typeof sessionLimitsSchema>;

export const SESSION_OUTCOMES = ['decided', 'unresolved', 'budget_exhausted', 'failed', 'cancelled'] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

export type SessionStatus = 'open' | 'concluded' | 'cancelled';

export interface PendingTurn {
  round: number;
  turn: number;
  participant: string;
  attempt: number;
  epoch: number;
  seq: number;
}

export type TurnOutcome = 'message' | 'rejected' | 'failed' | 'abandoned';

export interface TurnLogEntry {
  round: number;
  turn: number;
  participant: string;
  attempt: number;
  outcome: TurnOutcome;
  seq: number;
  messageId: string | null;
  kind: MessageKind | null;
  reason: string | null;
}

export interface SessionState {
  id: string;
  threadId: string;
  agenda: string[];
  /** Turn order: participant ids, chair included. */
  participants: string[];
  chair: string;
  limits: SessionLimits;
  openedBy: string;
  openedAt: number;
  status: SessionStatus;
  owner: string | null;
  epoch: number;
  suspended: boolean;
  /** Next turn to reserve (1-based round, 0-based turn index). round > limits.maxRounds means every round is spent. */
  next: { round: number; turn: number };
  pending: PendingTurn | null;
  invocationsUsed: number;
  /** Sum of input+output tokens over the session's invocations; UNKNOWN as soon as one invocation did not report usage. */
  tokensUsed: Measured<number>;
  turns: TurnLogEntry[];
  outcome: { outcome: SessionOutcome; reason: string; seq: number } | null;
}

/** Coordinator's fencing token, as in the scheduler: every write in a session presents (owner, epoch). */
export interface SessionFence {
  owner: string;
  epoch: number;
}

export class CollaborationError extends Error {
  code:
    | 'not_found'
    | 'duplicate'
    | 'invalid'
    | 'unauthorized'
    | 'stale'
    | 'not_your_turn'
    | 'session_closed'
    | 'budget_exhausted'
    | 'idempotency_conflict'
    | 'corrupt';
  constructor(code: CollaborationError['code'], message: string) {
    super(message);
    this.name = 'CollaborationError';
    this.code = code;
  }
}

import { z } from 'zod';

// PRESENTATION DTO. Core B owns persistence and event contracts; the Gateway adapter
// (src/integrations/control-center/collaboration-adapter.ts) maps its records into this shape.
const id = z.string().min(1);
const time = z.string().datetime().nullable();
const ref = z.object({ label: z.string(), url: z.string().nullable() });
const participant = z.object({ id, name: z.string(), role: z.string(), provider: z.string().nullable().default(null), model: z.string().nullable().default(null) });
const message = z.object({
  id, threadId: id, authorId: id, at: time,
  /** Core B's global event sequence number: the message's position in the persisted, hash-chained log. */
  seq: z.number().int().nonnegative().nullable().default(null),
  type: z.enum(['PROPOSAL', 'QUESTION', 'OBJECTION', 'RESPONSE', 'DECISION', 'ANSWER', 'SUPPORT', 'COMMENT', 'WITHDRAWAL', 'CORRECTION', 'PASS']),
  text: z.string(), replyTo: id.nullable(), references: z.array(ref),
  invocationId: id.nullable(), traceUrl: z.string().nullable(),
  /** The Mastra trace id the invocation reported (an id to look up, not a link). */
  traceId: z.string().nullable().default(null),
  objectionState: z.enum(['OPEN', 'RESOLVED', 'WITHDRAWN', 'UNKNOWN']).nullable(),
  /** Corrections and withdrawals append; the original message is never rewritten. */
  correctedBy: z.array(id).default([]), withdrawnBy: id.nullable().default(null),
});
const usage = z.object({ inputTokens: z.number().nonnegative().nullable(), outputTokens: z.number().nonnegative().nullable(), source: z.string(), completeness: z.enum(['complete', 'partial', 'unavailable']) });
const attributed = z.object({ text: z.string(), messageIds: z.array(id).min(1) });
export const collaborationSchema = z.object({
  availability: z.enum(['NOT_AVAILABLE', 'AVAILABLE', 'CORRUPT']),
  source: z.enum(['unavailable', 'core', 'test-fixture']),
  reason: z.string().nullable(),
  cursor: z.number().int().nonnegative().nullable().default(null),
  threads: z.array(z.object({
    id, title: z.string(), objectiveId: id.nullable(), taskId: id.nullable(), participants: z.array(participant), messages: z.array(message),
    /** Authored by configured fake (scripted) identities: persisted, but never live model output. */
    synthetic: z.boolean().default(false),
  })),
  meetings: z.array(z.object({
    id, title: z.string(), threadId: id, agenda: z.array(z.string()), participants: z.array(participant),
    startedAt: time, endedAt: time,
    rounds: z.array(z.object({ id, number: z.number().int().nonnegative(), state: z.string(), messageIds: z.array(id) })),
    roundLimit: z.number().int().nonnegative().nullable(), invocationLimit: z.number().int().nonnegative().nullable(),
    invocationsUsed: z.number().int().nonnegative().nullable(), budgetExhausted: z.boolean().nullable(),
    agreements: z.array(attributed), disagreements: z.array(attributed), decisions: z.array(attributed),
    actions: z.array(attributed.extend({ id, ownerId: id.nullable(), state: z.string().nullable() })),
    references: z.array(ref), usage,
    status: z.string().nullable().default(null), outcome: z.string().nullable().default(null), reason: z.string().nullable().default(null),
    objections: z.array(attributed.extend({ id, status: z.string() })).default([]),
    tokensUsed: z.number().nonnegative().nullable().default(null),
    /** The meeting record's coverage of the event log; null while the session is open (no record exists yet). */
    provenance: z.object({ throughSeq: z.number().int().nonnegative(), throughHash: z.string(), recordHash: z.string(), messageCount: z.number().int().nonnegative() }).nullable().default(null),
    /** Council meetings only: what the council recorded, shown only after it cross-checked against the verified events. */
    council: z.object({
      meetingId: id, mode: z.enum(['LIVE', 'SCRIPTED']), model: z.string(), recordPath: z.string(),
      workflowRuns: z.array(z.object({ runId: id, url: z.string() })), traceIds: z.array(z.string()),
      modelCalls: z.number().int().nonnegative().nullable(), failedCalls: z.number().int().nonnegative().nullable(),
      toolCalls: z.array(z.object({ tool: z.string(), count: z.number().int().nonnegative() })).nullable(),
      /** RECORD_VERIFIED: runs/calls/traces come from an intact council record matching the verified events. OPEN_UNRECORDED: none yet. */
      integrity: z.enum(['RECORD_VERIFIED', 'OPEN_UNRECORDED']),
    }).nullable().default(null),
    /** Why the council's own claims are not shown for this meeting (missing or mismatching council record). */
    councilIssue: z.string().nullable().default(null),
  })),
});
export type Collaboration = z.infer<typeof collaborationSchema>;
/** What the Gateway sends (fields with defaults may be absent). */
export type CollaborationInput = z.input<typeof collaborationSchema>;
export type Thread = Collaboration['threads'][number];

export function safeReference(value: string | null): string | null {
  if (!value) return null;
  // No script, data, protocol-relative links, credentials or arbitrary relative paths.
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return value;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function orderedMessages(thread: Thread) {
  const unique = new Map(thread.messages.filter(m => m.threadId === thread.id).map(m => [m.id, m]));
  return [...unique.values()].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.id.localeCompare(b.id));
}

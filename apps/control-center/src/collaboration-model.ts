import { z } from 'zod';

// Proposed PRESENTATION DTO only. Core B owns persistence and event contracts.
const id = z.string().min(1);
const time = z.string().datetime().nullable();
const ref = z.object({ label: z.string(), url: z.string() });
const participant = z.object({ id, name: z.string(), role: z.string() });
const message = z.object({
  id, threadId: id, authorId: id, at: time,
  type: z.enum(['PROPOSAL', 'QUESTION', 'OBJECTION', 'RESPONSE', 'DECISION']),
  text: z.string(), replyTo: id.nullable(), references: z.array(ref),
  invocationId: id.nullable(), traceUrl: z.string().nullable(),
  objectionState: z.enum(['OPEN', 'RESOLVED', 'UNKNOWN']).nullable(),
});
const usage = z.object({ inputTokens: z.number().nonnegative().nullable(), outputTokens: z.number().nonnegative().nullable(), source: z.string(), completeness: z.enum(['complete', 'partial', 'unavailable']) });
const attributed = z.object({ text: z.string(), messageIds: z.array(id).min(1) });
export const collaborationSchema = z.object({
  availability: z.enum(['NOT_AVAILABLE', 'AVAILABLE']),
  source: z.enum(['unavailable', 'core', 'test-fixture']),
  reason: z.string().nullable(),
  threads: z.array(z.object({ id, title: z.string(), objectiveId: id.nullable(), taskId: id.nullable(), participants: z.array(participant), messages: z.array(message) })),
  meetings: z.array(z.object({
    id, title: z.string(), threadId: id, agenda: z.array(z.string()), participants: z.array(participant),
    startedAt: time, endedAt: time,
    rounds: z.array(z.object({ id, number: z.number().int().nonnegative(), state: z.string(), messageIds: z.array(id) })),
    roundLimit: z.number().int().nonnegative().nullable(), invocationLimit: z.number().int().nonnegative().nullable(),
    invocationsUsed: z.number().int().nonnegative().nullable(), budgetExhausted: z.boolean().nullable(),
    agreements: z.array(attributed), disagreements: z.array(attributed), decisions: z.array(attributed),
    actions: z.array(attributed.extend({ id, ownerId: id.nullable(), state: z.string().nullable() })),
    references: z.array(ref), usage,
  })),
});
export type Collaboration = z.infer<typeof collaborationSchema>;
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

import { z } from 'zod';

// PRESENTATION DTO for meeting suggestions (src/integrations/control-center/suggestions-adapter.ts). A suggestion is advisory: it
// is never a meeting, so it has its own schema and is never mixed into the meetings list. `kind` is a literal to keep it that way.
const id = z.string().min(1);
const attribution = z.object({ status: z.enum(['ATTRIBUTED', 'UNATTRIBUTED']), batchId: id.nullable(), project: z.string().nullable(), reason: z.string().nullable() });
export const suggestionsSchema = z.object({
  availability: z.enum(['AVAILABLE', 'NOT_AVAILABLE', 'CORRUPT']),
  reason: z.string().nullable(),
  pending: z.number().int().nonnegative(),
  suggestions: z.array(z.object({
    kind: z.literal('suggestion'),
    id, status: z.enum(['pending', 'accepted', 'dismissed']),
    meetingType: z.string(), category: z.string(),
    objectiveId: id.nullable(), batchId: id, taskId: id.nullable(),
    attribution,
    reason: z.string(),
    evidence: z.array(z.object({ kind: z.string(), ref: z.string(), detail: z.string() })),
    participants: z.array(z.object({ id, role: z.string(), note: z.string() })),
    createdAt: z.string(), decidedAt: z.string().nullable(), decidedBy: z.string().nullable(), decisionReason: z.string().nullable(),
    sessionId: id.nullable(),
  })),
});
export type Suggestions = z.infer<typeof suggestionsSchema>;
export type Suggestion = Suggestions['suggestions'][number];

/** Pending first (oldest first: the longest waiting), then decided ones, newest decision first. */
export function orderSuggestions(items: readonly Suggestion[]): Suggestion[] {
  const pending = items.filter((s) => s.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const decided = items.filter((s) => s.status !== 'pending').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
  return [...pending, ...decided];
}

export const MEETING_TYPE_LABEL: Record<string, string> = {
  technical_escalation: 'Technical escalation',
  review_escalation: 'Review escalation',
  integration_failure: 'Integration failure',
  acceptance_failure: 'Acceptance failure',
};

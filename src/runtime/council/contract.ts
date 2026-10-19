/**
 * Engineering Council contracts (M11.x). A council is ONE meeting session on the M9 collaboration store with exactly three
 * read-only specialists and a fixed shape:
 *
 *   round 1  independent proposals   (blind: nobody sees another round-1 message)         -> `proposal`
 *   round 2  one bounded critique each: object to, or support, one OTHER proposal         -> `objection` | `support`
 *   round 3  synthesis by the chair: a PROPOSED decision with disagreements and unknowns  -> `decision` (authority: none)
 *
 * Every model reply is parsed against a strict schema below; anything else is a failed turn, never a guessed one. Nothing in a
 * council can adopt an ADR, change a file, approve or merge: the decision is a record and a human adopts it.
 */
import { z } from 'zod';

export const COUNCIL_RECORD_SCHEMA = 'agentic.council-record/1';

export const COUNCIL_LIMITS = Object.freeze({
  seats: 3,
  /** proposal, critique, synthesis. Fixed: the shape of the council is part of its contract. */
  rounds: 3,
  /** A READ-ONLY specialist whose reply is malformed is re-asked at most this many times (no side effect can repeat). */
  maxReasks: 1,
  maxQuestionChars: 1_500,
  /** Per-seat model calls in one meeting: three turns, one re-ask each is the worst case that is allowed to happen. */
  maxModelCallsPerSeat: 4,
  maxTokensPerSeat: 40_000,
  maxSteps: 8,
});

export type CouncilPhase = 'proposal' | 'critique' | 'synthesis';
export const phaseOfRound = (round: number): CouncilPhase => (round <= 1 ? 'proposal' : round === 2 ? 'critique' : 'synthesis');

const text = (max: number) => z.string().trim().min(1).max(max);
const repoPath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && !p.split('/').includes('..'), 'must be a repository-relative path without ..');

export const proposalSchema = z
  .object({
    position: text(400).describe('Your recommendation in one or two sentences.'),
    rationale: text(1_400),
    risks: z.array(z.object({ risk: text(300), mitigation: text(300).optional() }).strict()).max(5).default([]),
    /** Repository-relative files you actually read or searched. Not a list of files you wish existed. */
    evidence: z.array(repoPath).max(8).default([]),
    unknowns: z.array(text(300)).max(5).default([]),
  })
  .strict();
export type Proposal = z.output<typeof proposalSchema>;

export const critiqueSchema = z
  .object({
    stance: z.enum(['object', 'support']),
    /** Message id of ONE proposal written by another seat. */
    targetProposalId: z.string().trim().min(1).max(64),
    critique: text(1_400),
    evidence: z.array(repoPath).max(8).default([]),
    concessions: z.array(text(300)).max(4).default([]),
  })
  .strict();
export type Critique = z.output<typeof critiqueSchema>;

export const synthesisSchema = z
  .object({
    outcome: z.enum(['accept', 'reject', 'defer']),
    adoptedProposalId: z.string().trim().min(1).max(64),
    /** The proposed engineering decision, as a statement a human can adopt or reject as an ADR. */
    decision: text(800),
    rationale: text(1_400),
    disagreements: z
      .array(z.object({ between: z.array(text(120)).min(1).max(3), issue: text(300), status: z.enum(['resolved', 'accepted-tradeoff', 'unresolved']), note: text(300).optional() }).strict())
      .max(6)
      .default([]),
    /** What the council could not establish. An empty list means the chair stated none, and the record says exactly that. */
    uncertainties: z.array(text(300)).max(6).default([]),
    actionItems: z.array(text(300)).max(5).default([]),
  })
  .strict();
export type Synthesis = z.output<typeof synthesisSchema>;

export type ParsedReply<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Every balanced top-level `{...}` span, in order; tolerates prose, code fences, <think> blocks and stray braces. */
function* objectCandidates(source: string): Generator<string> {
  let i = 0;
  while (i < source.length) {
    const start = source.indexOf('{', i);
    if (start < 0) return;
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let j = start; j < source.length; j++) {
      const c = source[j]!;
      if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = j; break; }
    }
    if (end < 0) return;
    yield source.slice(start, end + 1);
    i = end + 1;
  }
}

/** Strict parse of a model reply. Never throws. The first schema violation is reported so a re-ask can name it. */
export function parseCouncilReply<T>(raw: unknown, schema: z.ZodType<T>, maxBytes = 16_000): ParsedReply<T> {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty output' };
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) return { ok: false, reason: `output exceeds ${maxBytes} bytes` };
  const source = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  let first: string | undefined;
  let sawObject = false;
  for (const candidate of objectCandidates(source)) {
    sawObject = true;
    let value: unknown;
    try { value = JSON.parse(candidate); } catch { first ??= 'output is not valid JSON'; continue; }
    const parsed = schema.safeParse(value);
    if (parsed.success) return { ok: true, value: parsed.data };
    const issue = parsed.error.issues[0];
    first ??= `schema violation at ${issue?.path.join('.') || '<root>'}: ${issue?.message}`;
  }
  return { ok: false, reason: sawObject ? first! : 'no JSON object in output' };
}

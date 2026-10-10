import type { Measured } from '../execution/worker-provider.ts';
import { canonicalJson, sha256 } from './events.ts';
import type { ThreadState } from './replay.ts';
import { MEETING_RECORD_SCHEMA, type ParticipantIdentity, type MessageView, type PendingTurn, type SessionLimits, type SessionOutcome, type SessionState, type TurnLogEntry, type WorkRef } from './types.ts';

/**
 * A meeting record is derived, deterministically, from the session's events: it is an index over contributions that exist,
 * never a model-written summary. Every entry links back to the event (seq) and message it came from, and the record names
 * the last event it covers and that event's chain hash, so it can be checked against the thread at any time.
 *
 * It does not invent consensus:
 *  - an agreement is an explicit `support` message, never silence; `unanimous` needs a support from every other participant
 *    and no outstanding objection;
 *  - an objection is resolved only by its own author's withdrawal; a decision over it is `contested` and the objection is
 *    listed as overruled AND still under `unresolved`;
 *  - an unanswered question, a proposal nobody decided and a deferred proposal are `unresolved`.
 */

export interface Source {
  seq: number;
  messageId: string;
}

export interface MeetingRecord {
  schema: typeof MEETING_RECORD_SCHEMA;
  sessionId: string;
  threadId: string;
  title: string;
  refs: WorkRef;
  agenda: string[];
  chair: string;
  participants: ParticipantIdentity[];
  limits: SessionLimits;
  usage: { roundsStarted: number; invocations: number; tokens: Measured<number> };
  outcome: SessionOutcome;
  reason: string;
  alternatives: { id: string; author: string; body: string; status: 'open' | 'withdrawn' | 'accepted' | 'rejected' | 'deferred'; supporters: string[]; outstandingObjections: string[]; correctedBy: string[]; source: Source }[];
  objections: { id: string; author: string; target: string; body: string; status: 'outstanding' | 'withdrawn'; source: Source }[];
  questions: { id: string; author: string; body: string; status: 'answered' | 'unanswered'; answers: string[]; source: Source }[];
  agreements: { proposalId: string; supporters: string[]; unanimous: boolean; sources: Source[] }[];
  decisions: { id: string; decider: string; outcome: 'accept' | 'reject' | 'defer'; proposalIds: string[]; rationale: string; contested: boolean; overruledObjections: string[]; authority: 'none'; source: Source }[];
  actionItems: { decisionId: string; owner: string; description: string; source: Source }[];
  unresolved: { kind: 'objection' | 'question' | 'proposal'; id: string; detail: string; source: Source }[];
  corrections: { id: string; author: string; target: string; body: string; source: Source }[];
  turns: TurnLogEntry[];
  /** A turn that was reserved (and charged) but never answered when the session ended: cancelled mid-turn. */
  pendingAtEnd: PendingTurn | null;
  provenance: { throughSeq: number; throughHash: string; messageSeqs: number[] };
  recordHash: string;
}

const src = (m: MessageView): Source => ({ seq: m.seq, messageId: m.id });

export function buildMeetingRecord(state: ThreadState, s: SessionState, outcome: { outcome: SessionOutcome; reason: string }): MeetingRecord {
  const inSession = state.messages.filter((m) => m.sessionId === s.id);
  const byId = state.byId;
  const children = (id: string, kind: MessageView['kind']) => state.messages.filter((m) => m.parentId === id && m.kind === kind && m.sessionId === s.id);
  /** A withdrawal counts at time `seq` only if it came before it. */
  const withdrawnBefore = (m: MessageView, seq: number) => m.withdrawnBy !== null && byId.get(m.withdrawnBy)!.seq < seq;

  // Proposals in play: made in this session, or referenced by anything said in it.
  const proposalIds = new Set<string>();
  for (const m of inSession) {
    if (m.kind === 'proposal') proposalIds.add(m.id);
    if (m.parentId && byId.get(m.parentId)?.kind === 'proposal') proposalIds.add(m.parentId);
    for (const id of m.decision?.proposalIds ?? []) proposalIds.add(id);
  }
  const proposals = [...proposalIds].map((id) => byId.get(id)!).sort((a, b) => a.seq - b.seq);
  const decisions = inSession.filter((m) => m.kind === 'decision');
  const objectionsOf = (pid: string) => children(pid, 'objection');
  const END = Number.MAX_SAFE_INTEGER;

  const alternatives = proposals.map((p) => {
    const last = [...decisions].reverse().find((d) => d.decision!.proposalIds.includes(p.id));
    const status: MeetingRecord['alternatives'][number]['status'] = p.withdrawnBy ? 'withdrawn' : last ? ({ accept: 'accepted', reject: 'rejected', defer: 'deferred' } as const)[last.decision!.outcome] : 'open';
    return {
      id: p.id,
      author: p.author.id,
      body: p.body,
      status,
      supporters: [...new Set(children(p.id, 'support').map((m) => m.author.id))].sort(),
      outstandingObjections: objectionsOf(p.id).filter((o) => !withdrawnBefore(o, END)).map((o) => o.id),
      correctedBy: p.correctedBy,
      source: src(p),
    };
  });

  const objections = inSession
    .filter((m) => m.kind === 'objection')
    .map((o) => ({ id: o.id, author: o.author.id, target: o.parentId!, body: o.body, status: (o.withdrawnBy ? 'withdrawn' : 'outstanding') as 'outstanding' | 'withdrawn', source: src(o) }));

  const questions = inSession
    .filter((m) => m.kind === 'question')
    .map((q) => {
      const answers = children(q.id, 'answer').map((a) => a.id);
      return { id: q.id, author: q.author.id, body: q.body, status: (answers.length ? 'answered' : 'unanswered') as 'answered' | 'unanswered', answers, source: src(q) };
    });

  const agreements = proposals
    .map((p) => {
      const supports = children(p.id, 'support');
      const supporters = [...new Set(supports.map((m) => m.author.id))].sort();
      const others = s.participants.filter((id) => id !== p.author.id);
      const outstanding = objectionsOf(p.id).some((o) => !withdrawnBefore(o, END));
      return { proposalId: p.id, supporters, unanimous: !p.withdrawnBy && !outstanding && others.length > 0 && others.every((id) => supporters.includes(id)), sources: supports.map(src) };
    })
    .filter((a) => a.supporters.length > 0);

  const decisionEntries = decisions.map((d) => {
    const overruled = d.decision!.proposalIds.flatMap((pid) => objectionsOf(pid).filter((o) => o.seq < d.seq && !withdrawnBefore(o, d.seq)).map((o) => o.id));
    return { id: d.id, decider: d.author.id, outcome: d.decision!.outcome, proposalIds: d.decision!.proposalIds, rationale: d.decision!.rationale, contested: overruled.length > 0, overruledObjections: overruled, authority: 'none' as const, source: src(d) };
  });

  const actionItems = decisions.flatMap((d) => d.decision!.actionItems.map((a) => ({ decisionId: d.id, owner: a.owner, description: a.description, source: src(d) })));

  const unresolved: MeetingRecord['unresolved'] = [
    ...objections.filter((o) => o.status === 'outstanding').map((o) => ({ kind: 'objection' as const, id: o.id, detail: `${o.author} objects to ${o.target}`, source: o.source })),
    ...questions.filter((q) => q.status === 'unanswered').map((q) => ({ kind: 'question' as const, id: q.id, detail: `${q.author} asked; no answer`, source: q.source })),
    ...alternatives.filter((a) => a.status === 'open' || a.status === 'deferred').map((a) => ({ kind: 'proposal' as const, id: a.id, detail: a.status === 'deferred' ? `${a.author}'s proposal was deferred` : `${a.author}'s proposal was not decided`, source: a.source })),
  ].sort((a, b) => a.source.seq - b.source.seq);

  const corrections = inSession.filter((m) => m.kind === 'correction').map((c) => ({ id: c.id, author: c.author.id, target: c.parentId!, body: c.body, source: src(c) }));

  const participants = s.participants.map((id) => state.thread.participants.find((p) => p.id === id)!);
  const roundsStarted = s.turns.length ? Math.max(...s.turns.map((t) => t.round)) : 0;

  const body: Omit<MeetingRecord, 'recordHash'> = {
    schema: MEETING_RECORD_SCHEMA,
    sessionId: s.id,
    threadId: s.threadId,
    title: state.thread.title,
    refs: state.thread.refs,
    agenda: s.agenda,
    chair: s.chair,
    participants,
    limits: s.limits,
    usage: { roundsStarted, invocations: s.invocationsUsed, tokens: s.tokensUsed },
    outcome: outcome.outcome,
    reason: outcome.reason,
    alternatives,
    objections,
    questions,
    agreements,
    decisions: decisionEntries,
    actionItems,
    unresolved,
    corrections,
    turns: s.turns,
    pendingAtEnd: s.pending,
    provenance: { throughSeq: state.lastSeq, throughHash: state.lastHash, messageSeqs: inSession.map((m) => m.seq) },
  };
  return { ...body, recordHash: sha256(canonicalJson(body)) };
}

/** Recomputes a stored record's hash: true when it is the record its fields describe. */
export function recordIntact(record: MeetingRecord): boolean {
  const { recordHash, ...body } = record;
  return sha256(canonicalJson(body)) === recordHash;
}

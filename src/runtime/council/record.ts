import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { MeetingRecord } from '../collaboration/record.ts';
import type { ThreadState } from '../collaboration/replay.ts';
import type { MessageView, SessionOutcome, SessionState } from '../collaboration/types.ts';
import { hashValue } from '../knowledge/canonical.ts';
import { COUNCIL_LIMITS, COUNCIL_RECORD_SCHEMA, critiqueSchema, phaseOfRound, proposalSchema, synthesisSchema, type CouncilPhase } from './contract.ts';
import type { CallEntry } from './journal.ts';
import type { ModelIdentity, PanelSeat } from './panel.ts';

/**
 * The per-meeting record. Everything in it is derived from two durable sources: the hash-chained collaboration events (what was
 * said, by whom, when, in which turn) and the call journal (what each model call was). No model writes any field of it, and
 * nothing is filled in to look complete: a phase that did not happen is absent, a count that is unknown is `UNKNOWN`.
 */

export type CouncilMode = 'SCRIPTED' | 'LIVE';

export interface CouncilSidecar {
  schema: 'agentic.council-sidecar/1';
  meetingId: string;
  threadId: string;
  sessionId: string;
  mode: CouncilMode;
  question: string;
  focusPaths: string[];
  repository: string;
  language: string;
  panel: PanelSeat[];
  model: ModelIdentity;
  limits: { maxInvocations: number; maxTokens?: number; maxModelCallsPerSeat: number; maxTokensPerSeat: number; callTimeoutMs: number; turnTimeoutMs: number };
  openedAt: number;
}

interface Parsed<T> { ok: boolean; value?: T; raw?: string }
function parseBody<T>(m: MessageView, schema: { safeParse(v: unknown): { success: boolean; data?: T } }): Parsed<T> {
  try {
    const r = schema.safeParse(JSON.parse(m.body));
    return r.success ? { ok: true, value: r.data } : { ok: false, raw: m.body };
  } catch { return { ok: false, raw: m.body }; }
}

export interface CouncilRecord {
  schema: typeof COUNCIL_RECORD_SCHEMA;
  meetingId: string;
  threadId: string;
  sessionId: string;
  mode: CouncilMode;
  /** The literal true: a council is input to a human decision, never a decision. */
  advisory: true;
  question: string;
  focusPaths: readonly string[];
  panel: readonly (Omit<PanelSeat, 'guidance' | 'handoff' | 'responsibility'> & { provider: string; model: string })[];
  outcome: SessionOutcome;
  reason: string;
  rounds: readonly { round: number; phase: CouncilPhase; turns: readonly CouncilTurn[] }[];
  proposals: readonly { messageId: string; specialistId: string; at: number; proposal: unknown; evidence: readonly EvidenceCheck[]; fileToolCallsThisTurn: number | null }[];
  critiques: readonly { messageId: string; specialistId: string; at: number; stance: 'object' | 'support'; targetMessageId: string; targetSpecialistId: string | null; critique: unknown; evidence: readonly EvidenceCheck[]; fileToolCallsThisTurn: number | null }[];
  synthesis: null | { messageId: string; specialistId: string; at: number; synthesis: unknown; recorded: { outcome: string; adoptedProposalId: string; contested: boolean; overruledObjections: readonly string[]; authority: 'none' } };
  disagreements: {
    /** Objections the members raised, with whether their author withdrew them. Derived from the event stream. */
    objections: readonly { messageId: string; by: string; against: string; status: 'outstanding' | 'withdrawn' }[];
    /** Disagreements the chair listed in its synthesis. A chair claim; compare with `objections`. */
    declaredByChair: readonly unknown[];
    /** True when at least one objection was raised. When false the record says no disagreement was raised and invents none. */
    raised: boolean;
  };
  humanApproval: { required: true; status: 'pending'; note: string };
  accounting: {
    turnsReserved: number;
    turnsRecorded: number;
    modelCalls: number;
    reasks: number;
    invalidReplies: number;
    failedCalls: number;
    tokens: { input: number | 'UNKNOWN'; output: number | 'UNKNOWN' };
    limits: { maxRounds: number; maxInvocations: number; maxTokens: number | null; maxModelCallsPerSeat: number; maxReasks: number };
  };
  /** Mastra workflow run(s) that drove this meeting: more than one when it was resumed. Open each in Studio by run id. */
  workflowRuns: readonly { runId: string; at: number }[];
  calls: readonly CallEntry[];
  timestamps: { openedAt: number; firstMessageAt: number | null; lastMessageAt: number | null; recordedAt: number };
  integrity: { meetingRecordHash: string; throughSeq: number; throughHash: string; recordHash: string };
  limitations: readonly string[];
}

export interface EvidenceCheck {
  /** Repository-relative path the member cited. */
  path: string;
  /** Whether it is a file inside the repository now. A cited path that does not exist is a fabricated citation. */
  exists: boolean;
}

/** Deterministic and read-only: realpath containment, no content read. */
export function checkEvidence(repository: string, paths: readonly string[]): EvidenceCheck[] {
  let root: string;
  try { root = realpathSync(repository); } catch { return paths.map((path) => ({ path, exists: false })); }
  return paths.map((path) => {
    try {
      const full = realpathSync(resolve(root, path));
      return { path, exists: (full === root || full.startsWith(root + sep)) && statSync(full).isFile() };
    } catch { return { path, exists: false }; }
  });
}

export interface CouncilTurn {
  participantId: string;
  specialistId: string;
  outcome: string;
  kind: string | null;
  messageId: string | null;
  attempt: number;
  at: number | null;
  runId: string | null;
  traceId: string | null;
  inputTokens: number | 'UNKNOWN' | null;
  outputTokens: number | 'UNKNOWN' | null;
  inferenceMs: number | 'UNKNOWN' | null;
  reason: string | null;
}

export function limitationsFor(mode: CouncilMode): string[] {
  return [
    ...(mode === 'SCRIPTED' ? ['SCRIPTED: the replies are canned by the test model. This record proves wiring, rules and persistence, not what any model would say.'] : ['LIVE: a local model produced these replies. Quality is whatever the model produced; nothing here was edited.']),
    'The meeting is durable (hash-chained events in the council database) and resumable; the Mastra workflow run that wrapped it is not. A server restart loses the workflow run, not the meeting.',
    'Critique is bounded to one target per member (one message per turn). A member may disagree with more than one proposal in the text, but only one is linked.',
    'Specialists are advisory and read-only. The proposed decision has no authority: adopting an ADR or acting on it is a human step.',
  ];
}

export function buildCouncilRecord(input: {
  sidecar: CouncilSidecar;
  thread: ThreadState;
  session: SessionState;
  meeting: MeetingRecord;
  calls: readonly CallEntry[];
  workflowRuns?: readonly { runId: string; at: number }[];
  now: number;
}): CouncilRecord {
  const { sidecar, thread, session, meeting, calls } = input;
  const bySeat = new Map(sidecar.panel.map((s) => [s.participantId, s]));
  const spec = (participantId: string) => bySeat.get(participantId)?.specialistId ?? participantId;
  const mine = thread.messages.filter((m) => m.sessionId === session.id);
  const messageOf = new Map(mine.map((m) => [m.id, m]));

  const callAt = new Map<string, CallEntry>();
  for (const c of calls) if (c.outcome === 'accepted') callAt.set(`${c.participantId}|${c.round}|${c.turn}`, c);
  const FILE_TOOLS = new Set(['readFile', 'searchFiles', 'listFiles']);
  /** File-inspection tool calls in the accepted call that produced this message; null when no call is on record (e.g. a resumed record). */
  const fileCalls = (m: MessageView): number | null => {
    const c = callAt.get(`${m.author.id}|${m.round}|${m.turn}`);
    return c ? c.toolCalls.filter((t) => FILE_TOOLS.has(t.tool)).reduce((n, t) => n + t.count, 0) : null;
  };
  const cited = (m: MessageView): EvidenceCheck[] => checkEvidence(sidecar.repository, m.evidence.filter((e) => e.kind === 'file').map((e) => e.ref));
  const proposals = mine.filter((m) => m.kind === 'proposal').map((m) => ({ messageId: m.id, specialistId: spec(m.author.id), at: m.at, proposal: parseBody(m, proposalSchema).value ?? { unparsed: m.body }, evidence: cited(m), fileToolCallsThisTurn: fileCalls(m) }));
  const critiques = mine.filter((m) => m.kind === 'objection' || m.kind === 'support').map((m) => ({
    messageId: m.id, specialistId: spec(m.author.id), at: m.at, stance: (m.kind === 'objection' ? 'object' : 'support') as 'object' | 'support', targetMessageId: m.parentId!,
    targetSpecialistId: messageOf.get(m.parentId!) ? spec(messageOf.get(m.parentId!)!.author.id) : null, critique: parseBody(m, critiqueSchema).value ?? { unparsed: m.body }, evidence: cited(m), fileToolCallsThisTurn: fileCalls(m),
  }));
  const decisionMsg = mine.find((m) => m.kind === 'decision');
  const decisionRec = decisionMsg ? meeting.decisions.find((d) => d.id === decisionMsg.id) : undefined;
  const synthesisValue = decisionMsg ? parseBody(decisionMsg, synthesisSchema).value : undefined;
  const synthesis = decisionMsg && decisionRec ? {
    messageId: decisionMsg.id, specialistId: spec(decisionMsg.author.id), at: decisionMsg.at, synthesis: synthesisValue ?? { unparsed: decisionMsg.body },
    recorded: { outcome: decisionRec.outcome, adoptedProposalId: decisionRec.proposalIds[0]!, contested: decisionRec.contested, overruledObjections: decisionRec.overruledObjections, authority: decisionRec.authority },
  } : null;

  const turnRows: CouncilTurn[] = session.turns.map((t) => {
    const msg = t.messageId ? messageOf.get(t.messageId) : undefined;
    const call = callAt.get(`${t.participant}|${t.round}|${t.turn}`);
    const inv = msg?.invocation ?? null;
    return {
      participantId: t.participant, specialistId: spec(t.participant), outcome: t.outcome, kind: t.kind, messageId: t.messageId, attempt: t.attempt, at: msg?.at ?? null,
      runId: inv?.runId ?? call?.runId ?? null, traceId: inv?.traceId ?? call?.traceId ?? null,
      inputTokens: inv ? inv.usage.inputTokens : null, outputTokens: inv ? inv.usage.outputTokens : null, inferenceMs: inv ? inv.inferenceMs : null, reason: t.reason,
    };
  });
  const rounds = [...new Set(turnRows.length ? session.turns.map((t) => t.round) : [])].sort((a, b) => a - b).map((round) => ({
    round, phase: phaseOfRound(round), turns: turnRows.filter((_, i) => session.turns[i]!.round === round),
  }));

  const sum = (pick: (c: CallEntry) => number | null): number | 'UNKNOWN' => {
    let total = 0;
    for (const c of calls) { const v = pick(c); if (v === null) return 'UNKNOWN'; total += v; }
    return total;
  };
  const objections = meeting.objections.map((o) => ({ messageId: o.id, by: spec(o.author), against: o.target, status: o.status }));

  const timestamps = mine.map((m) => m.at);
  const body: Omit<CouncilRecord, 'integrity'> = {
    schema: COUNCIL_RECORD_SCHEMA,
    meetingId: sidecar.meetingId, threadId: sidecar.threadId, sessionId: session.id, mode: sidecar.mode, advisory: true,
    question: sidecar.question, focusPaths: sidecar.focusPaths,
    panel: sidecar.panel.map(({ guidance: _g, handoff: _h, responsibility: _r, ...seat }) => ({ ...seat, provider: sidecar.model.provider, model: sidecar.model.model })),
    outcome: meeting.outcome, reason: meeting.reason,
    rounds, proposals, critiques, synthesis,
    disagreements: { objections, declaredByChair: synthesisValue?.disagreements ?? [], raised: objections.length > 0 },
    humanApproval: { required: true, status: 'pending', note: 'Nothing was adopted. A human must accept or reject this proposed decision (for example as an ADR); no specialist can.' },
    accounting: {
      turnsReserved: session.invocationsUsed, turnsRecorded: session.turns.length,
      modelCalls: calls.length, reasks: calls.filter((c) => c.attempt > 1).length, invalidReplies: calls.filter((c) => c.outcome === 'invalid').length, failedCalls: calls.filter((c) => c.outcome === 'error').length,
      tokens: { input: sum((c) => c.inputTokens), output: sum((c) => c.outputTokens) },
      limits: { maxRounds: session.limits.maxRounds, maxInvocations: session.limits.maxInvocations, maxTokens: session.limits.maxTokens ?? null, maxModelCallsPerSeat: sidecar.limits.maxModelCallsPerSeat, maxReasks: COUNCIL_LIMITS.maxReasks },
    },
    workflowRuns: input.workflowRuns ?? [],
    calls,
    timestamps: { openedAt: sidecar.openedAt, firstMessageAt: timestamps.length ? Math.min(...timestamps) : null, lastMessageAt: timestamps.length ? Math.max(...timestamps) : null, recordedAt: input.now },
    limitations: limitationsFor(sidecar.mode),
  };
  const recordHash = hashValue(body);
  return { ...body, integrity: { meetingRecordHash: meeting.recordHash, throughSeq: meeting.provenance.throughSeq, throughHash: meeting.provenance.throughHash, recordHash } };
}

export function councilRecordIntact(record: CouncilRecord): boolean {
  const { integrity, ...body } = record;
  return hashValue(body) === integrity.recordHash;
}

const iso = (ms: number | null) => (ms === null ? '-' : new Date(ms).toISOString());
const renderEvidence = (ev: readonly EvidenceCheck[], toolCalls: number | null): string => {
  if (!ev.length) return `none cited${toolCalls === 0 ? '; no file tool was used this turn' : ''}`;
  const listed = ev.map((e) => `${e.path} [${e.exists ? 'exists' : 'NOT FOUND'}]`).join(', ');
  const used = toolCalls === null ? 'file-tool use not on record' : toolCalls === 0 ? 'NO file tool was used this turn: the cited files were NOT read by this call' : `${toolCalls} file-tool call(s) this turn`;
  return `${listed}; ${used}`;
};
const one = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const list = (items: readonly unknown[] | undefined, none: string) => (items && items.length ? items.map((i) => `  - ${one(i)}`) : [`  - ${none}`]);

export function renderCouncilRecord(r: CouncilRecord): string {
  const out: string[] = [];
  out.push(`# Engineering Council ${r.meetingId} [${r.mode}]`, '');
  if (r.mode === 'SCRIPTED') out.push('> **SCRIPTED**: canned replies from a test model. Proves wiring and rules, not model quality.', '');
  else out.push('> **LIVE**: replies were produced by the local model named below. Nothing was edited.', '');
  out.push(`- Outcome: **${r.outcome}** (${one(r.reason)})`, `- Advisory only. Human approval: **${r.humanApproval.status}**. ${r.humanApproval.note}`);
  out.push(`- Opened ${iso(r.timestamps.openedAt)}, last message ${iso(r.timestamps.lastMessageAt)}, recorded ${iso(r.timestamps.recordedAt)}`);
  if (r.workflowRuns.length) out.push(`- Mastra workflow run(s): ${r.workflowRuns.map((w) => w.runId).join(', ')}`);
  out.push(`- Integrity: record \`${r.integrity.recordHash.slice(0, 16)}\`, meeting record \`${r.integrity.meetingRecordHash.slice(0, 16)}\`, events through ${r.integrity.throughSeq}`, '');
  out.push('## Question', '', `> ${one(r.question)}`, '');
  out.push('## Panel', '');
  for (const s of r.panel) out.push(`- **${s.name}** (\`${s.specialistId}\` v${s.manifestVersion}, manifest \`${s.manifestDigest.slice(0, 12)}\`)${s.chair ? ' chair' : ''}: ${s.provider}/${s.model}; read-only tools ${s.tools.join(', ')}`);
  out.push('');
  for (const round of r.rounds) {
    out.push(`## Round ${round.round}: ${round.phase}`, '');
    for (const t of round.turns) {
      out.push(`- ${t.specialistId} — ${t.outcome}${t.kind ? ` ${t.kind}` : ''}${t.messageId ? ` ${t.messageId}` : ''}${t.at ? ` at ${iso(t.at)}` : ''}${t.runId ? ` run ${t.runId}` : ''}${t.traceId ? ` trace ${t.traceId}` : ''}${t.reason ? ` — ${one(t.reason)}` : ''}`);
      const p = r.proposals.find((x) => x.messageId === t.messageId);
      if (p) { const v = p.proposal as { position?: string; rationale?: string; risks?: { risk: string }[]; evidence?: string[]; unknowns?: string[] }; out.push(`  - position: ${one(v.position)}`, `  - rationale: ${one(v.rationale)}`, `  - risks: ${(v.risks ?? []).map((x) => one(x.risk)).join('; ') || 'none stated'}`, `  - evidence cited: ${renderEvidence(p.evidence, p.fileToolCallsThisTurn)}`, `  - unknowns: ${(v.unknowns ?? []).join('; ') || 'none stated'}`); }
      const c = r.critiques.find((x) => x.messageId === t.messageId);
      if (c) { const v = c.critique as { critique?: string; evidence?: string[]; concessions?: string[] }; out.push(`  - ${c.stance === 'object' ? 'OBJECTS to' : 'supports'} ${c.targetMessageId} (${c.targetSpecialistId ?? '?'}): ${one(v.critique)}`, `  - evidence cited: ${renderEvidence(c.evidence, c.fileToolCallsThisTurn)}`, ...(v.concessions?.length ? [`  - concedes: ${v.concessions.map(one).join('; ')}`] : [])); }
    }
    out.push('');
  }
  out.push('## Disagreement', '');
  if (!r.disagreements.raised) out.push('No member raised an objection in this meeting. None is invented here.', '');
  else {
    for (const o of r.disagreements.objections) out.push(`- ${o.messageId}: ${o.by} objects to ${o.against} (${o.status})`);
    out.push('');
  }
  out.push('## Synthesis (proposed decision)', '');
  if (!r.synthesis) out.push('No synthesis was recorded.', '');
  else {
    const s = r.synthesis.synthesis as { decision?: string; rationale?: string; disagreements?: { between: string[]; issue: string; status: string }[]; uncertainties?: string[]; actionItems?: string[] };
    out.push(`- Chair ${r.synthesis.specialistId} proposes **${r.synthesis.recorded.outcome}** ${r.synthesis.recorded.adoptedProposalId}${r.synthesis.recorded.contested ? ` — CONTESTED, overruled objections ${r.synthesis.recorded.overruledObjections.join(', ')}` : ''} (authority: none)`);
    out.push(`- Decision: ${one(s.decision)}`, `- Rationale: ${one(s.rationale)}`, '- Disagreements the chair lists:', ...list((s.disagreements ?? []).map((d) => `${d.between.join(' vs ')}: ${d.issue} [${d.status}]`), 'none listed'));
    out.push('- Uncertainties:', ...list(s.uncertainties, 'the chair stated none'), '- Action items (for the human operator):', ...list(s.actionItems, 'none'), '');
  }
  const a = r.accounting;
  out.push('## Accounting', '', `- Turns reserved ${a.turnsReserved}/${a.limits.maxInvocations}, recorded ${a.turnsRecorded}; model calls ${a.modelCalls} (re-asks ${a.reasks}, invalid ${a.invalidReplies}, failed ${a.failedCalls}); tokens in ${a.tokens.input}, out ${a.tokens.output}`, '');
  out.push('## Limitations', '', ...r.limitations.map((l) => `- ${l}`), '');
  return out.join('\n');
}

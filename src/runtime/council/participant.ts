import { createHash } from 'node:crypto';
import type { Participant, TurnContext, TurnReply } from '../collaboration/coordinator.ts';
import type { EvidenceRef } from '../collaboration/types.ts';
import { COUNCIL_LIMITS, critiqueSchema, parseCouncilReply, phaseOfRound, proposalSchema, synthesisSchema, type CouncilPhase } from './contract.ts';
import type { CallJournal } from './journal.ts';
import { COUNCIL_OPERATOR_ID, type PanelSeat } from './panel.ts';
import { buildCouncilPrompt, councilInstructions, reaskSuffix } from './prompts.ts';

/**
 * What the runtime needs from whatever runs a specialist. The Mastra integration implements it (agent id, read-only tools,
 * repository through RequestContext, tracing); this module imports nothing from integrations.
 */
export interface SpecialistCall {
  meetingId: string;
  seat: PanelSeat;
  phase: CouncilPhase;
  round: number;
  turn: number;
  attempt: number;
  /** Replaces the agent's default instructions for this call. */
  instructions: string;
  prompt: string;
  signal: AbortSignal;
}

export interface SpecialistResult {
  text: string;
  /** Model calls the agent made (one per step); null when the invoker cannot tell. */
  steps: number | null;
  toolCalls: readonly { tool: string; count: number }[];
  inputTokens: number | null;
  outputTokens: number | null;
  /** The invoker's id for this call and the observability trace id, when it has one. */
  runId: string;
  traceId: string | null;
  inferenceMs: number;
  /** The agent that answered (a Mastra agent id), when the invoker knows it. */
  agentId?: string | null;
}

export interface SpecialistInvoker {
  invoke(call: SpecialistCall): Promise<SpecialistResult>;
}

export class CouncilBudgetExhausted extends Error {
  constructor(message: string) { super(message); this.name = 'CouncilBudgetExhausted'; }
}
export class CouncilInvalidOutput extends Error {
  constructor(message: string) { super(message); this.name = 'CouncilInvalidOutput'; }
}

export interface CouncilParticipantOptions {
  meetingId: string;
  seat: PanelSeat;
  provider: string;
  model: string;
  question: string;
  focusPaths: readonly string[];
  names: ReadonlyMap<string, string>;
  /** Every seat of the panel, so a named member can be resolved to that member's proposal. */
  panel: readonly PanelSeat[];
  invoker: SpecialistInvoker;
  journal: CallJournal;
  maxModelCalls?: number;
  maxTokens?: number;
  /** Wall-clock cap of one model call. The coordinator's turn timeout still bounds the whole turn, re-ask included. */
  callTimeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const files = (paths: readonly string[]): EvidenceRef[] => paths.map((ref) => ({ kind: 'file', ref }));

export class CouncilParticipant implements Participant {
  readonly id: string;
  private readonly o: CouncilParticipantOptions;

  constructor(options: CouncilParticipantOptions) {
    this.id = options.seat.participantId;
    this.o = options;
  }

  async respond(ctx: TurnContext, signal: AbortSignal): Promise<TurnReply> {
    const { seat } = this.o;
    const phase = phaseOfRound(ctx.round);
    // Round 3 belongs to the chair. A member that is asked again (only when the synthesis was refused) adds nothing and makes no
    // model call; the record counts it as a turn and the journal shows no call, so the two are never confused.
    if (phase === 'synthesis' && !seat.chair) {
      return { kind: 'pass', body: 'No further contribution: the chair synthesizes in round 3.', invocation: { runId: 'no-model-call', inferenceMs: 0, usage: { inputTokens: 0, outputTokens: 0 } } };
    }

    const maxCalls = this.o.maxModelCalls ?? COUNCIL_LIMITS.maxModelCallsPerSeat;
    const maxTokens = this.o.maxTokens ?? COUNCIL_LIMITS.maxTokensPerSeat;
    const members = this.o.panel.map((s) => s.specialistId);
    const specialistOf = new Map(this.o.panel.map((s) => [s.participantId, s.specialistId]));
    const instructions = councilInstructions(seat, phase, members);
    const basePrompt = buildCouncilPrompt({ meetingId: this.o.meetingId, seat, phase, question: this.o.question, focusPaths: this.o.focusPaths, transcript: ctx.transcript, names: this.o.names, specialistOf });
    const now = this.o.now ?? Date.now;

    let prompt = basePrompt;
    let inferenceMs = 0;
    let input: number | null = 0;
    let output: number | null = 0;
    for (let attempt = 1; attempt <= 1 + COUNCIL_LIMITS.maxReasks; attempt++) {
      this.checkBudget(maxCalls, maxTokens);
      const callSignal = this.o.callTimeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(this.o.callTimeoutMs)]) : signal;
      const call: SpecialistCall = { meetingId: this.o.meetingId, seat, phase, round: ctx.round, turn: ctx.turn, attempt, instructions, prompt, signal: callSignal };
      const entry = { at: now(), meetingId: this.o.meetingId, participantId: this.id, specialistId: seat.specialistId, phase, round: ctx.round, turn: ctx.turn, attempt, provider: this.o.provider, model: this.o.model };
      let result;
      try {
        this.o.log?.(`${seat.specialistId}: ${phase} (round ${ctx.round}, attempt ${attempt})`);
        result = await this.o.invoker.invoke(call);
      } catch (err) {
        this.o.journal.append({ ...entry, agentId: null, runId: null, traceId: null, outcome: 'error', reason: String((err as Error)?.message ?? err).slice(0, 300), inferenceMs: 0, inputTokens: null, outputTokens: null, toolCalls: [], steps: null, replyBytes: 0, replySha256: null });
        throw err; // a provider error, timeout or abort is the coordinator's to classify: failed meeting, or suspended on abort
      }
      inferenceMs += result.inferenceMs;
      input = input === null || result.inputTokens === null ? null : input + result.inputTokens;
      output = output === null || result.outputTokens === null ? null : output + result.outputTokens;

      const checked = this.check(phase, result.text, ctx);
      this.o.journal.append({ ...entry, agentId: result.agentId ?? null, runId: result.runId, traceId: result.traceId, outcome: checked.ok ? 'accepted' : 'invalid', reason: checked.ok ? null : checked.reason, inferenceMs: result.inferenceMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, toolCalls: result.toolCalls, steps: result.steps, replyBytes: Buffer.byteLength(result.text ?? '', 'utf8'), replySha256: result.text ? sha(result.text) : null });
      if (checked.ok) {
        return {
          ...checked.reply,
          invocation: { runId: result.runId, ...(result.traceId ? { traceId: result.traceId } : {}), inferenceMs: Math.max(0, Math.round(inferenceMs)), usage: { ...(input !== null ? { inputTokens: input } : {}), ...(output !== null ? { outputTokens: output } : {}) } },
        };
      }
      prompt = `${basePrompt}${reaskSuffix(checked.reason)}`;
    }
    const last = this.o.journal.entries(this.o.meetingId).filter((e) => e.participantId === this.id).at(-1);
    throw new CouncilInvalidOutput(`${seat.specialistId} gave an invalid ${phase} after ${1 + COUNCIL_LIMITS.maxReasks} attempt(s): ${last?.reason ?? 'unknown'}`);
  }

  /** Per-seat ceilings from the durable journal, so a resumed meeting counts what the first process already spent. */
  private checkBudget(maxCalls: number, maxTokens: number): void {
    const mine = this.o.journal.entries(this.o.meetingId).filter((e) => e.participantId === this.id);
    if (mine.length >= maxCalls) throw new CouncilBudgetExhausted(`${this.id}: model-call ceiling reached (${mine.length}/${maxCalls})`);
    let tokens = 0;
    for (const e of mine) {
      // A call lost to an interruption or a provider error returned no reply, so it has no usage to verify; it still counts as a
      // call above, and the record reports total tokens as UNKNOWN because of it. Only replies must report usage.
      if (e.outcome === 'error') continue;
      if (e.inputTokens === null || e.outputTokens === null) throw new CouncilBudgetExhausted(`${this.id}: an earlier call reported no token usage, so the ${maxTokens}-token ceiling cannot be verified; refusing further calls`);
      tokens += e.inputTokens + e.outputTokens;
    }
    if (tokens >= maxTokens) throw new CouncilBudgetExhausted(`${this.id}: token ceiling reached (${tokens}/${maxTokens})`);
  }

  private check(phase: CouncilPhase, raw: string, ctx: TurnContext): { ok: true; reply: Omit<TurnReply, 'invocation'> } | { ok: false; reason: string } {
    const proposals = ctx.transcript.filter((m) => m.sessionId === ctx.sessionId && m.kind === 'proposal');
    if (phase === 'proposal') {
      const p = parseCouncilReply(raw, proposalSchema);
      if (!p.ok) return p;
      return { ok: true, reply: { kind: 'proposal', body: JSON.stringify(p.value), evidence: files(p.value.evidence) } };
    }
    const proposalBy = (specialistId: string) => {
      const seat = this.o.panel.find((p) => p.specialistId === specialistId);
      return seat ? proposals.find((m) => m.author.id === seat.participantId) : undefined;
    };
    if (phase === 'critique') {
      const c = parseCouncilReply(raw, critiqueSchema);
      if (!c.ok) return c;
      const others = this.o.panel.filter((p) => p.participantId !== this.id).map((p) => p.specialistId);
      if (c.value.targetMember === this.o.seat.specialistId) return { ok: false, reason: `you may not critique your own proposal; targetMember must be one of: ${others.join(', ')}` };
      const target = proposalBy(c.value.targetMember);
      if (!target) return { ok: false, reason: `targetMember ${JSON.stringify(c.value.targetMember)} is not a member with a proposal (valid: ${others.join(', ')})` };
      return { ok: true, reply: { kind: c.value.stance === 'object' ? 'objection' : 'support', body: JSON.stringify(c.value), parentId: target.id, evidence: files(c.value.evidence) } };
    }
    const s = parseCouncilReply(raw, synthesisSchema);
    if (!s.ok) return s;
    const adopted = proposalBy(s.value.adoptedFrom);
    if (!adopted) return { ok: false, reason: `adoptedFrom ${JSON.stringify(s.value.adoptedFrom)} is not a member with a proposal (valid: ${this.o.panel.map((p) => p.specialistId).join(', ')})` };
    return {
      ok: true,
      reply: {
        kind: 'decision',
        body: JSON.stringify(s.value),
        // Owners are the human operator: actions are for the human who adopts or rejects the proposal, never for another agent.
        decision: { outcome: s.value.outcome, proposalIds: [adopted.id], rationale: s.value.rationale, actionItems: s.value.actionItems.map((description) => ({ owner: COUNCIL_OPERATOR_ID, description })) },
      },
    };
  }
}

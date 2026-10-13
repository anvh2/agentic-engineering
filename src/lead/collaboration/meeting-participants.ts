import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapacityLease } from '../../runtime/capacity/model-capacity.ts';
import type { Participant, TurnContext, TurnReply } from '../../runtime/collaboration/coordinator.ts';
import { COLLABORATION_CEILINGS, MESSAGE_KINDS, type EvidenceRef, type MessageKind, type MessageView } from '../../runtime/collaboration/types.ts';
import { UNKNOWN } from '../../runtime/execution/worker-provider.ts';
import type { ProviderEntry } from '../../workers/providers/registry.ts';

/**
 * Model-backed meeting participants (M10). Each one answers a single turn of a MeetingCoordinator session and nothing else:
 * it never opens, claims or decides a session by itself, and every rule the store enforces (turn order, round and invocation
 * limits, fencing, who may decide) still applies to whatever it returns.
 *
 * What a participant adds on top of the coordinator is the model-call discipline:
 *   - authorization is checked by the caller BEFORE a participant is constructed (lead meeting open/run); a participant
 *     never widens it;
 *   - a capacity lease (the same machine-wide ModelCapacity the scheduler uses) is held for exactly the duration of the call,
 *     and a lease lost mid-call fails the turn instead of posting a reply produced while unfenced;
 *   - hard ceilings per participant: output tokens per call, invocations and total tokens per session, a per-call deadline;
 *   - telemetry is what the provider reported, and the literal UNKNOWN otherwise (the store converts absent fields).
 */

export type MeetingTransportKind = 'lead-inbox' | 'ollama-chat' | 'worker-provider';

export interface ParticipantLimits {
  /** Output tokens one call may produce (passed to the provider; the reply is refused, not truncated, if it is still too long). */
  maxOutputTokens: number;
  /** Model calls this participant may make in one session (failed calls count). */
  maxInvocations: number;
  /** Input + output tokens this participant may consume in one session. A reply whose usage is UNKNOWN stops further calls. */
  maxTokens: number;
  /** Wall-clock cap of one call. */
  callTimeoutMs: number;
}

export interface TransportCall {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  /** The call's hard deadline (the signal fires at it too); providers that take a deadline of their own get this one. */
  timeoutMs: number;
  signal: AbortSignal;
}

export interface TransportResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Our own id for this invocation (always set), and the provider's trace id when it reports one. */
  invocationId: string;
  traceId?: string;
  inferenceMs: number;
}

export interface MeetingTransport {
  readonly kind: MeetingTransportKind;
  complete(call: TransportCall): Promise<TransportResult>;
}

export interface CapacityLike {
  acquire(holder: string, signal?: AbortSignal, options?: { tag?: string; maxWaitMs?: number }): Promise<CapacityLease>;
}

/** Kinds a non-chair model participant may use. `decision` is the chair's, `correction`/`withdrawal` need provenance a model cannot assert. */
export const MODEL_REPLY_KINDS = ['proposal', 'objection', 'question', 'answer', 'support', 'comment', 'pass'] as const satisfies readonly MessageKind[];

export class ParticipantBudgetExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParticipantBudgetExhausted';
  }
}

/** What this participant already spent in the session, from the durable transcript (so a resumed run counts earlier calls). */
export function spentBy(id: string, transcript: readonly MessageView[], sessionId: string): { invocations: number; tokens: number | typeof UNKNOWN } {
  let invocations = 0;
  let tokens: number | typeof UNKNOWN = 0;
  for (const m of transcript) {
    if (m.author.id !== id || m.sessionId !== sessionId || !m.invocation) continue;
    invocations += 1;
    const { inputTokens, outputTokens } = m.invocation.usage;
    tokens = tokens === UNKNOWN || typeof inputTokens !== 'number' || typeof outputTokens !== 'number' ? UNKNOWN : tokens + inputTokens + outputTokens;
  }
  return { invocations, tokens };
}

// ---- prompt ---------------------------------------------------------------------------------------------------------

const MAX_BRIEFING_CHARS = 12_000;

export function buildTurnPrompt(ctx: TurnContext, options: { briefing?: string; blindFirstRound: boolean; roleNote?: string }): { system: string; user: string } {
  const self = ctx.self;
  // Independent first proposals: in round 1 nobody sees what the others proposed in round 1.
  const visible = ctx.transcript.filter((m) => !(options.blindFirstRound && ctx.round === 1 && m.round === 1 && m.author.id !== self.id));
  const hidden = ctx.transcript.length - visible.length;
  const system = [
    `You are ${self.displayName ?? self.id}, participating as "${self.role}" in a bounded engineering meeting chaired by ${ctx.chair}.`,
    options.roleNote ?? 'Give your own technical judgement. Disagree when the evidence supports it; do not invent agreement or disagreement.',
    'Base claims on the briefing and the transcript. When you are unsure, say so or ask a question instead of guessing.',
    'You cannot decide, authorize, change tasks or grant permissions: only the chair records decisions.',
    'Reply with ONE JSON object and nothing else:',
    '{"kind": "proposal|objection|question|answer|support|comment|pass", "body": "<your contribution, plain text, at most 2500 characters>", "parentId": "<message id, REQUIRED for objection/support (a proposal id) and answer (a question id), otherwise omit>", "evidence": [{"kind": "file", "ref": "<repo-relative path>"}]}',
    'Use "pass" only when you have nothing to add.',
  ].join('\n');
  const lines = visible.map((m) => `[${m.id}] round ${m.round ?? '-'} ${m.author.id} (${m.author.role}) ${m.kind}${m.parentId ? ` -> ${m.parentId}` : ''}:\n${m.body}`);
  const briefing = options.briefing ? options.briefing.slice(0, MAX_BRIEFING_CHARS) : '';
  const user = [
    `Meeting ${ctx.sessionId}, round ${ctx.round} of ${ctx.maxRounds}.`,
    'Agenda:',
    ...ctx.agenda.map((a, i) => `${i + 1}. ${a}`),
    briefing ? `\nBriefing (source-linked evidence prepared for this meeting${options.briefing!.length > MAX_BRIEFING_CHARS ? `; first ${MAX_BRIEFING_CHARS} characters` : ''}):\n${briefing}` : '',
    `\nTranscript so far${hidden ? ` (${hidden} other round-1 proposal(s) are hidden so your first proposal is independent)` : ''}:`,
    lines.length ? lines.join('\n\n') : '(empty)',
    `\nYour turn (${self.id}). Reply with the JSON object only.`,
  ].join('\n');
  return { system, user };
}

/** Parses a model's reply. Anything that is not the requested JSON becomes a plain comment carrying the model's own text. */
export function parseModelReply(text: string, allowed: readonly MessageKind[] = MODEL_REPLY_KINDS): { kind: MessageKind; body: string; parentId?: string; evidence?: EvidenceRef[]; parsed: boolean } {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
      const kind = typeof obj.kind === 'string' && (allowed as readonly string[]).includes(obj.kind) ? (obj.kind as MessageKind) : undefined;
      const body = typeof obj.body === 'string' ? obj.body.trim() : '';
      if (kind && body) {
        const evidence = Array.isArray(obj.evidence)
          ? obj.evidence
              .filter((e): e is { kind: string; ref: string } => !!e && typeof (e as any).kind === 'string' && typeof (e as any).ref === 'string')
              .filter((e) => e.kind === 'file' || e.kind === 'commit')
              .slice(0, COLLABORATION_CEILINGS.maxEvidence)
              .map((e) => ({ kind: e.kind as EvidenceRef['kind'], ref: e.ref.slice(0, 512) }))
          : undefined;
        return { kind, body, parentId: typeof obj.parentId === 'string' && obj.parentId ? obj.parentId : undefined, evidence: evidence?.length ? evidence : undefined, parsed: true };
      }
    } catch {
      /* not JSON: fall through to a comment */
    }
  }
  return { kind: 'comment', body: stripped || '(empty reply)', parsed: false };
}

// ---- provider-backed participant --------------------------------------------------------------------------------------

export interface ProviderParticipantOptions {
  id: string;
  provider: string;
  model: string;
  transport: MeetingTransport;
  limits: ParticipantLimits;
  sessionId: string;
  capacity?: CapacityLike;
  capacityWaitMs?: number;
  briefing?: string;
  blindFirstRound?: boolean;
  roleNote?: string;
  /** Observability hook (CLI logs); never decides anything. */
  log?: (line: string) => void;
}

export class ProviderParticipant implements Participant {
  readonly id: string;
  private readonly o: ProviderParticipantOptions;

  constructor(options: ProviderParticipantOptions) {
    this.id = options.id;
    this.o = options;
  }

  async respond(ctx: TurnContext, signal: AbortSignal): Promise<TurnReply> {
    const { limits } = this.o;
    const spent = spentBy(this.id, ctx.transcript, ctx.sessionId);
    if (spent.invocations >= limits.maxInvocations) throw new ParticipantBudgetExhausted(`${this.id}: invocation ceiling reached (${spent.invocations}/${limits.maxInvocations})`);
    if (spent.tokens === UNKNOWN) throw new ParticipantBudgetExhausted(`${this.id}: an earlier call reported no token usage, so the token ceiling of ${limits.maxTokens} cannot be verified; refusing further calls`);
    if (spent.tokens >= limits.maxTokens) throw new ParticipantBudgetExhausted(`${this.id}: token ceiling reached (${spent.tokens}/${limits.maxTokens})`);

    const { system, user } = buildTurnPrompt(ctx, { briefing: this.o.briefing, blindFirstRound: this.o.blindFirstRound ?? true, roleNote: this.o.roleNote });
    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(limits.callTimeoutMs)]);
    const tag = `meeting-${ctx.sessionId}`;
    let lease: CapacityLease | undefined;
    if (this.o.capacity) lease = await this.o.capacity.acquire(`${this.o.provider}:${this.o.model}:${tag}:${this.id}:pid${process.pid}`, callSignal, { tag, maxWaitMs: this.o.capacityWaitMs ?? 300_000 });
    let result: TransportResult;
    try {
      this.o.log?.(`${this.id}: calling ${this.o.provider}/${this.o.model} (round ${ctx.round}, attempt ${ctx.attempt}, max ${limits.maxOutputTokens} output tokens)`);
      result = await this.o.transport.complete({ model: this.o.model, system, user, maxOutputTokens: limits.maxOutputTokens, timeoutMs: limits.callTimeoutMs, signal: callSignal });
    } finally {
      const lost = lease?.lost === true;
      lease?.release();
      if (lost) throw new Error(`${this.id}: the model capacity lease was lost during the call (stalled past its lease); the reply is discarded`);
    }
    const reply = parseModelReply(result.text);
    this.o.log?.(`${this.id}: ${reply.parsed ? reply.kind : 'unstructured reply -> comment'} (${result.outputTokens ?? 'UNKNOWN'} output tokens, ${result.inferenceMs} ms, invocation ${result.invocationId})`);
    return {
      kind: reply.kind,
      body: reply.body,
      parentId: reply.parentId,
      evidence: reply.evidence,
      invocation: {
        runId: result.invocationId,
        ...(result.traceId ? { traceId: result.traceId } : {}),
        inferenceMs: Math.max(0, Math.round(result.inferenceMs)),
        usage: { ...(typeof result.inputTokens === 'number' ? { inputTokens: result.inputTokens } : {}), ...(typeof result.outputTokens === 'number' ? { outputTokens: result.outputTokens } : {}) },
      },
    };
  }
}

// ---- transports ---------------------------------------------------------------------------------------------------------

/** Local Ollama chat without tools: the meeting reply is text only, so the coding agent (and its file tools) is not involved. */
export function ollamaChatTransport(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): MeetingTransport {
  const base = (options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    kind: 'ollama-chat',
    async complete(call) {
      const started = Date.now();
      const invocationId = `ollama-${randomUUID()}`;
      const res = await fetchImpl(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: call.signal,
        body: JSON.stringify({
          model: call.model,
          stream: false,
          think: false,
          format: 'json',
          messages: [
            { role: 'system', content: call.system },
            { role: 'user', content: call.user },
          ],
          options: { num_predict: call.maxOutputTokens, temperature: 0.3 },
        }),
      });
      if (!res.ok) throw new Error(`ollama answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { model?: string; message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; done_reason?: string };
      if (body.model && body.model !== call.model) throw new Error(`ollama answered with model ${body.model}, not the pinned ${call.model}`);
      return { text: body.message?.content ?? '', inputTokens: body.prompt_eval_count, outputTokens: body.eval_count, invocationId, inferenceMs: Date.now() - started };
    },
  };
}

/**
 * A registered worker provider (gemini, codex, ...) used for a text reply. It runs exactly as it runs a coding task: its own
 * sandbox, flags, environment allow-list and process-group cancellation; the working directory is an empty scratch git
 * repository owned by the meeting, so there is nothing to edit and nothing outside it to reach.
 */
export function workerProviderTransport(options: { entry: ProviderEntry; scratchDir: string }): MeetingTransport {
  const provider = options.entry.create({ taskType: 'go' });
  return {
    kind: 'worker-provider',
    async complete(call) {
      const started = Date.now();
      const invocationId = `${options.entry.id}-${randomUUID()}`;
      ensureScratchRepo(options.scratchDir);
      const prompt = `${call.system}\n\nDo not create, edit or delete any file. Answer in your final message only.\n\n${call.user}`;
      const response = await provider.generate(prompt, { abortSignal: call.signal, providerRequest: { workdir: options.scratchDir, allowedFiles: [], contextFiles: [], taskType: 'go', timeoutMs: call.timeoutMs } });
      return { text: response.text ?? '', inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens, invocationId, inferenceMs: Date.now() - started };
    },
  };
}

function ensureScratchRepo(dir: string): void {
  if (existsSync(join(dir, '.git'))) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# meeting scratch (empty on purpose)\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'meeting', GIT_AUTHOR_EMAIL: 'meeting@localhost', GIT_COMMITTER_NAME: 'meeting', GIT_COMMITTER_EMAIL: 'meeting@localhost' } });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'scratch');
}

// ---- the Lead's turns ---------------------------------------------------------------------------------------------------

/**
 * The Engineering Lead's turns come from the Lead's own session (Claude Code), which writes them with `lead meeting record`
 * into the meeting's inbox while `lead meeting run` waits. The reply is the Lead's model output; its token usage is not
 * observable from here and is recorded as UNKNOWN, never 0.
 */
export function inboxPath(inboxDir: string, sessionId: string, round: number, turn: number): string {
  return join(inboxDir, `${sessionId}.r${round}.t${turn}.json`);
}

export interface LeadInboxReply {
  kind: MessageKind;
  body: string;
  parentId?: string;
  evidence?: EvidenceRef[];
  decision?: unknown;
  invocationId?: string;
  traceId?: string;
}

export class LeadInboxParticipant implements Participant {
  readonly id: string;
  private readonly inboxDir: string;
  private readonly pollMs: number;
  private readonly log?: (line: string) => void;

  constructor(options: { id: string; inboxDir: string; pollMs?: number; log?: (line: string) => void }) {
    this.id = options.id;
    this.inboxDir = options.inboxDir;
    this.pollMs = options.pollMs ?? 500;
    this.log = options.log;
  }

  async respond(ctx: TurnContext, signal: AbortSignal): Promise<TurnReply> {
    const path = inboxPath(this.inboxDir, ctx.sessionId, ctx.round, ctx.turn);
    this.log?.(`${this.id}: waiting for the Lead's reply (round ${ctx.round}, turn ${ctx.turn}): lead meeting record ${ctx.sessionId} --kind <kind> --body-file <file>`);
    while (!existsSync(path)) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted'));
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    const reply = JSON.parse(readFileSync(path, 'utf8')) as LeadInboxReply;
    if (!(MESSAGE_KINDS as readonly string[]).includes(reply.kind)) throw new Error(`${this.id}: inbox reply has an unknown kind ${JSON.stringify(reply.kind)}`);
    return {
      kind: reply.kind,
      body: reply.body,
      parentId: reply.parentId,
      evidence: reply.evidence,
      decision: reply.decision,
      invocation: { ...(reply.invocationId ? { runId: reply.invocationId } : {}), ...(reply.traceId ? { traceId: reply.traceId } : {}) },
    };
  }
}

/** Inbox files already written for a session (for `lead meeting status`). */
export function inboxEntries(inboxDir: string, sessionId: string): string[] {
  if (!existsSync(inboxDir)) return [];
  return readdirSync(inboxDir).filter((f) => f.startsWith(`${sessionId}.r`)).sort();
}

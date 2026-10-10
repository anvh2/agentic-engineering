import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capacityFor } from '../../runtime/capacity/model-capacity.ts';
import { MeetingCoordinator, type Participant } from '../../runtime/collaboration/coordinator.ts';
import { ParticipantDirectory } from '../../runtime/collaboration/directory.ts';
import { CollaborationStore } from '../../runtime/collaboration/store.ts';
import { CollaborationError, idSchema, MESSAGE_KINDS, type EngineeringRole, type EvidenceRef, type MessageKind, type ParticipantIdentity } from '../../runtime/collaboration/types.ts';
import { allowedProvidersFromEnv, authorizeProvider, DEFAULT_PROVIDER_ID, parseAllowList } from '../../runtime/execution/worker-provider.ts';
import type { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { defaultProviderRegistry } from '../../workers/providers/default.ts';
import type { ProviderRegistry } from '../../workers/providers/registry.ts';
import { inboxEntries, inboxPath, LeadInboxParticipant, ollamaChatTransport, ProviderParticipant, workerProviderTransport, type CapacityLike, type LeadInboxReply, type MeetingTransport, type MeetingTransportKind, type ParticipantLimits } from './meeting-participants.ts';
import { renderMeetingRecord } from './record-markdown.ts';
import { ENGINEERING_LEAD_ID } from './roster.ts';

/**
 * `lead meeting open|run|status|record|cancel` (M10): real, model-backed engineering meetings on top of the M9
 * CollaborationStore and MeetingCoordinator. This file adds no orchestration of its own: the coordinator drives turns, the
 * store enforces every rule, and the participants (meeting-participants.ts) make the bounded model calls.
 *
 * Authorization is the operator's, as everywhere else: a non-default provider takes a turn only if the operator's
 * allow-list (AGENTIC_ALLOW_PROVIDERS or --allow-provider) carries `<provider>` or `<provider>:meeting-<sessionId>`. It is
 * checked when the meeting is opened AND again by every `run`, so revoking it stops the next turn. Nothing in a meeting,
 * including its decision, can grant it.
 *
 * The roster of a meeting (who, which provider, which pinned model, which ceilings) is fixed at `open` in
 * <meetings>/<sessionId>/meeting.json and every later command rebuilds the exact same directory from it.
 */

export const MEETING_SIDECAR_SCHEMA = 'agentic.meeting-sidecar/1';

export interface SidecarParticipant {
  id: string;
  role: Exclude<EngineeringRole, 'operator'>;
  kind: ParticipantIdentity['kind'];
  provider: string;
  model: string;
  transport: MeetingTransportKind;
  limits: ParticipantLimits;
}

export interface MeetingSidecar {
  schema: typeof MEETING_SIDECAR_SCHEMA;
  sessionId: string;
  threadId: string;
  title: string;
  agenda: string[];
  chair: string;
  participants: SidecarParticipant[];
  operators: string[];
  excluded: { id: string; provider: string; model: string; reason: string }[];
  limits: { maxRounds: number; maxInvocations: number };
  blindFirstRound: boolean;
  briefingFile: string | null;
  openedAt: string;
}

export interface MeetingCommandDeps {
  store: SchedulerStore;
  /** Where meeting sidecars, inboxes and records live (default <workdir>/meetings). */
  meetingsDir: string;
  registry?: ProviderRegistry;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  capacity?: (spec: { resource: string; defaultPermits: number }) => CapacityLike;
  /** Where SIGINT/SIGTERM are heard during `run` (default: this process). */
  signalSource?: { on(event: string, l: () => void): unknown; off(event: string, l: () => void): unknown };
  out?: (line: string) => void;
  err?: (line: string) => void;
  inboxPollMs?: number;
}

const ROLE_KIND: Record<SidecarParticipant['role'], ParticipantIdentity['kind']> = { engineering_lead: 'lead', architect: 'worker', implementer: 'worker', reviewer: 'reviewer', verifier: 'reviewer' };
const ROLE_NOTE: Partial<Record<SidecarParticipant['role'], string>> = {
  reviewer: 'You are an independent technical challenger and reviewer. Look for wrong causal claims, missing evidence, unsafe shortcuts and simpler alternatives. Object when the evidence warrants it; support when it does not.',
  architect: 'You propose concrete, minimal technical designs and name the trade-offs.',
};

export class MeetingCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function argsOf(argv: string[]) {
  const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const all = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const has = (name: string) => argv.includes(name);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'));
  return { flag, all, has, positional };
}

const num = (v: string | undefined, fallback: number, what: string) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new MeetingCliError(`${what} must be a positive integer, got ${JSON.stringify(v)}`);
  return n;
};

/** `<id>=<provider>:<model>[@role]`, e.g. `reviewer-qwen=ollama:qwen3:8b-ctx8192@reviewer`. */
export function parseParticipantSpec(spec: string): { id: string; provider: string; model: string; role: SidecarParticipant['role'] } {
  const m = /^([^=]+)=([^:@]+):([^@]+)(?:@([a-z_]+))?$/.exec(spec);
  if (!m) throw new MeetingCliError(`--participant ${JSON.stringify(spec)}: expected <id>=<provider>:<model>[@role]`);
  const [, id, provider, model, role = 'reviewer'] = m;
  if (!idSchema.safeParse(id).success) throw new MeetingCliError(`--participant ${JSON.stringify(spec)}: invalid id`);
  if (!(role in ROLE_KIND) || role === 'engineering_lead') throw new MeetingCliError(`--participant ${JSON.stringify(spec)}: role must be one of architect, implementer, reviewer, verifier`);
  return { id, provider, model, role: role as SidecarParticipant['role'] };
}

export function sidecarPath(meetingsDir: string, sessionId: string): string {
  return join(meetingsDir, sessionId, 'meeting.json');
}

function loadSidecar(meetingsDir: string, sessionId: string): MeetingSidecar {
  const p = sidecarPath(meetingsDir, sessionId);
  if (!existsSync(p)) throw new MeetingCliError(`meeting ${sessionId} has no sidecar at ${p} (was it opened with lead meeting open?)`);
  const s = JSON.parse(readFileSync(p, 'utf8')) as MeetingSidecar;
  if (s.schema !== MEETING_SIDECAR_SCHEMA || s.sessionId !== sessionId) throw new MeetingCliError(`${p} is not a meeting sidecar for ${sessionId}`);
  return s;
}

export function directoryOf(s: Pick<MeetingSidecar, 'participants' | 'operators'>, leadModel: string): ParticipantDirectory {
  return new ParticipantDirectory([
    { id: ENGINEERING_LEAD_ID, role: 'engineering_lead', kind: 'lead', displayName: 'Claude Engineering Lead', provider: 'claude', model: leadModel },
    ...s.participants.filter((p) => p.id !== ENGINEERING_LEAD_ID).map((p): ParticipantIdentity => ({ id: p.id, role: p.role, kind: p.kind, provider: p.provider, model: p.model })),
    ...s.operators.map((id): ParticipantIdentity => ({ id, role: 'operator', kind: 'operator' })),
  ]);
}

const leadOf = (s: MeetingSidecar) => s.participants.find((p) => p.id === ENGINEERING_LEAD_ID)!;

function allowList(argv: ReturnType<typeof argsOf>, env: NodeJS.ProcessEnv): string[] {
  return [...allowedProvidersFromEnv(env), ...argv.all('--allow-provider').flatMap((a) => parseAllowList(a))];
}

/** The exact operator approval a provider participant needs, or null when it already has it. */
export function approvalNeeded(provider: string, sessionId: string, allow: readonly string[]): string | null {
  const auth = authorizeProvider(provider, `meeting-${sessionId}`, allow);
  return auth.ok ? null : `${provider}:meeting-${sessionId}`;
}

export async function runMeetingCommand(argv: string[], deps: MeetingCommandDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const env = deps.env ?? process.env;
  const a = argsOf(argv);
  const [sub, sessionId] = a.positional;
  try {
    if (!sub || !['open', 'run', 'status', 'record', 'cancel'].includes(sub)) throw new MeetingCliError('usage: lead meeting open|run|status|record|cancel <sessionId> ...');
    if (!sessionId || !idSchema.safeParse(sessionId).success) throw new MeetingCliError(`lead meeting ${sub}: a valid <sessionId> is required`);
    switch (sub) {
      case 'open':
        return await open(sessionId, a, deps, env, out, err);
      case 'run':
        return await run(sessionId, a, deps, env, out, err);
      case 'status':
        return status(sessionId, deps, out);
      case 'record':
        return record(sessionId, a, deps, out);
      case 'cancel':
        return cancel(sessionId, a, deps, out);
    }
  } catch (e) {
    if (e instanceof MeetingCliError) {
      err(`lead meeting: ${e.message}`);
      return e.exitCode;
    }
    if (e instanceof CollaborationError) {
      err(`lead meeting: ${e.code}: ${e.message}`);
      return 1;
    }
    throw e;
  }
  return 2;
}

async function open(sessionId: string, a: ReturnType<typeof argsOf>, deps: MeetingCommandDeps, env: NodeJS.ProcessEnv, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  if (existsSync(sidecarPath(deps.meetingsDir, sessionId))) throw new MeetingCliError(`meeting ${sessionId} already exists (${sidecarPath(deps.meetingsDir, sessionId)})`);
  const title = a.flag('--title');
  if (!title) throw new MeetingCliError('lead meeting open: --title is required');
  const agendaFile = a.flag('--agenda-file');
  const agenda = agendaFile ? readFileSync(agendaFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : a.all('--agenda');
  if (agenda.length === 0) throw new MeetingCliError('lead meeting open: give the agenda with --agenda-file <file> (one item per line) or --agenda "<item>" (repeatable)');
  const briefingFile = a.flag('--briefing') ?? null;
  if (briefingFile && !existsSync(briefingFile)) throw new MeetingCliError(`--briefing ${briefingFile} does not exist`);
  const operators = a.all('--operator');
  if (operators.length === 0) throw new MeetingCliError('lead meeting open: name the operator with --operator <id> (who can cancel the meeting)');
  const limitsDefault: ParticipantLimits = {
    maxOutputTokens: num(a.flag('--max-output-tokens'), 1_200, '--max-output-tokens'),
    maxInvocations: num(a.flag('--max-participant-invocations'), 4, '--max-participant-invocations'),
    maxTokens: num(a.flag('--max-participant-tokens'), 60_000, '--max-participant-tokens'),
    callTimeoutMs: num(a.flag('--call-timeout-ms'), 600_000, '--call-timeout-ms'),
  };
  const registry = deps.registry ?? defaultProviderRegistry();
  const allow = allowList(a, env);
  const specs = a.all('--participant').map(parseParticipantSpec);
  const participants: SidecarParticipant[] = [
    { id: ENGINEERING_LEAD_ID, role: 'engineering_lead', kind: 'lead', provider: 'claude', model: a.flag('--lead-model') ?? 'UNKNOWN', transport: 'lead-inbox', limits: limitsDefault },
  ];
  const excluded: MeetingSidecar['excluded'] = [];
  const missing: string[] = [];
  for (const s of specs) {
    const entry = registry.get(s.provider); // unknown provider: UnknownProviderError, surfaced as an error
    const descriptor = entry.describe();
    const need = approvalNeeded(s.provider, sessionId, allow);
    if (need) {
      const reason = `provider_not_authorized: ${s.provider} needs the operator allow-list entry ${need} (AGENTIC_ALLOW_PROVIDERS=${need} or --allow-provider ${need}); billing: ${descriptor.capabilities.billing}`;
      if (a.has('--exclude-unauthorized')) excluded.push({ id: s.id, provider: s.provider, model: s.model, reason });
      else missing.push(reason);
      continue;
    }
    const availability = await entry.probe();
    if (availability.state !== 'available') {
      const reason = `provider_unavailable: ${s.provider} is ${availability.state}: ${availability.detail}`;
      if (a.has('--exclude-unauthorized')) excluded.push({ id: s.id, provider: s.provider, model: s.model, reason });
      else missing.push(reason);
      continue;
    }
    if (s.provider === DEFAULT_PROVIDER_ID && !(availability.detail ?? '').includes(s.model) && descriptor.identity.model !== s.model) {
      // the probe checks the configured model; a different pinned model must be installed too
      await assertOllamaModel(s.model, env, deps.fetchImpl);
    }
    participants.push({ id: s.id, role: s.role, kind: ROLE_KIND[s.role], provider: s.provider, model: s.model, transport: s.provider === DEFAULT_PROVIDER_ID ? 'ollama-chat' : 'worker-provider', limits: limitsDefault });
  }
  if (missing.length) {
    for (const m of missing) err(`lead meeting open: ${m}`);
    throw new MeetingCliError(`not opened: ${missing.length} participant(s) are not authorized or not available (pass --exclude-unauthorized to open without them and record why)`, 3);
  }
  if (participants.length < 2) throw new MeetingCliError('not opened: a meeting needs at least one participant besides the Lead');

  const sidecar: MeetingSidecar = {
    schema: MEETING_SIDECAR_SCHEMA,
    sessionId,
    threadId: a.flag('--thread') ?? `t-${sessionId}`,
    title,
    agenda,
    chair: ENGINEERING_LEAD_ID,
    participants,
    operators,
    excluded,
    limits: { maxRounds: num(a.flag('--rounds'), 3, '--rounds'), maxInvocations: num(a.flag('--max-invocations'), 12, '--max-invocations') },
    blindFirstRound: !a.has('--no-blind-first-round'),
    briefingFile,
    openedAt: new Date().toISOString(),
  };
  const collab = new CollaborationStore(deps.store, directoryOf(sidecar, leadOf(sidecar).model));
  const objectiveId = a.flag('--objective');
  collab.openThread({ threadId: sidecar.threadId, title, refs: objectiveId ? { objectiveId } : undefined, participants: participants.map((p) => p.id), actorId: ENGINEERING_LEAD_ID, idempotencyKey: `meeting-open-thread:${sessionId}` });
  // Excluded participants are recorded in the thread itself, so the record shows who could not take part and why.
  for (const x of excluded) collab.post({ threadId: sidecar.threadId, authorId: ENGINEERING_LEAD_ID, kind: 'comment', body: `${x.id} (${x.provider}/${x.model}) is not in this meeting: ${x.reason}`, idempotencyKey: `meeting-excluded:${sessionId}:${x.id}` });
  collab.openSession({ sessionId, threadId: sidecar.threadId, agenda, participants: participants.map((p) => p.id), chair: ENGINEERING_LEAD_ID, limits: sidecar.limits, actorId: ENGINEERING_LEAD_ID, idempotencyKey: `meeting-open-session:${sessionId}` });
  mkdirSync(join(deps.meetingsDir, sessionId, 'inbox'), { recursive: true });
  writeFileSync(sidecarPath(deps.meetingsDir, sessionId), JSON.stringify(sidecar, null, 2) + '\n');
  out(JSON.stringify({ opened: sessionId, threadId: sidecar.threadId, participants: participants.map((p) => `${p.id} (${p.provider}/${p.model})`), excluded, limits: sidecar.limits, participantLimits: limitsDefault }, null, 2));
  return 0;
}

async function assertOllamaModel(model: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<void> {
  const base = (env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
  const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
  const names = ((await res.json()) as { models?: { name?: string }[] }).models?.map((m) => m.name) ?? [];
  if (!names.includes(model)) throw new MeetingCliError(`pinned model ${model} is not installed in Ollama at ${base}`, 3);
}

function buildParticipants(s: MeetingSidecar, deps: MeetingCommandDeps, env: NodeJS.ProcessEnv, allow: readonly string[], log: (l: string) => void): Participant[] {
  const registry = deps.registry ?? defaultProviderRegistry();
  const briefing = s.briefingFile && existsSync(s.briefingFile) ? readFileSync(s.briefingFile, 'utf8') : undefined;
  if (s.briefingFile && briefing === undefined) throw new MeetingCliError(`the meeting's briefing ${s.briefingFile} is gone; restore it or cancel the meeting`);
  const capacity = deps.capacity ?? ((spec) => capacityFor(spec));
  return s.participants.map((p): Participant => {
    if (p.transport === 'lead-inbox') return new LeadInboxParticipant({ id: p.id, inboxDir: join(deps.meetingsDir, s.sessionId, 'inbox'), pollMs: deps.inboxPollMs, log });
    const need = approvalNeeded(p.provider, s.sessionId, allow);
    if (need) throw new MeetingCliError(`provider_not_authorized: ${p.id} (${p.provider}) needs the operator allow-list entry ${need} for this run (AGENTIC_ALLOW_PROVIDERS=${need} or --allow-provider ${need})`, 3);
    const entry = registry.get(p.provider);
    const descriptor = entry.describe();
    let transport: MeetingTransport;
    if (p.transport === 'ollama-chat') transport = ollamaChatTransport({ baseUrl: env.OLLAMA_BASE_URL, fetchImpl: deps.fetchImpl });
    else transport = workerProviderTransport({ entry, scratchDir: join(deps.meetingsDir, s.sessionId, `scratch-${p.id}`) });
    if (p.transport === 'worker-provider' && descriptor.identity.model !== 'UNKNOWN' && descriptor.identity.model !== p.model) {
      throw new MeetingCliError(`${p.id}: pinned model ${p.model} but provider ${p.provider} is configured for ${descriptor.identity.model}; refusing to run a different model than the one the meeting was opened with`, 3);
    }
    return new ProviderParticipant({ id: p.id, provider: p.provider, model: p.model, transport, limits: p.limits, sessionId: s.sessionId, capacity: capacity(descriptor.capacity), briefing, blindFirstRound: s.blindFirstRound, roleNote: ROLE_NOTE[p.role], log });
  });
}

async function run(sessionId: string, a: ReturnType<typeof argsOf>, deps: MeetingCommandDeps, env: NodeJS.ProcessEnv, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  const s = loadSidecar(deps.meetingsDir, sessionId);
  const allow = allowList(a, env);
  const participants = buildParticipants(s, deps, env, allow, err);
  const collab = new CollaborationStore(deps.store, directoryOf(s, leadOf(s).model));
  const coordinator = new MeetingCoordinator(collab, { turnTimeoutMs: num(a.flag('--turn-timeout-ms'), 1_800_000, '--turn-timeout-ms') });
  const ac = new AbortController();
  // A meeting cancelled from outside (lead meeting cancel, by an operator or the Lead) must not leave this process waiting
  // on a turn until its timeout: once the session is no longer open, the in-flight turn is aborted (its provider call or
  // process group with it) and the coordinator reports the cancellation.
  const closed = new AbortController();
  const watcher = setInterval(() => {
    try {
      if (collab.session(sessionId).session.status !== 'open') closed.abort(new Error(`meeting ${sessionId} was closed while a turn was in flight`));
    } catch {
      /* a read failure is not a close; the coordinator's own writes will surface it */
    }
  }, deps.inboxPollMs ?? 1_000);
  watcher.unref?.();
  const watched = participants.map((p): Participant => ({ id: p.id, respond: (ctx, signal) => p.respond(ctx, AbortSignal.any([signal, closed.signal])) }));
  const source = deps.signalSource ?? process;
  const onSignal = () => ac.abort(new Error('operator interrupt: the session is suspended and can be resumed with lead meeting run'));
  source.on('SIGINT', onSignal);
  source.on('SIGTERM', onSignal);
  try {
    const result = await coordinator.run(sessionId, { owner: `lead-meeting-run:${process.pid}`, participants: watched, signal: ac.signal });
    if (result.status === 'concluded' || result.status === 'cancelled') {
      const dir = join(deps.meetingsDir, sessionId);
      writeFileSync(join(dir, 'record.json'), JSON.stringify(result.record, null, 2) + '\n');
      writeFileSync(join(dir, 'record.md'), renderMeetingRecord(result.record));
      out(JSON.stringify({ sessionId, status: result.status, outcome: result.status === 'concluded' ? result.outcome : 'cancelled', record: join(dir, 'record.md'), recordHash: result.record.recordHash }, null, 2));
      return result.status === 'concluded' && result.outcome === 'failed' ? 1 : 0;
    }
    out(JSON.stringify({ sessionId, ...result }, null, 2));
    return result.status === 'suspended' ? 130 : 1;
  } finally {
    clearInterval(watcher);
    source.off('SIGINT', onSignal);
    source.off('SIGTERM', onSignal);
  }
}

function status(sessionId: string, deps: MeetingCommandDeps, out: (l: string) => void): number {
  const s = loadSidecar(deps.meetingsDir, sessionId);
  const collab = new CollaborationStore(deps.store, directoryOf(s, leadOf(s).model));
  const { session, thread } = collab.session(sessionId);
  const next = session.status === 'open' && session.next.round <= session.limits.maxRounds ? { round: session.next.round, turn: session.next.turn, participant: session.participants[session.next.turn] } : null;
  out(
    JSON.stringify(
      {
        sessionId,
        threadId: s.threadId,
        status: session.status,
        suspended: session.suspended,
        owner: session.owner,
        epoch: session.epoch,
        pending: session.pending,
        next,
        invocationsUsed: session.invocationsUsed,
        limits: session.limits,
        tokensUsed: session.tokensUsed,
        outcome: session.outcome,
        participants: s.participants.map((p) => ({ id: p.id, provider: p.provider, model: p.model, transport: p.transport })),
        excluded: s.excluded,
        messages: thread.messages.filter((m) => m.sessionId === sessionId).map((m) => ({ id: m.id, round: m.round, author: m.author.id, kind: m.kind, parentId: m.parentId, provider: m.invocation?.provider ?? null, invocationId: m.invocation?.runId ?? null, tokens: m.invocation ? { in: m.invocation.usage.inputTokens, out: m.invocation.usage.outputTokens } : null })),
        turns: session.turns,
        inbox: inboxEntries(join(deps.meetingsDir, sessionId, 'inbox'), sessionId),
      },
      null,
      2,
    ),
  );
  return 0;
}

function record(sessionId: string, a: ReturnType<typeof argsOf>, deps: MeetingCommandDeps, out: (l: string) => void): number {
  const s = loadSidecar(deps.meetingsDir, sessionId);
  const collab = new CollaborationStore(deps.store, directoryOf(s, leadOf(s).model));
  const { session } = collab.session(sessionId);
  if (session.status !== 'open') throw new MeetingCliError(`meeting ${sessionId} is ${session.status}; nothing to record`);
  const at = session.pending ?? (session.next.round <= session.limits.maxRounds ? { round: session.next.round, turn: session.next.turn, participant: session.participants[session.next.turn] } : null);
  if (!at) throw new MeetingCliError(`meeting ${sessionId} has no turn left`);
  if (at.participant !== ENGINEERING_LEAD_ID) throw new MeetingCliError(`the ${session.pending ? 'pending' : 'next'} turn (round ${at.round}, turn ${at.turn}) belongs to ${at.participant}, not the Lead`);
  const kind = a.flag('--kind') as MessageKind | undefined;
  if (!kind || !(MESSAGE_KINDS as readonly string[]).includes(kind)) throw new MeetingCliError(`--kind must be one of ${MESSAGE_KINDS.join(', ')}`);
  const bodyFile = a.flag('--body-file');
  const body = bodyFile ? readFileSync(bodyFile, 'utf8').trim() : a.flag('--body');
  if (!body) throw new MeetingCliError('give the Lead\'s contribution with --body-file <file> or --body "<text>"');
  const evidence: EvidenceRef[] = a.all('--evidence').map((e) => {
    const i = e.indexOf(':');
    if (i < 1) throw new MeetingCliError(`--evidence ${JSON.stringify(e)}: expected <kind>:<ref>`);
    return { kind: e.slice(0, i) as EvidenceRef['kind'], ref: e.slice(i + 1) };
  });
  const decisionFile = a.flag('--decision-file');
  const reply: LeadInboxReply = {
    kind,
    body,
    ...(a.flag('--parent') ? { parentId: a.flag('--parent') } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...(decisionFile ? { decision: JSON.parse(readFileSync(decisionFile, 'utf8')) } : {}),
    ...(a.flag('--invocation-id') ? { invocationId: a.flag('--invocation-id') } : {}),
  };
  const path = inboxPath(join(deps.meetingsDir, sessionId, 'inbox'), sessionId, at.round, at.turn);
  if (existsSync(path)) throw new MeetingCliError(`the Lead already recorded round ${at.round}, turn ${at.turn} (${path}); a recorded contribution is never overwritten - post a correction in a later turn`);
  mkdirSync(join(deps.meetingsDir, sessionId, 'inbox'), { recursive: true });
  writeFileSync(path, JSON.stringify(reply, null, 2) + '\n', { flag: 'wx' });
  out(JSON.stringify({ recorded: path, round: at.round, turn: at.turn, kind, delivered: session.pending ? 'to the running coordinator' : 'when lead meeting run reaches this turn' }));
  return 0;
}

function cancel(sessionId: string, a: ReturnType<typeof argsOf>, deps: MeetingCommandDeps, out: (l: string) => void): number {
  const s = loadSidecar(deps.meetingsDir, sessionId);
  const reason = a.flag('--reason');
  if (!reason) throw new MeetingCliError('lead meeting cancel: --reason is required');
  const actorId = a.flag('--actor') ?? s.operators[0];
  const collab = new CollaborationStore(deps.store, directoryOf(s, leadOf(s).model));
  const rec = collab.cancelSession(sessionId, { actorId }, reason);
  const dir = join(deps.meetingsDir, sessionId);
  writeFileSync(join(dir, 'record.json'), JSON.stringify(rec, null, 2) + '\n');
  writeFileSync(join(dir, 'record.md'), renderMeetingRecord(rec));
  out(JSON.stringify({ cancelled: sessionId, by: actorId, reason }));
  return 0;
}

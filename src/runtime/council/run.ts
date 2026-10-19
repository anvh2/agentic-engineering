/**
 * Council orchestration over the existing meeting engine. This file adds no scheduler and no loop of its own:
 *
 *   prepareCouncil   preflight (every refusal here makes ZERO model calls), then open a thread + session on the council database
 *   conveneCouncil   MeetingCoordinator drives the turns; CouncilParticipants make the bounded, read-only specialist calls
 *   recordCouncil    derive the record from the durable events and the call journal, write it next to the meeting
 *
 * State lives in `<workdir>/council/`: one SQLite database for all councils (the collaboration store's own tables; it is NOT the
 * scheduler's database, so no task or lease is reachable from here) and one directory per meeting.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeetingCoordinator, type CoordinatorResult } from '../collaboration/coordinator.ts';
import { CollaborationStore } from '../collaboration/store.ts';
import { CollaborationError, idSchema } from '../collaboration/types.ts';
import { scanForSecrets } from '../knowledge/canonical.ts';
import { safeRelativePath } from '../knowledge/engineering-hooks.ts';
import { probeOllama, type ProviderReadiness } from '../knowledge/engineering-control.ts';
import type { PackRegistry } from '../knowledge/packs/loader.ts';
import { checkRepository } from '../knowledge/packs/review.ts';
import type { TaskLanguage } from '../knowledge/packs/schema.ts';
import { SchedulerStore } from '../scheduler/store.ts';
import { COUNCIL_LIMITS } from './contract.ts';
import { FileJournal, type CallJournal } from './journal.ts';
import { CouncilParticipant, type SpecialistInvoker } from './participant.ts';
import { councilDirectory, COUNCIL_OPERATOR_ID, resolvePanel, type ModelIdentity, type SeatSpec } from './panel.ts';
import { buildCouncilRecord, renderCouncilRecord, type CouncilMode, type CouncilRecord, type CouncilSidecar } from './record.ts';

export const SCRIPTED_MODEL: ModelIdentity = Object.freeze({ provider: 'scripted', model: 'scripted-council-1' });
/** A scripted model has no context window to overflow; this is the nominal figure the capability gate is evaluated at. */
export const SCRIPTED_CONTEXT_TOKENS = 32_000;

export interface CouncilDeps {
  /** `<project>/.workdir`. Council state never lives anywhere else. */
  workdir: string;
  registry: PackRegistry;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Repositories a council may read must lie inside one of these. */
  allowedRoots: () => readonly string[];
  /** Overridable for tests; default probes a LOOPBACK Ollama only. */
  probe?: () => Promise<ProviderReadiness>;
  log?: (line: string) => void;
}

export interface CouncilRequest {
  meetingId: string;
  mode: CouncilMode;
  question: string;
  focusPaths?: readonly string[];
  repository: string;
  language?: TaskLanguage;
  seats?: readonly SeatSpec[];
  limits?: Partial<CouncilSidecar['limits']>;
}

export const councilDir = (workdir: string, meetingId: string): string => join(workdir, 'council', meetingId);
export const councilDbPath = (workdir: string): string => join(workdir, 'council', 'council.db');
const sidecarPath = (workdir: string, meetingId: string): string => join(councilDir(workdir, meetingId), 'meeting.json');
export const journalOf = (workdir: string, meetingId: string): FileJournal => new FileJournal(join(councilDir(workdir, meetingId), 'calls.jsonl'));

export function declaredContext(env: NodeJS.ProcessEnv): number | undefined {
  const n = Number(env.OLLAMA_NUM_CTX);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export type Prepared =
  | { status: 'ready'; resumed: boolean; sidecar: CouncilSidecar }
  | { status: 'concluded'; sidecar: CouncilSidecar }
  | { status: 'refused'; reasons: readonly string[] };

/** Live mode is opt-in at the process that runs it, then gated on the local model actually being there. Never paid, never remote. */
export async function liveReadiness(deps: Pick<CouncilDeps, 'env' | 'probe'>): Promise<readonly string[]> {
  const env = deps.env ?? process.env;
  const reasons: string[] = [];
  if (env.AGENTIC_COUNCIL_LIVE !== '1') reasons.push('live_not_enabled: LIVE mode needs AGENTIC_COUNCIL_LIVE=1 in the environment of the process that runs the council (the Mastra server for server runs)');
  const probe = await (deps.probe ?? (() => probeOllama(env)))();
  if (!probe.configured) reasons.push(`model_not_ready: ${probe.detail}${probe.model ? ` (model ${probe.model})` : ''}`);
  return reasons;
}

export async function prepareCouncil(deps: CouncilDeps, req: CouncilRequest): Promise<Prepared> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const id = idSchema.safeParse(req.meetingId);
  if (!id.success) return { status: 'refused', reasons: [`invalid_meeting_id: ${req.meetingId}`] };

  // Resume or replay of a meeting that already exists: its own sidecar is the authority, the request must agree with it.
  if (existsSync(sidecarPath(deps.workdir, req.meetingId))) {
    const sidecar = JSON.parse(readFileSync(sidecarPath(deps.workdir, req.meetingId), 'utf8')) as CouncilSidecar;
    if (sidecar.mode !== req.mode) return { status: 'refused', reasons: [`mode_mismatch: meeting ${req.meetingId} was opened as ${sidecar.mode}; it cannot be continued as ${req.mode}`] };
    if (req.mode === 'LIVE') { const why = await liveReadiness({ env, probe: deps.probe }); if (why.length) return { status: 'refused', reasons: why }; }
    const collab = openStore(deps, sidecar);
    try { return collab.store.session(sidecar.sessionId).session.status === 'open' ? { status: 'ready', resumed: true, sidecar } : { status: 'concluded', sidecar }; }
    finally { collab.close(); }
  }

  const reasons: string[] = [];
  const question = (req.question ?? '').trim();
  if (!question) reasons.push('question_missing');
  if (question.length > COUNCIL_LIMITS.maxQuestionChars) reasons.push(`question_too_long: ${question.length} > ${COUNCIL_LIMITS.maxQuestionChars} characters`);
  if (scanForSecrets({ question }).length) reasons.push('question_contains_a_credential: refused before any model could see it');
  const focusPaths = [...(req.focusPaths ?? [])];
  for (const p of focusPaths) if (!safeRelativePath(p)) reasons.push(`focus_path_refused: ${JSON.stringify(p)} is not a safe repository-relative path`);
  if (focusPaths.length > 10) reasons.push('too_many_focus_paths: at most 10');

  const repo = await checkRepository(req.repository, deps.allowedRoots());
  if (!repo.ok) reasons.push(`repository_refused: ${repo.reason}`);
  if (req.mode === 'LIVE') reasons.push(...(await liveReadiness({ env, probe: deps.probe })));

  const language = req.language ?? 'ts';
  const panel = resolvePanel({ registry: deps.registry, language, contextTokens: req.mode === 'SCRIPTED' ? SCRIPTED_CONTEXT_TOKENS : declaredContext(env), seats: req.seats });
  if (!panel.ok) reasons.push(...panel.reasons);
  if (reasons.length || !panel.ok || !repo.ok) return { status: 'refused', reasons };

  const model: ModelIdentity = req.mode === 'SCRIPTED' ? SCRIPTED_MODEL : { provider: 'ollama', model: env.OLLAMA_MODEL ?? 'qwen3:8b' };
  const limits: CouncilSidecar['limits'] = {
    maxInvocations: 9, maxTokens: 120_000, maxModelCallsPerSeat: COUNCIL_LIMITS.maxModelCallsPerSeat, maxTokensPerSeat: COUNCIL_LIMITS.maxTokensPerSeat,
    callTimeoutMs: req.mode === 'LIVE' ? 240_000 : 10_000, turnTimeoutMs: req.mode === 'LIVE' ? 600_000 : 30_000, ...req.limits,
  };
  const sidecar: CouncilSidecar = {
    schema: 'agentic.council-sidecar/1', meetingId: req.meetingId, threadId: `council-thread-${req.meetingId}`, sessionId: `council-${req.meetingId}`, mode: req.mode,
    question, focusPaths, repository: repo.root, language, panel: [...panel.seats], model, limits, openedAt: now(),
  };
  const handle = openStore(deps, sidecar);
  try {
    const { store } = handle;
    store.openThread({ threadId: sidecar.threadId, title: `Engineering council ${sidecar.meetingId}`.slice(0, 200), participants: panel.seats.map((s) => s.participantId), actorId: COUNCIL_OPERATOR_ID, idempotencyKey: `council-open-thread:${sidecar.meetingId}` });
    store.openSession({
      sessionId: sidecar.sessionId, threadId: sidecar.threadId, agenda: ['Independent proposals', 'Critique and disagreement', 'Synthesis'], participants: panel.seats.map((s) => s.participantId),
      chair: panel.seats.find((s) => s.chair)!.participantId, limits: { maxRounds: COUNCIL_LIMITS.rounds, maxInvocations: limits.maxInvocations, ...(limits.maxTokens ? { maxTokens: limits.maxTokens } : {}) },
      actorId: COUNCIL_OPERATOR_ID, idempotencyKey: `council-open-session:${sidecar.meetingId}`,
    });
  } catch (err) {
    if (err instanceof CollaborationError) return { status: 'refused', reasons: [`${err.code}: ${err.message}`] };
    throw err;
  } finally { handle.close(); }
  mkdirSync(councilDir(deps.workdir, sidecar.meetingId), { recursive: true });
  // Written last and atomically: a sidecar on disk means the session exists, so a crash before this line re-opens idempotently.
  const tmp = `${sidecarPath(deps.workdir, sidecar.meetingId)}.tmp`;
  writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + '\n');
  renameSync(tmp, sidecarPath(deps.workdir, sidecar.meetingId));
  return { status: 'ready', resumed: false, sidecar };
}

function openStore(deps: CouncilDeps, sidecar: CouncilSidecar): { store: CollaborationStore; close: () => void } {
  mkdirSync(join(deps.workdir, 'council'), { recursive: true });
  const scheduler = new SchedulerStore(councilDbPath(deps.workdir), { now: deps.now });
  return { store: new CollaborationStore(scheduler, councilDirectory(sidecar.panel, sidecar.model)), close: () => scheduler.close() };
}

export interface ConveneOptions {
  invoker: SpecialistInvoker;
  signal?: AbortSignal;
  journal?: CallJournal;
  owner?: string;
}

export async function conveneCouncil(deps: CouncilDeps, sidecar: CouncilSidecar, options: ConveneOptions): Promise<CoordinatorResult> {
  const journal = options.journal ?? journalOf(deps.workdir, sidecar.meetingId);
  const names = new Map(sidecar.panel.map((s) => [s.participantId, s.name]));
  const participants = sidecar.panel.map((seat) => new CouncilParticipant({
    meetingId: sidecar.meetingId, seat, provider: sidecar.model.provider, model: sidecar.model.model, question: sidecar.question, focusPaths: sidecar.focusPaths, names,
    panel: sidecar.panel, invoker: options.invoker, journal, maxModelCalls: sidecar.limits.maxModelCallsPerSeat, maxTokens: sidecar.limits.maxTokensPerSeat, callTimeoutMs: sidecar.limits.callTimeoutMs, now: deps.now, log: deps.log,
  }));
  const handle = openStore(deps, sidecar);
  try {
    const coordinator = new MeetingCoordinator(handle.store, { turnTimeoutMs: sidecar.limits.turnTimeoutMs });
    return await coordinator.run(sidecar.sessionId, { owner: options.owner ?? `council-run:${process.pid}`, participants, signal: options.signal });
  } finally { handle.close(); }
}

/** Derives and writes the record. Only a closed session has one; a suspended meeting has none yet and says so by returning null. */
export function recordCouncil(deps: CouncilDeps, sidecar: CouncilSidecar, journal: CallJournal = journalOf(deps.workdir, sidecar.meetingId)): CouncilRecord | null {
  const handle = openStore(deps, sidecar);
  try {
    const { thread, session } = handle.store.session(sidecar.sessionId);
    const meeting = handle.store.record(sidecar.sessionId);
    if (!meeting) return null;
    const record = buildCouncilRecord({ sidecar, thread, session, meeting, calls: journal.entries(sidecar.meetingId), workflowRuns: workflowRunsOf(deps.workdir, sidecar.meetingId), now: (deps.now ?? Date.now)() });
    const dir = councilDir(deps.workdir, sidecar.meetingId);
    writeFileSync(join(dir, 'record.json'), JSON.stringify(record, null, 2) + '\n');
    writeFileSync(join(dir, 'record.md'), renderCouncilRecord(record));
    writeFileSync(join(dir, 'meeting-record.json'), JSON.stringify(meeting, null, 2) + '\n');
    return record;
  } finally { handle.close(); }
}

const runsPath = (workdir: string, meetingId: string): string => join(councilDir(workdir, meetingId), 'workflow-runs.jsonl');

/** Appends the Mastra workflow run id that is about to drive (or resume) this meeting. Evidence only; nothing reads it for a decision. */
export function noteWorkflowRun(deps: Pick<CouncilDeps, 'workdir' | 'now'>, meetingId: string, runId: string): void {
  mkdirSync(councilDir(deps.workdir, meetingId), { recursive: true });
  appendFileSync(runsPath(deps.workdir, meetingId), `${JSON.stringify({ runId, at: (deps.now ?? Date.now)() })}\n`);
}

function workflowRunsOf(workdir: string, meetingId: string): { runId: string; at: number }[] {
  const p = runsPath(workdir, meetingId);
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { runId: string; at: number }) : [];
}

export function loadSidecar(workdir: string, meetingId: string): CouncilSidecar | null {
  const p = sidecarPath(workdir, meetingId);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as CouncilSidecar) : null;
}

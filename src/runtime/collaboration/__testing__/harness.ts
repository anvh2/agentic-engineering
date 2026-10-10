import { SchedulerStore } from '../../scheduler/store.ts';
import { MeetingCoordinator } from '../coordinator.ts';
import { ParticipantDirectory } from '../directory.ts';
import { CollaborationStore } from '../store.ts';
import type { SessionLimits, WorkRef } from '../types.ts';
import { latest, ScriptedParticipant, TEST_ROSTER } from './fake-agents.ts';

export const LEAD = 'claude-engineering-lead';
export const MEETING_PARTICIPANTS = [LEAD, 'architect', 'worker-codex', 'reviewer'];

/** A scheduler database (in memory unless `path`) with a deterministic clock, the test roster and a coordinator. */
export function collabHarness(options: { path?: string; turnTimeoutMs?: number } = {}) {
  let t = 1_790_000_000_000;
  const now = () => (t += 1_000);
  const scheduler = new SchedulerStore(options.path ?? ':memory:', { now });
  const directory = new ParticipantDirectory(TEST_ROSTER);
  const store = new CollaborationStore(scheduler, directory);
  const coordinator = new MeetingCoordinator(store, { turnTimeoutMs: options.turnTimeoutMs ?? 200 });
  return { scheduler, directory, store, coordinator };
}

export function openMeeting(
  store: CollaborationStore,
  options: { threadId?: string; sessionId?: string; participants?: string[]; threadParticipants?: string[]; chair?: string; limits?: Partial<SessionLimits>; refs?: WorkRef; agenda?: string[] } = {},
) {
  const threadId = options.threadId ?? 't-design';
  const sessionId = options.sessionId ?? 's-design';
  const participants = options.participants ?? MEETING_PARTICIPANTS;
  store.openThread({ threadId, title: 'Persist delegation capacity per task', refs: options.refs, participants: options.threadParticipants ?? participants, actorId: LEAD });
  store.openSession({
    sessionId,
    threadId,
    agenda: options.agenda ?? ['Where does the per-task delegation limit live?', 'What happens above the hard limit?'],
    participants,
    chair: options.chair ?? LEAD,
    limits: { maxRounds: 3, maxInvocations: 20, ...options.limits },
    actorId: LEAD,
  });
  return { threadId, sessionId };
}

const usage = (inputTokens: number, outputTokens: number) => ({ usage: { inputTokens, outputTokens } });

/**
 * The reference engineering alignment meeting, three rounds:
 *   r1 lead frames; architect proposes; codex objects; reviewer asks
 *   r2 lead answers; architect corrects its proposal; codex keeps its objection (pass); reviewer supports
 *   r3 lead decides to accept over the outstanding objection, with owned action items
 * The decision is therefore contested, the objection stays unresolved, and there is no unanimous agreement.
 */
export function designMeeting(options: { withUsage?: boolean } = { withUsage: true }) {
  const u = (i: number, o: number) => (options.withUsage === false ? {} : { invocation: usage(i, o) });
  const lead = new ScriptedParticipant(LEAD, [
    { kind: 'comment', body: 'Agenda: decide where the per-task delegation limit is declared and what the runtime does above it.', ...u(120, 40) },
    (ctx) => ({ kind: 'answer', parentId: latest(ctx, 'question', 'reviewer').id, body: 'Plan validation rejects the plan before any claim; nothing is truncated.', ...u(300, 60) }),
    (ctx) => ({
      kind: 'decision',
      body: 'Accept the task-spec policy. The objection on paid re-planning is recorded and stays open.',
      decision: {
        outcome: 'accept',
        proposalIds: [latest(ctx, 'proposal', 'architect').id],
        rationale: 'Makes the limit explicit and reviewable; the hard ceiling stays a code review.',
        actionItems: [
          { owner: 'worker-codex', description: 'Add capacity to the task spec schema with a strict parser.' },
          { owner: 'reviewer', description: 'Write the over-limit escalation test.' },
        ],
      },
      evidence: [{ kind: 'message', ref: latest(ctx, 'objection', 'worker-codex').id, note: 'overruled, not resolved' }],
      ...u(500, 90),
    }),
  ]);
  const architect = new ScriptedParticipant('architect', [
    { kind: 'proposal', body: 'Declare delegationCapacity in the task spec; default 80 lines per file, 400 per task; hard ceiling 2000 in code.', evidence: [{ kind: 'file', ref: 'src/runtime/execution/delegation.ts' }], ...u(400, 120) },
    (ctx) => ({ kind: 'correction', parentId: latest(ctx, 'proposal', 'architect').id, body: 'Correction: the per-file number is a repairable warning, not a block.', ...u(200, 30) }),
  ]);
  const codex = new ScriptedParticipant('worker-codex', [
    (ctx) => ({ kind: 'objection', parentId: latest(ctx, 'proposal', 'architect').id, body: 'Re-planning a larger task on a paid provider needs operator approval; the proposal does not say so.', ...u(350, 80) }),
    { kind: 'pass', body: 'My objection stands.', ...u(100, 5) },
  ]);
  const reviewer = new ScriptedParticipant('reviewer', [
    { kind: 'question', body: 'Is the limit checked before the worker runs, or only at review?', ...u(150, 20) },
    (ctx) => ({ kind: 'support', parentId: latest(ctx, 'proposal', 'architect').id, body: 'Supported with the correction.', ...u(120, 10) }),
  ]);
  return { participants: [lead, architect, codex, reviewer], lead, architect, codex, reviewer };
}

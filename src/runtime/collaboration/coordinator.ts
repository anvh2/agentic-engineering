import type { Measured } from '../execution/worker-provider.ts';
import type { MeetingRecord } from './record.ts';
import { nextTurn, stopCondition } from './replay.ts';
import type { CollaborationStore } from './store.ts';
import { CollaborationError, type ParticipantIdentity, type EvidenceRef, type InvocationInput, type MessageKind, type MessageView, type PendingTurn, type SessionFence, type SessionOutcome } from './types.ts';

/**
 * Runs one meeting session to an outcome, deterministically and within its limits. It is a component, not a scheduler: it
 * owns no queue, claims no task and starts nothing by itself; a caller runs it for one session. It never calls a model:
 * participants are `Participant` objects handed in by the caller (fakes in tests; a real adapter is wired later through an
 * explicit, operator-authorized adapter).
 *
 * Every rule that matters is enforced by the store, not here: turn order, round and invocation limits, the fence, who may
 * decide. The coordinator only drives the loop, so a buggy or superseded coordinator cannot exceed a budget, speak out of
 * turn or write after it lost the session.
 *
 * Loop: claim (new epoch) -> [between turns: stop condition?] -> reserve the next turn (charges the budget) -> ask the
 * participant (bounded by turnTimeoutMs) -> post its reply as that turn (or record the turn as rejected / failed) -> repeat.
 *
 * Outcomes: decided | unresolved (max_rounds, no_progress) | budget_exhausted | failed (a participant errored or timed out)
 * | cancelled (operator, lead or the AbortSignal's owner via `cancelSession`). An AbortSignal SUSPENDS: the session stays
 * open and a later `run` resumes it; a turn reserved but not answered is recorded as abandoned and asked again (charged
 * again: the first call may have consumed tokens).
 */

export interface TurnContext {
  sessionId: string;
  threadId: string;
  agenda: readonly string[];
  round: number;
  turn: number;
  attempt: number;
  maxRounds: number;
  chair: string;
  self: ParticipantIdentity;
  /** Every message in the thread so far, in order. */
  transcript: readonly MessageView[];
  budget: { invocationsUsed: number; maxInvocations: number; tokensUsed: Measured<number>; maxTokens: number | null };
}

export interface TurnReply {
  kind: MessageKind;
  body: string;
  parentId?: string;
  evidence?: EvidenceRef[];
  decision?: unknown;
  /** What the participant can report about its model call. Provider and model always come from the directory. */
  invocation?: InvocationInput;
}

export interface Participant {
  readonly id: string;
  respond(ctx: TurnContext, signal: AbortSignal): Promise<TurnReply>;
}

export type CoordinatorResult =
  | { status: 'concluded'; outcome: Exclude<SessionOutcome, 'cancelled'>; record: MeetingRecord }
  | { status: 'cancelled'; record: MeetingRecord }
  | { status: 'suspended'; reason: string }
  | { status: 'superseded'; detail: string };

export interface CoordinatorOptions {
  /** Per-turn bound on a participant's answer. Default 60 s. */
  turnTimeoutMs?: number;
}

const RECOVERABLE_WRITE = new Set(['stale', 'session_closed']);
const REJECTED_REPLY = new Set(['invalid', 'unauthorized', 'not_found']);

class TurnTimeout extends Error {}

export class MeetingCoordinator {
  private readonly store: CollaborationStore;
  private readonly turnTimeoutMs: number;

  constructor(store: CollaborationStore, options: CoordinatorOptions = {}) {
    this.store = store;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 60_000;
  }

  async run(sessionId: string, options: { owner: string; participants: readonly Participant[]; signal?: AbortSignal }): Promise<CoordinatorResult> {
    const { session: initial } = this.store.session(sessionId);
    const impl = new Map(options.participants.map((p) => [p.id, p]));
    if (impl.size !== options.participants.length) throw new CollaborationError('invalid', 'participants are listed twice');
    for (const id of initial.participants) if (!impl.has(id)) throw new CollaborationError('invalid', `session ${sessionId}: no implementation for participant ${id}`);
    for (const id of impl.keys()) if (!initial.participants.includes(id)) throw new CollaborationError('unauthorized', `session ${sessionId}: ${id} is not a session participant`);

    const fence = this.store.claimSession(sessionId, options.owner);
    for (;;) {
      const { thread, session } = this.store.session(sessionId);
      if (session.status !== 'open') return this.closed(sessionId);
      if (session.owner !== fence.owner || session.epoch !== fence.epoch) return { status: 'superseded', detail: `session ${sessionId} is now held by ${session.owner}@${session.epoch}` };
      if (options.signal?.aborted) return this.suspend(sessionId, fence, String(options.signal.reason ?? 'aborted'));

      try {
        let pending: PendingTurn | null = session.pending;
        if (!pending || pending.epoch !== fence.epoch) {
          if (!pending) {
            const stop = stopCondition(thread, session);
            if (stop) return this.conclude(sessionId, fence, stop.outcome, stop.reason);
          }
          const next = nextTurn(session);
          if (!next) return this.conclude(sessionId, fence, 'unresolved', `max_rounds: all ${session.limits.maxRounds} round(s) spent without a decision`);
          try {
            pending = this.store.reserveTurn(sessionId, fence, next);
          } catch (err) {
            if (err instanceof CollaborationError && err.code === 'budget_exhausted') return this.conclude(sessionId, fence, 'budget_exhausted', err.message);
            throw err;
          }
        }

        const participant = impl.get(pending.participant)!;
        const after = this.store.session(sessionId);
        const ctx: TurnContext = {
          sessionId,
          threadId: session.threadId,
          agenda: session.agenda,
          round: pending.round,
          turn: pending.turn,
          attempt: pending.attempt,
          maxRounds: session.limits.maxRounds,
          chair: session.chair,
          self: this.store.directory.require(participant.id),
          transcript: after.thread.messages,
          budget: { invocationsUsed: after.session.invocationsUsed, maxInvocations: session.limits.maxInvocations, tokensUsed: after.session.tokensUsed, maxTokens: session.limits.maxTokens ?? null },
        };

        let reply: TurnReply;
        try {
          reply = await this.ask(participant, ctx, options.signal);
        } catch (err) {
          if (options.signal?.aborted) return this.suspend(sessionId, fence, String(options.signal.reason ?? 'aborted'));
          const reason = err instanceof TurnTimeout ? `${participant.id} did not answer within ${this.turnTimeoutMs} ms` : `${participant.id} failed: ${(err as Error)?.message ?? String(err)}`;
          this.store.closeTurn(sessionId, fence, pending, { failed: { reason } });
          return this.conclude(sessionId, fence, 'failed', reason);
        }

        try {
          this.store.post({
            threadId: session.threadId,
            authorId: participant.id,
            kind: reply.kind,
            body: reply.body,
            parentId: reply.parentId,
            evidence: reply.evidence,
            decision: reply.decision,
            invocation: reply.invocation ?? {},
            session: { sessionId, fence, round: pending.round, turn: pending.turn, attempt: pending.attempt },
          });
        } catch (err) {
          if (!(err instanceof CollaborationError) || !REJECTED_REPLY.has(err.code)) throw err;
          // The reply broke a rule (out-of-role decision, bad parent, oversize body, ...). The turn is spent and the
          // attempted content is kept in the audit trail; the meeting goes on.
          this.store.closeTurn(sessionId, fence, pending, { rejected: { reason: `${err.code}: ${err.message}`, attempted: { kind: String(reply?.kind), body: typeof reply?.body === 'string' ? reply.body : '' } } });
        }
      } catch (err) {
        // Lost the session (cancelled, superseded) while working: the top of the loop reports which.
        if (err instanceof CollaborationError && RECOVERABLE_WRITE.has(err.code)) continue;
        throw err;
      }
    }
  }

  private async ask(p: Participant, ctx: TurnContext, outer?: AbortSignal): Promise<TurnReply> {
    const ac = new AbortController();
    const onAbort = () => ac.abort(outer?.reason);
    outer?.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    // The flag, not the order promises settle in, decides the cause: aborting the participant makes it reject too.
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new TurnTimeout());
        ac.abort(new TurnTimeout());
      }, this.turnTimeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      if (outer?.aborted) reject(new Error('aborted'));
      outer?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    try {
      return await Promise.race([p.respond(ctx, ac.signal), timeout, aborted]);
    } catch (err) {
      throw timedOut ? new TurnTimeout() : err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  private conclude(sessionId: string, fence: SessionFence, outcome: Exclude<SessionOutcome, 'cancelled'>, reason: string): CoordinatorResult {
    return { status: 'concluded', outcome, record: this.store.concludeSession(sessionId, fence, outcome, reason) };
  }

  private suspend(sessionId: string, fence: SessionFence, reason: string): CoordinatorResult {
    this.store.suspendSession(sessionId, fence, reason);
    return { status: 'suspended', reason };
  }

  private closed(sessionId: string): CoordinatorResult {
    const { session } = this.store.session(sessionId);
    const record = this.store.record(sessionId)!;
    return session.status === 'cancelled' ? { status: 'cancelled', record } : { status: 'concluded', outcome: session.outcome!.outcome as Exclude<SessionOutcome, 'cancelled'>, record };
  }
}

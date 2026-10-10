import type { Participant, TurnContext, TurnReply } from '../coordinator.ts';
import type { ParticipantIdentity, MessageKind, MessageView } from '../types.ts';

/**
 * Deterministic test doubles for meeting participants. None of them calls a model: a reply is a pure function of the round
 * and the transcript, so the same session replays to the same events.
 */

export type ScriptStep = TurnReply | ((ctx: TurnContext) => TurnReply);

/** Answers round N with script[N-1]; past the end of the script it passes. Records every turn it was asked. */
export class ScriptedParticipant implements Participant {
  readonly id: string;
  readonly asked: { round: number; turn: number; attempt: number }[] = [];
  private readonly script: readonly ScriptStep[];

  constructor(id: string, script: readonly ScriptStep[]) {
    this.id = id;
    this.script = script;
  }

  async respond(ctx: TurnContext): Promise<TurnReply> {
    this.asked.push({ round: ctx.round, turn: ctx.turn, attempt: ctx.attempt });
    const step = this.script[ctx.round - 1];
    if (!step) return { kind: 'pass', body: `${this.id} has nothing to add` };
    return typeof step === 'function' ? step(ctx) : step;
  }
}

/** Throws on every turn (a provider error). */
export class FailingParticipant implements Participant {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  async respond(): Promise<TurnReply> {
    throw new Error('provider unavailable (fake)');
  }
}

/** Never answers until aborted (a hung model call). */
export class HangingParticipant implements Participant {
  readonly id: string;
  calls = 0;
  constructor(id: string) {
    this.id = id;
  }
  respond(_ctx: TurnContext, signal: AbortSignal): Promise<TurnReply> {
    this.calls += 1;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }
}

/** Latest message of a kind (optionally by an author) in the transcript; throws if none, so a script bug is loud. */
export function latest(ctx: TurnContext, kind: MessageKind, authorId?: string): MessageView {
  const m = [...ctx.transcript].reverse().find((x) => x.kind === kind && (!authorId || x.author.id === authorId));
  if (!m) throw new Error(`fake script: no ${kind}${authorId ? ` by ${authorId}` : ''} in the transcript`);
  return m;
}

/** A fixed engineering roster for tests: one lead (chair), an architect, two implementers, a reviewer and an operator. */
export const TEST_ROSTER: ParticipantIdentity[] = [
  { id: 'claude-engineering-lead', role: 'engineering_lead', kind: 'lead', provider: 'fake', model: 'scripted-lead' },
  { id: 'architect', role: 'architect', kind: 'worker', provider: 'fake', model: 'scripted-architect' },
  { id: 'worker-codex', role: 'implementer', kind: 'worker', provider: 'fake', model: 'scripted-codex' },
  { id: 'worker-ollama', role: 'implementer', kind: 'worker', provider: 'fake', model: 'scripted-qwen' },
  { id: 'reviewer', role: 'reviewer', kind: 'reviewer', provider: 'fake', model: 'scripted-reviewer' },
  { id: 'operator', role: 'operator', kind: 'operator' },
];

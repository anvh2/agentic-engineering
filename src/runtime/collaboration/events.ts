import { createHash } from 'node:crypto';
import type { MeetingRecord } from './record.ts';
import type { ParticipantIdentity, MessageView, PendingTurn, SessionLimits, SessionOutcome, ThreadInfo } from './types.ts';

/**
 * Event shapes of a discussion thread. One thread is one stream; sessions live inside their thread's stream, so a session's
 * history and the messages it produced are ordered in one sequence. Events are append-only (SQLite triggers refuse UPDATE
 * and DELETE) and hash-chained per thread: each `hash` covers the previous hash and this event's canonical content, so a
 * rewritten or reordered contribution is detected on replay and the thread fails closed.
 */

export type StoredMessage = Omit<MessageView, 'seq' | 'correctedBy' | 'withdrawnBy'>;

export type CollabEventPayload =
  | { type: 'thread.opened'; thread: ThreadInfo }
  | { type: 'message.posted'; message: StoredMessage }
  | { type: 'session.opened'; session: { id: string; agenda: string[]; participants: string[]; chair: string; limits: SessionLimits; openedBy: string } }
  | { type: 'session.claimed'; sessionId: string; owner: string; epoch: number; previousOwner: string | null }
  | { type: 'session.suspended'; sessionId: string; owner: string; epoch: number; reason: string }
  | { type: 'turn.reserved'; sessionId: string; round: number; turn: number; participant: string; attempt: number; epoch: number; invocationNo: number }
  | { type: 'turn.abandoned'; sessionId: string; round: number; turn: number; participant: string; attempt: number; reason: string }
  | { type: 'turn.rejected'; sessionId: string; round: number; turn: number; participant: string; attempt: number; reason: string; attempted: { kind: string; body: string } }
  | { type: 'turn.failed'; sessionId: string; round: number; turn: number; participant: string; attempt: number; reason: string }
  | { type: 'session.concluded'; sessionId: string; outcome: Exclude<SessionOutcome, 'cancelled'>; reason: string; record: MeetingRecord }
  | { type: 'session.cancelled'; sessionId: string; actor: ParticipantIdentity | { id: string; kind: 'coordinator' }; reason: string; abandonedTurn: PendingTurn | null; record: MeetingRecord };

export type CollabEventType = CollabEventPayload['type'];

export interface CollabEvent {
  seq: number;
  threadId: string;
  type: CollabEventType;
  at: number;
  actor: string;
  idempotencyKey: string;
  payload: CollabEventPayload;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

/** JSON with object keys sorted at every level: the byte form every hash in this module is computed over. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function eventHash(prevHash: string, e: Pick<CollabEvent, 'threadId' | 'type' | 'at' | 'actor' | 'idempotencyKey' | 'payload'>): string {
  return sha256(`${prevHash}\n${canonicalJson({ threadId: e.threadId, type: e.type, at: e.at, actor: e.actor, idempotencyKey: e.idempotencyKey, payload: e.payload })}`);
}

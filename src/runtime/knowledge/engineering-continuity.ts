/**
 * Session continuity and engineering decisions: deterministic, side-effect-free adapters.
 * Inspired by ECC memory-persistence hooks and ADR workflow.
 * These do not install hooks, create a scheduler, or confer approval authority.
 */
import { createHash } from 'node:crypto';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const EVENTS = ['session-start','before-compact','checkpoint','session-end'] as const;
export type SessionEventName = typeof EVENTS[number];

export interface SessionObservation {
  sessionId: string;
  taskId: string;
  seq: number;
  event: SessionEventName;
  stateRef: string;
  stateDigest: string;
}

export interface SessionObservationStore {
  /** Adapter implementation MUST serialize one session and reject conflicting seq digests. */
  recordOnce(event: Readonly<SessionObservation & { fingerprint: string }>): Promise<'written' | 'exists'>;
}

/**
 * The caller supplies a *runtime-owned* stateRef/digest, not a transcript or model claim.
 * Same event replays have the same fingerprint; no mutable/secret payload is recorded.
 */
export function normalizeSessionObservation(event: SessionObservation): Readonly<SessionObservation & { fingerprint: string }> {
  if (!IDENTIFIER.test(event.sessionId) || !IDENTIFIER.test(event.taskId)
    || !Number.isSafeInteger(event.seq) || event.seq < 0
    || !EVENTS.includes(event.event)
    || !IDENTIFIER.test(event.stateRef)
    || !/^[a-f0-9]{64}$/.test(event.stateDigest)) {
    throw new Error('continuity: invalid runtime observation');
  }
  // Explicit field projection prevents an already-normalized event's fingerprint
  // from contaminating its own digest during replay or persistence.
  const clone = { sessionId:event.sessionId, taskId:event.taskId, seq:event.seq,
    event:event.event, stateRef:event.stateRef, stateDigest:event.stateDigest };
  return Object.freeze({ ...clone, fingerprint: hash(JSON.stringify(clone)) });
}

export async function recordSessionObservation(store: SessionObservationStore, event: SessionObservation): Promise<'written' | 'exists'> {
  return store.recordOnce(normalizeSessionObservation(event));
}

/** ADRs have status distinct from runtime design approval. */
export type AdrStatus = 'proposed' | 'accepted' | 'deprecated' | 'superseded';
export type AdrRecord = Readonly<{
  id: string;
  revision: string;
  status: AdrStatus;
  context: string;
  decision: string;
  alternatives: readonly string[];
  consequences: string;
  sourceRef: string;
  /** The accepted record this one replaces, as `ADR-0001@v1`. Part of the digest only when present. */
  supersedes?: string;
}>;

export function pinAdr(record: AdrRecord): Readonly<AdrRecord & { digest: string }> {
  if (!/^ADR-[0-9]{4,}$/.test(record.id) || !IDENTIFIER.test(record.revision)
    || !['proposed','accepted','deprecated','superseded'].includes(record.status)
    || !record.context.trim() || !record.decision.trim() || !record.consequences.trim()
    || !record.sourceRef.trim() || record.alternatives.length > 20
    || (record.supersedes !== undefined && !/^ADR-[0-9]{4,}@[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(record.supersedes))
    || record.alternatives.some(x=>!x.trim())
    || Buffer.byteLength(JSON.stringify(record),'utf8') > 32_768) {
    throw new Error('continuity: invalid ADR');
  }
  const canonical = JSON.stringify({
    id:record.id,revision:record.revision,status:record.status,
    context:record.context,decision:record.decision,
    alternatives:[...record.alternatives],consequences:record.consequences,sourceRef:record.sourceRef,
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
  });
  return Object.freeze({ ...record, alternatives:Object.freeze([...record.alternatives]), digest:hash(canonical) });
}

/** Proposed and revoked decisions cannot be silently presented as accepted. */
export function acceptedAdrContext(records: readonly AdrRecord[]): Readonly<{ text:string; digest:string }> {
  const pinned = records.map(pinAdr).filter(a=>a.status==='accepted').sort((a,b)=>a.id.localeCompare(b.id));
  const seen = new Set<string>();
  for(const record of pinned) {
    if(seen.has(record.id)) throw new Error('continuity: ambiguous accepted ADR revision');
    seen.add(record.id);
  }
  const text = pinned.map(x=>`ADR ${x.id}@${x.revision} [${x.digest}]\nDecision: ${x.decision}\nConsequences: ${x.consequences}`).join('\n\n');
  return Object.freeze({text,digest:hash(text)});
}

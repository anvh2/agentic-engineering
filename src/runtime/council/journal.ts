import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CouncilPhase } from './contract.ts';

/**
 * One line per REAL model call a council made, including re-asks and failed calls. The store holds the accepted messages;
 * this holds what the store cannot: how many calls it took, which run/trace each had, what it cost, why a reply was refused.
 * It is append-only evidence, never state the council decides from except the per-seat budget (which fails closed).
 *
 * Raw model text is never written here: a refused reply is recorded by reason, length and digest, so an invalid reply cannot
 * smuggle content (or a credential) into the journal.
 */
export interface CallEntry {
  at: number;
  meetingId: string;
  participantId: string;
  specialistId: string;
  phase: CouncilPhase;
  round: number;
  turn: number;
  /** 1-based call number within the turn (2 means a re-ask). */
  attempt: number;
  provider: string;
  model: string;
  runId: string | null;
  traceId: string | null;
  outcome: 'accepted' | 'invalid' | 'error';
  reason: string | null;
  inferenceMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: readonly { tool: string; count: number }[];
  steps: number | null;
  replyBytes: number;
  replySha256: string | null;
}

export interface CallJournal {
  append(entry: CallEntry): void;
  entries(meetingId: string): readonly CallEntry[];
}

export class MemoryJournal implements CallJournal {
  private readonly rows: CallEntry[] = [];
  append(entry: CallEntry): void { this.rows.push(Object.freeze({ ...entry })); }
  entries(meetingId: string): readonly CallEntry[] { return this.rows.filter((r) => r.meetingId === meetingId); }
}

/** JSON Lines on disk. Survives a restart: a resumed meeting counts the calls the first process already made. */
export class FileJournal implements CallJournal {
  private readonly path: string;
  constructor(path: string) { this.path = path; }
  append(entry: CallEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }
  entries(meetingId: string): readonly CallEntry[] {
    if (!existsSync(this.path)) return [];
    const out: CallEntry[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row: CallEntry;
      try { row = JSON.parse(line) as CallEntry; } catch { throw new Error(`council journal ${this.path} has an unreadable line; refusing to count budget from a damaged journal`); }
      if (row.meetingId === meetingId) out.push(row);
    }
    return out;
  }
}

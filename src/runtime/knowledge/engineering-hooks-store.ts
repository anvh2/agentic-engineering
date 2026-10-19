/**
 * Durable, append-only log of ACCEPTED lifecycle hook events, so a restarted or resumed session continues from verified state
 * and never repeats a completed side effect.
 *
 * `accept` runs the whole decision inside one write-locked transaction against a session rebuilt from the stored events, so
 * there is no in-memory state that can diverge from the database (a crash between "decided" and "recorded" leaves nothing
 * recorded and nothing decided), and two processes cannot both accept the same sequence number. A replay of an accepted event
 * is answered with `replay: true` and writes nothing; the caller must then skip the side effect.
 */
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from './canonical.ts';
import { HookSession, type HookDecision, type HookEvent, type HookPolicy } from './engineering-hooks.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS engineering_hook_events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, fingerprint TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TRIGGER IF NOT EXISTS engineering_hook_events_no_update BEFORE UPDATE ON engineering_hook_events BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS engineering_hook_events_no_delete BEFORE DELETE ON engineering_hook_events BEGIN SELECT RAISE(ABORT,'append only'); END;
`;

export class DurableHookLog {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(db: DatabaseSync, options: { now?: () => number } = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SQL);
  }

  events(sessionId: string): readonly HookEvent[] {
    const rows = this.db.prepare('SELECT event_json FROM engineering_hook_events WHERE session_id=? ORDER BY seq').all(sessionId) as unknown as { event_json: string }[];
    return rows.map((r) => JSON.parse(r.event_json) as HookEvent);
  }

  /**
   * Decides one event for `sessionId` against `policy` and, if newly accepted, records it atomically. Never throws: lock
   * contention, a corrupted log or a policy the stored history no longer satisfies all come back as a rejection (fail closed).
   * The session is rebuilt and re-validated from the stored log on EVERY call. A cached copy would be trusted while its position
   * matched the log's, which hides in-place tampering of an already stored event; a session is tens of events, so the rebuild is cheap.
   */
  accept(policy: HookPolicy, sessionId: string, raw: unknown): HookDecision {
    const reject = (reason: string): HookDecision => Object.freeze({ accepted: false, reason: `hook log unusable: ${reason}`, eventFingerprint: '' });
    try { this.db.exec('BEGIN IMMEDIATE'); } catch (error) { return reject((error as Error).message); }
    try {
      const session = HookSession.restore(policy, sessionId, this.events(sessionId));
      const decision = session.accept(raw);
      if (decision.accepted && !decision.replay) {
        const event = raw as HookEvent;
        this.db.prepare('INSERT INTO engineering_hook_events (session_id,seq,event_json,fingerprint,recorded_at) VALUES (?,?,?,?,?)')
          .run(sessionId, event.seq, canonicalJson(event), decision.eventFingerprint, this.now());
      }
      this.db.exec('COMMIT');
      return decision;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* the connection is already outside a transaction */ }
      return reject((error as Error).message);
    }
  }
}

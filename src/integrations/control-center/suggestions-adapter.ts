import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { attribute, type Attribution } from './collaboration-adapter.ts';

/**
 * Read-only view of meeting suggestions (src/lead/collaboration/suggestions.ts) in the scheduler of record. A suggestion is NOT
 * a meeting: nothing was opened and nobody met. The payload says so (`kind: 'suggestion'`) so a client can never list one as a
 * meeting. Attribution is re-derived from the suggestion's own batch and task references, exactly as for threads.
 */
export interface MeetingSuggestionView {
  kind: 'suggestion';
  id: string;
  status: 'pending' | 'accepted' | 'dismissed';
  meetingType: string;
  category: string;
  objectiveId: string | null;
  batchId: string;
  taskId: string | null;
  attribution: Attribution;
  reason: string;
  evidence: { kind: string; ref: string; detail: string }[];
  participants: { id: string; role: string; note: string }[];
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  /** The real meeting opened when the suggestion was accepted. */
  sessionId: string | null;
}

export interface SuggestionsSnapshot {
  availability: 'AVAILABLE' | 'NOT_AVAILABLE';
  reason: string | null;
  pending: number;
  suggestions: MeetingSuggestionView[];
}

export type SuggestionReader = { snapshot(): SuggestionsSnapshot };

const iso = (ms: number | null) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export function createSuggestionReader(options: { dbPath: string }): SuggestionReader {
  return {
    snapshot() {
      if (!existsSync(options.dbPath)) return { availability: 'NOT_AVAILABLE', reason: 'The scheduler database does not exist.', pending: 0, suggestions: [] };
      const db = new DatabaseSync(options.dbPath, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 250; PRAGMA query_only = ON;');
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meeting_suggestions'").get()) {
          return { availability: 'AVAILABLE', reason: 'No meeting has been suggested in this scheduler database.', pending: 0, suggestions: [] };
        }
        const rows = db.prepare('SELECT * FROM meeting_suggestions ORDER BY created_at DESC, id DESC LIMIT 200').all() as Record<string, any>[];
        const suggestions = rows.map((r): MeetingSuggestionView => ({
          kind: 'suggestion', id: r.id, status: r.status, meetingType: r.meeting_type, category: r.category,
          objectiveId: r.objective_id ?? null, batchId: r.batch_id, taskId: r.task_id ?? null,
          attribution: attribute(db, { batchId: r.batch_id, ...(r.task_id ? { taskId: r.task_id } : {}) }),
          reason: r.reason, evidence: JSON.parse(r.evidence), participants: JSON.parse(r.participants),
          createdAt: iso(r.created_at)!, decidedAt: iso(r.decided_at ?? null), decidedBy: r.decided_by ?? null, decisionReason: r.decision_reason ?? null, sessionId: r.session_id ?? null,
        }));
        return { availability: 'AVAILABLE', reason: null, pending: suggestions.filter((s) => s.status === 'pending').length, suggestions };
      } finally {
        db.close();
      }
    },
  };
}

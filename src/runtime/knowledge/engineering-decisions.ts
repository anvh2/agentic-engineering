/**
 * Durable architecture decisions: immutable revisions, signed status changes, supersession and task traceability.
 *
 * An ADR records WHY something was decided. It is deliberately NOT an authorization: accepting a decision does not approve a
 * design for execution, widen a task, or satisfy `approvedDesign` verification. Those remain runtime-owned (design-approval.ts).
 *
 * Integrity is enforced by the database, as in the knowledge store: revisions are immutable and never deleted, status changes
 * are append-only events, and a given (id, revision) can be accepted at most once. Accepting or deprecating needs a statement
 * signed by a key the runtime trusts for the `promoter` role, bound to the exact record digest, and used at most once.
 * Acceptance and the supersession it implies happen in one write-locked transaction, so there is never a moment with two
 * accepted revisions of one decision or none (check-then-act race).
 */
import { DatabaseSync } from 'node:sqlite';
import { acceptedAdrContext, pinAdr, type AdrRecord } from './engineering-continuity.ts';
import { verifyStatement, type SignedStatement, type TrustedKeyring } from './trust.ts';

export const DECISION_DOMAIN = 'decision.status/v1';
export type DecisionAction = 'accept' | 'deprecate';
export interface DecisionGrant { action: DecisionAction; id: string; revision: string; digest: string; nonce: string; expiresAt: number }

const SQL = `
CREATE TABLE IF NOT EXISTS engineering_decisions (
  id TEXT NOT NULL, revision TEXT NOT NULL, digest TEXT NOT NULL, record_json TEXT NOT NULL, supersedes TEXT, proposed_at INTEGER NOT NULL,
  PRIMARY KEY (id, revision)
);
CREATE TABLE IF NOT EXISTS engineering_decision_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, revision TEXT NOT NULL, event TEXT NOT NULL,
  digest TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT, key_id TEXT, nonce TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS engineering_decision_one_accept ON engineering_decision_events(id, revision) WHERE event = 'accepted';
CREATE UNIQUE INDEX IF NOT EXISTS engineering_decision_nonce ON engineering_decision_events(nonce) WHERE nonce IS NOT NULL;
CREATE TABLE IF NOT EXISTS engineering_decision_links (
  task_id TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, digest TEXT NOT NULL, linked_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, id)
);
CREATE TRIGGER IF NOT EXISTS engineering_decisions_no_update BEFORE UPDATE ON engineering_decisions BEGIN SELECT RAISE(ABORT,'decision revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS engineering_decisions_no_delete BEFORE DELETE ON engineering_decisions BEGIN SELECT RAISE(ABORT,'decision revisions are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS engineering_decision_events_no_update BEFORE UPDATE ON engineering_decision_events BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS engineering_decision_events_no_delete BEFORE DELETE ON engineering_decision_events BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS engineering_decision_links_no_update BEFORE UPDATE ON engineering_decision_links BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS engineering_decision_links_no_delete BEFORE DELETE ON engineering_decision_links BEGIN SELECT RAISE(ABORT,'append only'); END;
`;

type Status = 'proposed' | 'accepted' | 'superseded' | 'deprecated';
interface Row { id: string; revision: string; digest: string; record_json: string; supersedes: string | null }

export class DurableDecisionLog {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(db: DatabaseSync, options: { now?: () => number } = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SQL);
  }

  /** Records a new revision as `proposed`. Callers cannot propose an already-accepted record: status is derived from events. */
  propose(record: AdrRecord): string {
    if (record.status !== 'proposed') throw new Error('decisions: a record enters the log as proposed; acceptance needs a signed grant');
    const pinned = pinAdr(record);
    if (record.supersedes && record.supersedes.split('@')[0] !== record.id) throw new Error('decisions: a revision can only supersede an earlier revision of the same decision');
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM engineering_decisions WHERE id=? AND revision=?').get(record.id, record.revision)) throw new Error('decisions: revision already exists');
      this.db.prepare('INSERT INTO engineering_decisions (id,revision,digest,record_json,supersedes,proposed_at) VALUES (?,?,?,?,?,?)')
        .run(record.id, record.revision, pinned.digest, JSON.stringify(record), record.supersedes ?? null, this.now());
      this.event(record.id, record.revision, 'proposed', pinned.digest);
    });
    return pinned.digest;
  }

  accept(id: string, revision: string, statement: SignedStatement<DecisionGrant> | undefined, keyring: TrustedKeyring): void {
    this.change('accept', id, revision, statement, keyring, (row) => {
      if (this.statusOf(id, revision) !== 'proposed') throw new Error('decisions: only a proposed revision can be accepted');
      const previousRef = row.supersedes;
      if (previousRef) {
        const [prevId, prevRev] = previousRef.split('@') as [string, string];
        if (this.statusOf(prevId, prevRev) !== 'accepted') throw new Error('decisions: the superseded revision is not currently accepted');
      }
      const current = this.acceptedRevision(id);
      if (current && current !== previousRef?.split('@')[1]) throw new Error(`decisions: ${id} already has accepted revision ${current}; propose a revision that supersedes it`);
      const digest = row.digest;
      if (previousRef) {
        const [prevId, prevRev] = previousRef.split('@') as [string, string];
        this.event(prevId, prevRev, 'superseded', (this.db.prepare('SELECT digest FROM engineering_decisions WHERE id=? AND revision=?').get(prevId, prevRev) as { digest: string }).digest);
      }
      return { event: 'accepted', digest };
    });
  }

  deprecate(id: string, revision: string, statement: SignedStatement<DecisionGrant> | undefined, keyring: TrustedKeyring): void {
    this.change('deprecate', id, revision, statement, keyring, (row) => {
      if (this.statusOf(id, revision) !== 'accepted') throw new Error('decisions: only an accepted revision can be deprecated');
      return { event: 'deprecated', digest: row.digest };
    });
  }

  private change(action: DecisionAction, id: string, revision: string, statement: SignedStatement<DecisionGrant> | undefined, keyring: TrustedKeyring,
    apply: (row: Row) => { event: string; digest: string }): void {
    const row = this.row(id, revision);
    if (!row) throw new Error('decisions: unknown revision');
    const verdict = verifyStatement<DecisionGrant>(keyring, statement, { domain: DECISION_DOMAIN, role: 'promoter', now: this.now() });
    const g = verdict.ok ? verdict.payload : undefined;
    if (!verdict.ok || !g || g.action !== action || g.id !== id || g.revision !== revision || g.digest !== row.digest
      || typeof g.nonce !== 'string' || g.nonce.length < 8 || g.nonce.length > 128 || !Number.isFinite(g.expiresAt) || g.expiresAt < this.now()) throw new Error(`decisions: ${action} not authorized`);
    this.transaction(() => {
      const outcome = apply(row);
      this.event(id, revision, outcome.event, outcome.digest, verdict.principalId, verdict.keyId, g.nonce);
    });
  }

  /** Accepted decisions as worker/reviewer context. Proposed, superseded and deprecated records never appear. */
  acceptedContext(): Readonly<{ text: string; digest: string }> {
    const latest = this.latestStatuses();
    const rows = this.db.prepare('SELECT id, revision, record_json FROM engineering_decisions ORDER BY id, revision').all() as unknown as Row[];
    const accepted = rows.filter((r) => latest.get(`${r.id}@${r.revision}`) === 'accepted').map((r) => ({ ...(JSON.parse(r.record_json) as AdrRecord), status: 'accepted' as const }));
    return acceptedAdrContext(accepted);
  }

  /** Current status of every revision from ONE query (the newest event per revision), not one query per row. */
  private latestStatuses(): Map<string, Status> {
    const rows = this.db.prepare(`SELECT e.id, e.revision, e.event FROM engineering_decision_events e
      WHERE e.seq = (SELECT MAX(seq) FROM engineering_decision_events WHERE id = e.id AND revision = e.revision)`).all() as unknown as { id: string; revision: string; event: string }[];
    return new Map(rows.map((r) => [`${r.id}@${r.revision}`, r.event as Status]));
  }

  /** Links an ACCEPTED revision to a task for traceability. This confers no approval and no permission of any kind. */
  linkToTask(taskId: string, id: string, revision: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(taskId)) throw new Error('decisions: invalid task id');
    this.transaction(() => {
      const row = this.row(id, revision);
      if (!row) throw new Error('decisions: unknown revision');
      if (this.statusOf(id, revision) !== 'accepted') throw new Error('decisions: only an accepted revision can be linked to a task');
      this.db.prepare('INSERT OR IGNORE INTO engineering_decision_links (task_id,id,revision,digest,linked_at) VALUES (?,?,?,?,?)').run(taskId, id, revision, row.digest, this.now());
      const link = this.db.prepare('SELECT revision FROM engineering_decision_links WHERE task_id=? AND id=?').get(taskId, id) as { revision: string };
      if (link.revision !== revision) throw new Error('decisions: this task is already linked to a different revision of the decision');
    });
  }

  /** Which decisions (at which pinned digest) a task was planned under, and whether each is still current. */
  traceability(taskId: string): readonly { id: string; revision: string; digest: string; status: Status }[] {
    const rows = this.db.prepare('SELECT id, revision, digest FROM engineering_decision_links WHERE task_id=? ORDER BY id').all(taskId) as unknown as { id: string; revision: string; digest: string }[];
    return rows.map((r) => ({ ...r, status: this.statusOf(r.id, r.revision) }));
  }

  statusOf(id: string, revision: string): Status {
    const events = this.db.prepare('SELECT event FROM engineering_decision_events WHERE id=? AND revision=? ORDER BY seq').all(id, revision) as unknown as { event: string }[];
    if (!events.length) throw new Error('decisions: unknown revision');
    return events.at(-1)!.event as Status;
  }

  history(id: string): readonly { revision: string; event: string; at: number; actor: string | null }[] {
    return (this.db.prepare('SELECT revision, event, at, actor FROM engineering_decision_events WHERE id=? ORDER BY seq').all(id) as unknown as { revision: string; event: string; at: number; actor: string | null }[]);
  }

  private acceptedRevision(id: string): string | undefined {
    const prefix = `${id}@`;
    return [...this.latestStatuses()].find(([key, status]) => key.startsWith(prefix) && status === 'accepted')?.[0].slice(prefix.length);
  }

  private row(id: string, revision: string): Row | undefined {
    return this.db.prepare('SELECT id, revision, digest, record_json, supersedes FROM engineering_decisions WHERE id=? AND revision=?').get(id, revision) as unknown as Row | undefined;
  }

  private event(id: string, revision: string, event: string, digest: string, actor?: string, keyId?: string, nonce?: string): void {
    this.db.prepare('INSERT INTO engineering_decision_events (id,revision,event,digest,at,actor,key_id,nonce) VALUES (?,?,?,?,?,?,?,?)').run(id, revision, event, digest, this.now(), actor ?? null, keyId ?? null, nonce ?? null);
  }

  /** No awaits inside: the whole check-then-act runs under one write lock, across processes too. */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

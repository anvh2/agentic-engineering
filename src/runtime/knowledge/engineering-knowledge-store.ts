/**
 * SQLite persistence for promoted engineering knowledge and session continuity.
 *
 * Authority: nothing becomes active knowledge, and nothing is revoked, without a statement signed by a key the runtime
 * trusts for the `promoter` role, bound to the exact action, entry digest and project, and used at most once. The model, a
 * worker and a caller-supplied boolean can never promote (see trust.ts, F-04/F-05).
 *
 * Integrity is enforced by the database, not only by this class: triggers make promoted rows immutable except for a single
 * one-way revoke, and make every audit table append-only. A raw `UPDATE ... SET revoked_at = NULL` (F-02) now aborts.
 */
import { DatabaseSync } from 'node:sqlite';
import { entryDigest, EngineeringKnowledgeCatalog, type KnowledgeEntry } from './engineering-knowledge.ts';
import { hashValue, sha256Hex } from './canonical.ts';
import { verifyStatement, type SignedStatement, type TrustedKeyring } from './trust.ts';
import { normalizeSessionObservation, type SessionObservation, type SessionObservationStore } from './engineering-continuity.ts';

export const PROMOTION_DOMAIN = 'knowledge.promotion/v1';
export type PromotionAction = 'promote' | 'revoke' | 'supersede';

/** What a promoter signs. Every field is re-derived by the store; nothing here is trusted on its own. */
export interface PromotionGrant {
  action: PromotionAction;
  entryId: string;
  /** Digest of the exact entry being promoted (`entryDigest`), or of the revoked entry for `revoke`. */
  digest: string;
  projectId: string | null;
  /** Unique per authorization; reuse is refused (replay). */
  nonce: string;
  expiresAt: number;
  /** supersede only: the active revision being replaced. */
  replacesRevision?: string;
}

export interface AuthorizedPrincipal { principalId: string; keyId: string }
export interface PromotionAuthority {
  /** Returns the authenticated principal only when `statement` authorizes EXACTLY `expected`. */
  authorize(statement: SignedStatement<PromotionGrant> | undefined, expected: Omit<PromotionGrant, 'nonce' | 'expiresAt'>): AuthorizedPrincipal | undefined;
}

export function keyringPromotionAuthority(keyring: TrustedKeyring, now: () => number = Date.now): PromotionAuthority {
  return {
    authorize(statement, expected) {
      const verdict = verifyStatement<PromotionGrant>(keyring, statement, { domain: PROMOTION_DOMAIN, role: 'promoter', now: now() });
      if (!verdict.ok) return undefined;
      const g = verdict.payload;
      if (!g || g.action !== expected.action || g.entryId !== expected.entryId || g.digest !== expected.digest
        || (g.projectId ?? null) !== (expected.projectId ?? null) || (g.replacesRevision ?? null) !== (expected.replacesRevision ?? null)) return undefined;
      if (typeof g.nonce !== 'string' || g.nonce.length < 8 || g.nonce.length > 128 || !Number.isFinite(g.expiresAt) || g.expiresAt < now()) return undefined;
      return { principalId: verdict.principalId, keyId: verdict.keyId };
    },
  };
}

const SQL = `
CREATE TABLE IF NOT EXISTS engineering_knowledge (
  id TEXT NOT NULL, revision TEXT NOT NULL, project_id TEXT, manifest_json TEXT NOT NULL, digest TEXT NOT NULL,
  approved_at INTEGER NOT NULL, principal_id TEXT NOT NULL, key_id TEXT NOT NULL, auth_nonce TEXT NOT NULL,
  revoked_at INTEGER, superseded_by TEXT,
  PRIMARY KEY (id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS engineering_knowledge_one_active ON engineering_knowledge(id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS engineering_knowledge_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, knowledge_id TEXT NOT NULL, revision TEXT NOT NULL,
  action TEXT NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, key_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS engineering_knowledge_authorizations (
  nonce TEXT PRIMARY KEY, action TEXT NOT NULL, digest TEXT NOT NULL, used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS engineering_session_events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
  PRIMARY KEY(session_id,seq)
);
CREATE TRIGGER IF NOT EXISTS engineering_knowledge_no_delete
 BEFORE DELETE ON engineering_knowledge BEGIN SELECT RAISE(ABORT,'knowledge records are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS engineering_knowledge_one_way_revoke
 BEFORE UPDATE ON engineering_knowledge
 WHEN NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
   AND NEW.id IS OLD.id AND NEW.revision IS OLD.revision AND NEW.project_id IS OLD.project_id AND NEW.manifest_json IS OLD.manifest_json
   AND NEW.digest IS OLD.digest AND NEW.approved_at IS OLD.approved_at AND NEW.principal_id IS OLD.principal_id
   AND NEW.key_id IS OLD.key_id AND NEW.auth_nonce IS OLD.auth_nonce)
 BEGIN SELECT RAISE(ABORT,'knowledge records are immutable; revocation is one-way'); END;
CREATE TRIGGER IF NOT EXISTS engineering_knowledge_events_no_delete
 BEFORE DELETE ON engineering_knowledge_events BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS engineering_knowledge_events_no_update
 BEFORE UPDATE ON engineering_knowledge_events BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS engineering_knowledge_auth_no_delete
 BEFORE DELETE ON engineering_knowledge_authorizations BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS engineering_knowledge_auth_no_update
 BEFORE UPDATE ON engineering_knowledge_authorizations BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS engineering_session_events_no_delete
 BEFORE DELETE ON engineering_session_events BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS engineering_session_events_no_update
 BEFORE UPDATE ON engineering_session_events BEGIN SELECT RAISE(ABORT,'append only'); END;
`;

interface KnowledgeRow { id: string; revision: string; project_id: string | null; manifest_json: string; digest: string; revoked_at: number | null }

export class DurableEngineeringKnowledge implements SessionObservationStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(db: DatabaseSync, options: { now?: () => number } = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    // Cross-process writers queue behind BEGIN IMMEDIATE instead of failing with SQLITE_BUSY.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SQL);
  }

  /**
   * Promote a pre-validated entry. The entry must arrive inactive (`approved:false`); activation is the act this method
   * performs, authorized by `statement`. `entry.projectId` scopes it; omit it for global curated content.
   */
  promote(candidate: KnowledgeEntry, statement: SignedStatement<PromotionGrant> | undefined, authority: PromotionAuthority): void {
    this.activate('promote', candidate, statement, authority);
  }

  /** Atomically retire the active revision of `candidate.id` and activate a new revision (version bump, or rollback by re-promoting older content). */
  supersede(candidate: KnowledgeEntry, replacesRevision: string, statement: SignedStatement<PromotionGrant> | undefined, authority: PromotionAuthority): void {
    this.activate('supersede', candidate, statement, authority, replacesRevision);
  }

  private activate(action: 'promote' | 'supersede', candidate: KnowledgeEntry, statement: SignedStatement<PromotionGrant> | undefined, authority: PromotionAuthority, replacesRevision?: string): void {
    if (candidate.approved) throw new Error('knowledge: candidate must start inactive');
    const entry: KnowledgeEntry = { ...candidate, approved: true };
    // Exactly the validation the worker-side resolver applies (shape, size, ids, scope).
    new EngineeringKnowledgeCatalog([entry], { projectId: entry.projectId });
    const digest = entryDigest(entry);
    const principal = authority.authorize(statement, { action, entryId: entry.id, digest, projectId: entry.projectId ?? null, replacesRevision });
    if (!principal || !statement) throw new Error('knowledge: promotion not authorized');
    const nonce = statement.payload.nonce;
    this.transaction(() => {
      this.consumeNonce(nonce, action, digest);
      if (action === 'supersede') {
        const old = this.db.prepare('SELECT id, revision, revoked_at FROM engineering_knowledge WHERE id=? AND revision=?').get(entry.id, replacesRevision!) as KnowledgeRow | undefined;
        if (!old) throw new Error('knowledge: superseded revision unknown');
        if (old.revoked_at !== null) throw new Error('knowledge: superseded revision already inactive');
        this.db.prepare('UPDATE engineering_knowledge SET revoked_at=?, superseded_by=? WHERE id=? AND revision=? AND revoked_at IS NULL').run(this.now(), entry.revision, entry.id, replacesRevision!);
        this.event(entry.id, replacesRevision!, 'superseded', digest, principal);
      } else if (this.db.prepare('SELECT 1 FROM engineering_knowledge WHERE id=? AND revoked_at IS NULL').get(entry.id)) {
        throw new Error('knowledge: entry already active (supersede it instead)');
      }
      if (this.db.prepare('SELECT 1 FROM engineering_knowledge WHERE id=? AND revision=?').get(entry.id, entry.revision)) throw new Error('knowledge: revision already exists');
      this.db.prepare('INSERT INTO engineering_knowledge (id,revision,project_id,manifest_json,digest,approved_at,principal_id,key_id,auth_nonce,revoked_at,superseded_by) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL)')
        .run(entry.id, entry.revision, entry.projectId ?? null, JSON.stringify(entry), digest, this.now(), principal.principalId, principal.keyId, nonce);
      this.event(entry.id, entry.revision, 'promoted', digest, principal);
    });
  }

  /** Revocation is one-way and leaves the full record for audit. Re-enabling needs a NEW revision and a new authorization. */
  revoke(id: string, statement: SignedStatement<PromotionGrant> | undefined, authority: PromotionAuthority): void {
    const record = this.db.prepare('SELECT id, revision, project_id, digest, manifest_json, revoked_at FROM engineering_knowledge WHERE id=? AND revoked_at IS NULL').get(id) as KnowledgeRow | undefined;
    if (!record) throw new Error('knowledge: no active entry to revoke');
    const principal = authority.authorize(statement, { action: 'revoke', entryId: id, digest: record.digest, projectId: record.project_id });
    if (!principal || !statement) throw new Error('knowledge: revocation not authorized');
    this.transaction(() => {
      this.consumeNonce(statement.payload.nonce, 'revoke', record.digest);
      const result = this.db.prepare('UPDATE engineering_knowledge SET revoked_at=? WHERE id=? AND revision=? AND revoked_at IS NULL').run(this.now(), id, record.revision);
      if (Number(result.changes) !== 1) throw new Error('knowledge: already revoked');
      this.event(id, record.revision, 'revoked', record.digest, principal);
    });
  }

  /**
   * The catalog a task of `projectId` may use: global curated entries plus that project's own. Every row is re-hashed; a row
   * whose stored digest no longer matches its manifest makes the whole read fail closed.
   */
  activeCatalog(options: { projectId?: string } = {}): EngineeringKnowledgeCatalog {
    const rows = this.db.prepare('SELECT id, revision, project_id, manifest_json, digest FROM engineering_knowledge WHERE revoked_at IS NULL AND (project_id IS NULL OR project_id = ?) ORDER BY id').all(options.projectId ?? null) as unknown as KnowledgeRow[];
    const entries = rows.map((row) => {
      const parsed = JSON.parse(row.manifest_json) as KnowledgeEntry;
      if (entryDigest(parsed) !== row.digest || !parsed.approved || (parsed.projectId ?? null) !== row.project_id) throw new Error('knowledge: corrupt stored manifest');
      return parsed;
    });
    return new EngineeringKnowledgeCatalog(entries, { projectId: options.projectId });
  }

  /** Read-only audit trail, oldest first. */
  history(id?: string): readonly { seq: number; knowledgeId: string; revision: string; action: string; digest: string; at: number; actor: string; keyId: string }[] {
    const rows = (id
      ? this.db.prepare('SELECT * FROM engineering_knowledge_events WHERE knowledge_id=? ORDER BY seq').all(id)
      : this.db.prepare('SELECT * FROM engineering_knowledge_events ORDER BY seq').all()) as unknown as { seq: number; knowledge_id: string; revision: string; action: string; digest: string; at: number; actor: string; key_id: string }[];
    return rows.map((r) => ({ seq: r.seq, knowledgeId: r.knowledge_id, revision: r.revision, action: r.action, digest: r.digest, at: r.at, actor: r.actor, keyId: r.key_id }));
  }

  async recordOnce(event: Readonly<SessionObservation & { fingerprint: string }>): Promise<'written' | 'exists'> {
    const normalized = normalizeSessionObservation(event);
    if (normalized.fingerprint !== event.fingerprint) throw new Error('knowledge: event fingerprint mismatched');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT fingerprint FROM engineering_session_events WHERE session_id=? AND seq=?').get(event.sessionId, event.seq) as { fingerprint: string } | undefined;
      if (existing) {
        if (existing.fingerprint !== event.fingerprint) throw new Error('knowledge: session checkpoint conflict');
        return 'exists' as const;
      }
      this.db.prepare('INSERT INTO engineering_session_events (session_id,seq,event_json,fingerprint) VALUES (?,?,?,?)').run(event.sessionId, event.seq, JSON.stringify(normalized), event.fingerprint);
      return 'written' as const;
    });
  }

  sessionEvents(sessionId: string): readonly SessionObservation[] {
    const rows = this.db.prepare('SELECT event_json FROM engineering_session_events WHERE session_id=? ORDER BY seq').all(sessionId) as unknown as { event_json: string }[];
    return rows.map((r) => {
      const { fingerprint: _f, ...obs } = JSON.parse(r.event_json) as SessionObservation & { fingerprint: string };
      return obs;
    });
  }

  private consumeNonce(nonce: string, action: string, digest: string): void {
    if (this.db.prepare('SELECT 1 FROM engineering_knowledge_authorizations WHERE nonce=?').get(nonce)) throw new Error('knowledge: authorization already used');
    this.db.prepare('INSERT INTO engineering_knowledge_authorizations (nonce,action,digest,used_at) VALUES (?,?,?,?)').run(nonce, action, digest, this.now());
  }

  private event(id: string, revision: string, action: string, digest: string, principal: AuthorizedPrincipal): void {
    this.db.prepare('INSERT INTO engineering_knowledge_events (knowledge_id,revision,action,digest,at,actor,key_id) VALUES (?,?,?,?,?,?,?)').run(id, revision, action, digest, this.now(), principal.principalId, principal.keyId);
  }

  /** No awaits inside: the whole check-then-act runs under one write lock, across processes too. */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

export const grantDigest = (grant: PromotionGrant): string => sha256Hex(hashValue(grant));

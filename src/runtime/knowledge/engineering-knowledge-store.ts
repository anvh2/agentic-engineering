/**
 * SQLite persistence for reviewed engineering knowledge and session continuity.
 * Intended for isolated use until integrated with the scheduler's authenticated authority.
 * Never accepts an LLM-provided "approved" boolean as promotion authority.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { EngineeringKnowledgeCatalog, type KnowledgeEntry, type CandidateLesson } from './engineering-knowledge.ts';
import { normalizeSessionObservation, type SessionObservation, type SessionObservationStore } from './engineering-continuity.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export interface PromotionAuthority {
  /** This must bind a runtime-authenticated principal and grant to the exact candidate digest. */
  authorize(digest: string): Promise<{ principalId:string; grantId:string } | undefined>;
}

const SQL = `
CREATE TABLE IF NOT EXISTS engineering_knowledge (
  id TEXT PRIMARY KEY, revision TEXT NOT NULL, manifest_json TEXT NOT NULL,
  digest TEXT NOT NULL, approved_at INTEGER NOT NULL, principal_id TEXT NOT NULL, grant_id TEXT NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS engineering_knowledge_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, knowledge_id TEXT NOT NULL,
  action TEXT NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS engineering_session_events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
  PRIMARY KEY(session_id,seq)
);
CREATE TRIGGER IF NOT EXISTS engineering_knowledge_no_delete
 BEFORE DELETE ON engineering_knowledge BEGIN SELECT RAISE(ABORT,'no knowledge deletes'); END;
CREATE TRIGGER IF NOT EXISTS engineering_knowledge_no_rewrite
 BEFORE UPDATE ON engineering_knowledge
 WHEN NEW.manifest_json IS NOT OLD.manifest_json OR NEW.digest IS NOT OLD.digest OR NEW.revision IS NOT OLD.revision
 BEGIN SELECT RAISE(ABORT,'knowledge record immutable'); END;
CREATE TRIGGER IF NOT EXISTS engineering_knowledge_events_no_delete
 BEFORE DELETE ON engineering_knowledge_events BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS engineering_session_events_no_delete
 BEFORE DELETE ON engineering_session_events BEGIN SELECT RAISE(ABORT,'append only'); END;
`;

export class DurableEngineeringKnowledge implements SessionObservationStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; db.exec(SQL); }

  /** Proposed learned knowledge is never promoted without a trusted authorization callback. */
  async promote(input: CandidateLesson, authority: PromotionAuthority): Promise<void> {
    if (input.status !== 'candidate' || !input.evidenceHashes.length) throw new Error('knowledge: invalid promotion');
    const entry: KnowledgeEntry = {
      id: input.id, revision: 'v'+sha(input.evidenceHashes.join(':')).slice(0,16),
      kind:'lesson',language:'common',body:input.proposedBody,source:`project:${input.projectId};evidence:${input.evidenceHashes.join(',')}`,approved:true,
    };
    // Reuse exactly the same validation as worker-bound manifest resolution.
    const checked = new EngineeringKnowledgeCatalog([entry]);
    checked.resolve({language:'go',ids:[entry.id]});
    const json = JSON.stringify(entry);
    const digest = sha(json);
    const principal = await authority.authorize(digest);
    if (!principal || !principal.principalId || !principal.grantId) throw new Error('knowledge: promotion not authorized');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT id FROM engineering_knowledge WHERE id=?').get(entry.id);
      if (previous) throw new Error('knowledge: entry ID already exists (use a new immutable revision ID)');
      this.db.prepare('INSERT INTO engineering_knowledge (id,revision,manifest_json,digest,approved_at,principal_id,grant_id,revoked_at) VALUES (?,?,?,?,?,?,?,NULL)').run(entry.id,entry.revision,json,digest,Date.now(),principal.principalId,principal.grantId);
      this.db.prepare('INSERT INTO engineering_knowledge_events (knowledge_id,action,digest,at,actor) VALUES (?,?,?,?,?)').run(entry.id,'promoted',digest,Date.now(),principal.principalId);
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Activate a curated rule/skill/ADR/role after authenticated, digest-bound promotion. */
  async promoteCurated(candidate: KnowledgeEntry, authority: PromotionAuthority): Promise<void> {
    if (candidate.approved) throw new Error('knowledge: candidate must start inactive');
    const entry: KnowledgeEntry = { ...candidate, approved:true };
    const catalog = new EngineeringKnowledgeCatalog([entry]);
    catalog.resolve({language:entry.language === 'common' ? 'go' : entry.language,ids:[entry.id]});
    const json = JSON.stringify(entry);
    const digest = sha(json);
    const principal = await authority.authorize(digest);
    if (!principal?.principalId || !principal.grantId) throw new Error('knowledge: promotion not authorized');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exists = this.db.prepare('SELECT id FROM engineering_knowledge WHERE id=?').get(entry.id);
      if (exists) throw new Error('knowledge: ID already promoted');
      this.db.prepare('INSERT INTO engineering_knowledge (id,revision,manifest_json,digest,approved_at,principal_id,grant_id,revoked_at) VALUES (?,?,?,?,?,?,?,NULL)').run(entry.id,entry.revision,json,digest,Date.now(),principal.principalId,principal.grantId);
      this.db.prepare('INSERT INTO engineering_knowledge_events (knowledge_id,action,digest,at,actor) VALUES (?,?,?,?,?)').run(entry.id,'promoted',digest,Date.now(),principal.principalId);
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }

  /** Revocation is operator-authorized and leaves the full immutable record for audit. */
  async revoke(id: string, authority: PromotionAuthority): Promise<void> {
    const record = this.db.prepare('SELECT digest,revoked_at FROM engineering_knowledge WHERE id=?').get(id) as { digest:string;revoked_at:number|null }|undefined;
    if (!record) throw new Error('knowledge: unknown entry');
    const principal = await authority.authorize(sha('revoke:'+id+':'+record.digest));
    if (!principal || !principal.principalId || !principal.grantId) throw new Error('knowledge: revocation not authorized');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('UPDATE engineering_knowledge SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(Date.now(),id);
      if (result.changes !== 1) throw new Error('knowledge: already revoked');
      this.db.prepare('INSERT INTO engineering_knowledge_events (knowledge_id,action,digest,at,actor) VALUES (?,?,?,?,?)').run(id,'revoked',record.digest,Date.now(),principal.principalId);
      this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }

  activeCatalog(): EngineeringKnowledgeCatalog {
    const rows = this.db.prepare('SELECT manifest_json,digest FROM engineering_knowledge WHERE revoked_at IS NULL ORDER BY id').all() as {manifest_json:string;digest:string}[];
    const entries = rows.map(({manifest_json,digest})=>{
      if (sha(manifest_json)!==digest) throw new Error('knowledge: corrupt stored manifest');
      const parsed = JSON.parse(manifest_json) as KnowledgeEntry;
      if (!parsed.approved) throw new Error('knowledge: unexpected unapproved manifest');
      return parsed;
    });
    return new EngineeringKnowledgeCatalog(entries);
  }

  async recordOnce(event: Readonly<SessionObservation & { fingerprint:string }>): Promise<'written'|'exists'> {
    const normalized = normalizeSessionObservation(event);
    if (normalized.fingerprint !== event.fingerprint) throw new Error('knowledge: event fingerprint mismatched');
    const existing = this.db.prepare('SELECT fingerprint FROM engineering_session_events WHERE session_id=? AND seq=?').get(event.sessionId,event.seq) as {fingerprint:string}|undefined;
    if (existing) {
      if (existing.fingerprint !== event.fingerprint) throw new Error('knowledge: session checkpoint conflict');
      return 'exists';
    }
    try {
      this.db.prepare('INSERT INTO engineering_session_events (session_id,seq,event_json,fingerprint) VALUES (?,?,?,?)')
        .run(event.sessionId,event.seq,JSON.stringify(normalized),event.fingerprint);
    } catch (e) {
      const latest = this.db.prepare('SELECT fingerprint FROM engineering_session_events WHERE session_id=? AND seq=?').get(event.sessionId,event.seq) as {fingerprint:string}|undefined;
      if (latest?.fingerprint===event.fingerprint) return 'exists';
      throw e;
    }
    return 'written';
  }
}

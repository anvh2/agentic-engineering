import { createHash } from 'node:crypto';
import { extname, isAbsolute, normalize } from 'node:path';
import type { SchedulerStore, TaskRow } from '../scheduler/store.ts';
import { delegatableLanguage, type EnabledLanguage } from './language-adapters.ts';

/**
 * Durable, runtime-owned approval of an engineering design (HLD / LLD / ADR) for ONE task.
 *
 * What makes an approval real, and what does not:
 *  - The caller-supplied `approvalRef` in a task contract is only a LOOKUP KEY. It proves nothing. A design is approved only if
 *    a record exists in the runtime's own store (the scheduler database, which sandboxed workers cannot read or write) whose
 *    content-derived id matches, whose immutable fields still hash to that id, and whose bindings match the design and task
 *    being run.
 *  - A record can only be created by `issueApproval`, which needs a credential the `ApprovalAuthority` authenticates over the
 *    exact request. The approver's role and permissions come from the authority's GRANT, never from anything the caller says.
 *  - Everything the grant is checked against (objective, files, language, risk, whether the task already started, who the
 *    assigned worker is) is read from the task the scheduler persisted, not from the request.
 *  - Authority is re-checked at every verification: a revoked or expired grant, or a record that was revoked, superseded or
 *    altered, stops authorizing immediately.
 *
 * NOT provided here, deliberately: a production `ApprovalAuthority`. The repository has no way to authenticate which principal
 * acted (audit actors are free strings) and no channel only a human can use to grant authority. Until one is provisioned,
 * `denyAllApprovals` is the default and every attached design is rejected (fail closed). See docs/architecture/language-adapters.md.
 */

export const LEAD_ROLE = 'engineering-lead';
export type Risk = 'low' | 'medium' | 'high';
const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/** What a grant lets its holder approve. Every dimension must match; an empty list authorizes nothing. */
export interface AuthorityScope {
  objectiveIds: string[];
  languages: EnabledLanguage[];
  /** Repo-relative directory prefixes (or exact files) the approved task's allowed files must all sit under. */
  pathPrefixes: string[];
  maxRisk: Risk;
}

export interface DelegatedAuthority {
  grantId: string;
  role: string;
  actions: ('approve' | 'revoke')[];
  scope: AuthorityScope;
  notBefore?: number;
  notAfter?: number;
  /** Set when the authority itself was withdrawn. Takes effect on the next verification. */
  revokedAt?: number;
}

/**
 * The trust root. Implementations decide how a credential proves who is acting; the runtime treats everything else as
 * untrusted input.
 */
export interface ApprovalAuthority {
  /**
   * Authenticates `credential` as bound to `digest` (the canonical digest of the exact action requested), so a credential
   * for one design, task, revision or action cannot be replayed for another. Undefined = not authenticated.
   */
  authenticate(credential: string, digest: string): { principalId: string; grantId: string } | undefined;
  /** The CURRENT state of a grant (so withdrawing it takes effect immediately). */
  grant(grantId: string): DelegatedAuthority | undefined;
}

export interface DesignContent {
  hld: string;
  lld: string;
  adr?: readonly string[];
}

/** Immutable fields of an approval; the approval id is derived from exactly these. */
export interface ApprovalRecord {
  v: 1;
  objectiveId: string;
  taskId: string;
  revision: number;
  designFingerprint: string;
  allowedFiles: string[];
  filesSha256: string;
  language: EnabledLanguage;
  risk: Risk;
  approverId: string;
  role: string;
  grantId: string;
  /** The authority the approver held when approving; re-evaluated against the grant's current state on every verification. */
  scope: AuthorityScope;
  approvedAt: number;
  expiresAt: number | null;
}

export interface VerifiedApproval {
  approvalId: string;
  revision: number;
  designFingerprint: string;
  approverId: string;
  role: string;
  grantId: string;
  approvedAt: number;
}

export type ApprovalVerdict = { ok: true; approval: VerifiedApproval } | { ok: false; code: ApprovalErrorCode; reason: string };

export interface ApprovalCheck {
  approvalRef: string;
  design: DesignContent;
  taskId: string;
  allowedFiles: readonly string[];
}

export type ApprovalVerifier = (check: ApprovalCheck) => ApprovalVerdict;

export type ApprovalErrorCode =
  | 'authority_unconfigured'
  | 'not_authenticated'
  | 'grant_unknown'
  | 'grant_inactive'
  | 'not_permitted'
  | 'out_of_scope'
  | 'invalid_design'
  | 'task_unknown'
  | 'task_mismatch'
  | 'task_started'
  | 'self_approval'
  | 'unsupported_language'
  | 'approval_unknown'
  | 'approval_tampered'
  | 'approval_revoked'
  | 'approval_superseded'
  | 'approval_expired'
  | 'design_mismatch'
  | 'approval_conflict';

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;
  constructor(code: ApprovalErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

/** Production default until an ApprovalAuthority is provisioned: nothing attached is ever treated as approved. */
export const denyAllApprovals: ApprovalVerifier = () => ({
  ok: false,
  code: 'authority_unconfigured',
  reason: 'no approval authority is configured, so no attached design can be verified as approved; submit the task without an approvedDesign or provision an authority',
});

// ---- canonical forms ------------------------------------------------------------------------------------------------

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const designFingerprint = (design: DesignContent): string => sha256(canonical({ hld: design.hld, lld: design.lld, adr: design.adr ?? [] }));
const filesDigest = (files: readonly string[]): string => sha256(canonical([...files].sort()));
const approvalIdOf = (recordJson: string): string => `da-${sha256(recordJson).slice(0, 32)}`;

/** The digest an approval credential must authenticate. Includes the revision so an old credential cannot be replayed to revert a design. */
export function approveDigest(input: { objectiveId: string; taskId: string; designFingerprint: string; revision: number }): string {
  return sha256(canonical({ action: 'approve', ...input }));
}
export function revokeDigest(input: { approvalId: string }): string {
  return sha256(canonical({ action: 'revoke', ...input }));
}

// ---- storage --------------------------------------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS design_approvals (
  approval_id TEXT PRIMARY KEY, objective_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
  record TEXT NOT NULL, record_sha256 TEXT NOT NULL,
  superseded_by TEXT, revoked_at INTEGER, revoked_by TEXT, revoke_reason TEXT,
  UNIQUE (objective_id, task_id, revision)
);
CREATE TABLE IF NOT EXISTS design_approval_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, approval_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT
);
CREATE TRIGGER IF NOT EXISTS design_approvals_no_rewrite BEFORE UPDATE ON design_approvals
WHEN OLD.approval_id IS NOT NEW.approval_id OR OLD.objective_id IS NOT NEW.objective_id OR OLD.task_id IS NOT NEW.task_id
  OR OLD.revision IS NOT NEW.revision OR OLD.record IS NOT NEW.record OR OLD.record_sha256 IS NOT NEW.record_sha256
  OR (OLD.superseded_by IS NOT NULL AND OLD.superseded_by IS NOT NEW.superseded_by)
  OR (OLD.revoked_at IS NOT NULL AND (OLD.revoked_at IS NOT NEW.revoked_at OR OLD.revoked_by IS NOT NEW.revoked_by OR OLD.revoke_reason IS NOT NEW.revoke_reason))
BEGIN SELECT RAISE(ABORT, 'design approvals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS design_approvals_no_delete BEFORE DELETE ON design_approvals
BEGIN SELECT RAISE(ABORT, 'design approvals cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS design_approval_events_no_update BEFORE UPDATE ON design_approval_events
BEGIN SELECT RAISE(ABORT, 'the approval audit trail is append-only'); END;
CREATE TRIGGER IF NOT EXISTS design_approval_events_no_delete BEFORE DELETE ON design_approval_events
BEGIN SELECT RAISE(ABORT, 'the approval audit trail is append-only'); END;
`;

interface ApprovalRow {
  approval_id: string;
  objective_id: string;
  task_id: string;
  revision: number;
  record: string;
  record_sha256: string;
  superseded_by: string | null;
  revoked_at: number | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

export interface ApprovalEvent {
  seq: number;
  approvalId: string;
  at: number;
  kind: string;
  actor: string;
  detail: string | null;
}

export class DesignApprovalStore {
  readonly scheduler: SchedulerStore;

  constructor(scheduler: SchedulerStore) {
    this.scheduler = scheduler;
    scheduler.db.exec(SCHEMA);
  }

  private row(approvalId: string): ApprovalRow | undefined {
    return this.scheduler.db.prepare('SELECT * FROM design_approvals WHERE approval_id = ?').get(approvalId) as ApprovalRow | undefined;
  }

  /** The row plus its parsed record, or the reason it cannot be trusted. Integrity: the stored JSON must still hash to both the stored digest and the id. */
  load(approvalId: string): { row: ApprovalRow; record: ApprovalRecord } | { error: ApprovalVerdict & { ok: false } } {
    const row = this.row(approvalId);
    if (!row) return { error: { ok: false, code: 'approval_unknown', reason: `no approval record ${approvalId}` } };
    if (sha256(row.record) !== row.record_sha256 || approvalIdOf(row.record) !== row.approval_id) {
      return { error: { ok: false, code: 'approval_tampered', reason: `approval ${approvalId} no longer matches its recorded digest` } };
    }
    try {
      const record = JSON.parse(row.record) as ApprovalRecord;
      if (record.objectiveId !== row.objective_id || record.taskId !== row.task_id || record.revision !== row.revision) throw new Error('indexed columns disagree with the record');
      return { row, record };
    } catch (err) {
      return { error: { ok: false, code: 'approval_tampered', reason: `approval ${approvalId} is unreadable: ${(err as Error).message}` } };
    }
  }

  latestRevision(objectiveId: string, taskId: string): { approvalId: string; revision: number } | undefined {
    const r = this.scheduler.db.prepare('SELECT approval_id, revision FROM design_approvals WHERE objective_id = ? AND task_id = ? ORDER BY revision DESC LIMIT 1').get(objectiveId, taskId) as { approval_id: string; revision: number } | undefined;
    return r ? { approvalId: r.approval_id, revision: r.revision } : undefined;
  }

  nextRevision(objectiveId: string, taskId: string): number {
    return (this.latestRevision(objectiveId, taskId)?.revision ?? 0) + 1;
  }

  insert(record: ApprovalRecord, supersedes: string | undefined, actor: string): string {
    const json = canonical(record);
    const approvalId = approvalIdOf(json);
    this.scheduler.transact(() => {
      this.scheduler.db.prepare('INSERT INTO design_approvals (approval_id, objective_id, task_id, revision, record, record_sha256) VALUES (?,?,?,?,?,?)').run(approvalId, record.objectiveId, record.taskId, record.revision, json, sha256(json));
      if (supersedes) this.scheduler.db.prepare('UPDATE design_approvals SET superseded_by = ? WHERE approval_id = ? AND superseded_by IS NULL').run(approvalId, supersedes);
      this.event(approvalId, 'issued', actor, supersedes ? `supersedes ${supersedes}` : null);
    });
    return approvalId;
  }

  /** Returns true only if THIS call revoked it; an already-revoked approval changes nothing and writes no audit event. */
  revoke(approvalId: string, actor: string, reason: string): boolean {
    return this.scheduler.transact(() => {
      const res = this.scheduler.db.prepare('UPDATE design_approvals SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE approval_id = ? AND revoked_at IS NULL').run(this.scheduler.now(), actor, reason, approvalId);
      if (Number(res.changes) !== 1) return false;
      this.event(approvalId, 'revoked', actor, reason);
      return true;
    });
  }

  private event(approvalId: string, kind: string, actor: string, detail: string | null): void {
    this.scheduler.db.prepare('INSERT INTO design_approval_events (approval_id, at, kind, actor, detail) VALUES (?,?,?,?,?)').run(approvalId, this.scheduler.now(), kind, actor, detail);
  }

  events(approvalId?: string): ApprovalEvent[] {
    const rows = (approvalId
      ? this.scheduler.db.prepare('SELECT * FROM design_approval_events WHERE approval_id = ? ORDER BY seq').all(approvalId)
      : this.scheduler.db.prepare('SELECT * FROM design_approval_events ORDER BY seq').all()) as Record<string, any>[];
    return rows.map((r) => ({ seq: r.seq, approvalId: r.approval_id, at: r.at, kind: r.kind, actor: r.actor, detail: r.detail }));
  }
}

// ---- authority evaluation (deterministic) -----------------------------------------------------------------------------

function underPrefix(file: string, prefix: string): boolean {
  const p = normalize(prefix).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p === '.' || isAbsolute(prefix) || p.startsWith('..')) return false;
  return file === p || file.startsWith(p.endsWith('/') ? p : `${p}/`);
}

const safeRelative = (file: string): boolean => !isAbsolute(file) && normalize(file) === file && !file.startsWith('..') && !file.includes('\0');

/** Why `grant` does not (or no longer) authorize `action` for this subject; undefined means it does. Pure function of its inputs. */
export function authorityProblem(
  grant: DelegatedAuthority | undefined,
  action: 'approve' | 'revoke',
  subject: { objectiveId: string; language: EnabledLanguage; allowedFiles: readonly string[]; risk: Risk },
  now: number,
): { code: ApprovalErrorCode; reason: string } | undefined {
  if (!grant) return { code: 'grant_unknown', reason: 'the grant is not known to the authority' };
  if (grant.revokedAt !== undefined) return { code: 'grant_inactive', reason: `grant ${grant.grantId} was revoked` };
  if ((grant.notBefore !== undefined && now < grant.notBefore) || (grant.notAfter !== undefined && now >= grant.notAfter)) return { code: 'grant_inactive', reason: `grant ${grant.grantId} is outside its validity window` };
  if (grant.role !== LEAD_ROLE) return { code: 'not_permitted', reason: `role "${grant.role}" cannot ${action} designs; only ${LEAD_ROLE} can` };
  if (!grant.actions.includes(action)) return { code: 'not_permitted', reason: `grant ${grant.grantId} does not permit "${action}"` };
  const { scope } = grant;
  if (!scope.objectiveIds.includes(subject.objectiveId)) return { code: 'out_of_scope', reason: `objective ${subject.objectiveId} is outside the delegated scope` };
  if (!scope.languages.includes(subject.language)) return { code: 'out_of_scope', reason: `language ${subject.language} is outside the delegated scope` };
  const outside = subject.allowedFiles.filter((f) => !scope.pathPrefixes.some((p) => underPrefix(f, p)));
  if (outside.length > 0) return { code: 'out_of_scope', reason: `${outside.join(', ')} is outside the delegated path scope` };
  if (RISK_ORDER[subject.risk] > RISK_ORDER[scope.maxRisk]) return { code: 'out_of_scope', reason: `risk "${subject.risk}" exceeds the delegated maximum "${scope.maxRisk}"` };
  return undefined;
}

// ---- issuing and revoking ---------------------------------------------------------------------------------------------

export interface ApprovalDeps {
  store: SchedulerStore;
  authority: ApprovalAuthority;
}

/**
 * Runs `fn` as ONE write transaction (BEGIN IMMEDIATE via the scheduler's own `transact`, so it takes the same write lock a
 * worker claim needs). Everything `fn` reads - the task's state and claim count, its persisted files and risk, the latest
 * revision - therefore cannot change before `fn`'s writes commit: a claim by another scheduler connection waits for the lock
 * instead of slipping in between "the task has not started" and "the approval is recorded". Any throw rolls back every write
 * `fn` made (the approval row, the supersession and the audit event commit together or not at all). Lock contention that
 * outlasts the busy timeout, and a lost race on the revision, surface as `approval_conflict`: nothing is written, retry.
 */
function atomically<T>(store: SchedulerStore, fn: () => T): T {
  try {
    return store.transact(fn);
  } catch (err) {
    if (err instanceof ApprovalError) throw err;
    const message = (err as Error).message ?? '';
    if (/database is locked|database table is locked|SQLITE_BUSY|UNIQUE constraint failed: design_approvals/i.test(message)) {
      throw new ApprovalError('approval_conflict', `another writer holds the scheduler database or just recorded a conflicting approval; nothing was written, retry (${message})`);
    }
    throw err;
  }
}

const STARTED_STATES = new Set(['BACKLOG', 'READY', 'BLOCKED']);
const MAX_PART = 12_000;

function taskFacts(task: TaskRow): { files: string[]; risk: Risk; language: EnabledLanguage } {
  const request = task.spec.request;
  if (!request) throw new ApprovalError('task_mismatch', `task ${task.id} has no worker request, so there is nothing to approve a design for`);
  const files = [...request.contract.allowedFiles];
  const language = delegatableLanguage(files.map((f) => extname(f)));
  if (!language) throw new ApprovalError('unsupported_language', `task ${task.id}: allowed files are not all in one delegatable language`);
  if (!files.every(safeRelative)) throw new ApprovalError('task_mismatch', `task ${task.id}: allowed files must be normalized repository-relative paths`);
  return { files, risk: request.assessment.risk, language };
}

/**
 * Records the approval of `design` for one task. Throws ApprovalError (nothing is written) unless the credential
 * authenticates for exactly this request AND the grant's current authority covers the task as the scheduler persisted it.
 */
export function issueApproval(deps: ApprovalDeps, input: { objectiveId: string; taskId: string; design: DesignContent; credential: string; ttlMs?: number }): { approvalId: string; record: ApprovalRecord } {
  const { store, authority } = deps;
  const approvals = new DesignApprovalStore(store);
  const { design } = input;
  const parts = [design.hld, design.lld, ...(design.adr ?? [])];
  if (!design.hld?.trim() || !design.lld?.trim() || parts.some((p) => typeof p !== 'string' || p.length > MAX_PART) || (design.adr ?? []).some((a) => !a.trim())) {
    throw new ApprovalError('invalid_design', 'HLD and LLD are required, every part must be non-empty text of at most 12000 characters');
  }
  // From here on every read and write is one write transaction (see atomically): the task cannot be claimed in between.
  return atomically(store, () => {
    const task = store.getTask(input.taskId);
    if (!task) throw new ApprovalError('task_unknown', `no task ${input.taskId}`);
    if (task.batchId !== input.objectiveId) throw new ApprovalError('task_mismatch', `task ${task.id} belongs to objective ${task.batchId}, not ${input.objectiveId}`);
    // A design approved after a worker already ran would be the worker's own work being approved after the fact.
    if (task.claims > 0 || !STARTED_STATES.has(task.state)) throw new ApprovalError('task_started', `task ${task.id} is ${task.state} (claimed ${task.claims}x); a design can only be approved before a worker starts`);
    const facts = taskFacts(task);

    const fingerprint = designFingerprint(design);
    const revision = approvals.nextRevision(input.objectiveId, input.taskId);
    const principal = authority.authenticate(input.credential, approveDigest({ objectiveId: input.objectiveId, taskId: input.taskId, designFingerprint: fingerprint, revision }));
    if (!principal) throw new ApprovalError('not_authenticated', 'the credential does not authenticate this exact approval request');
    const grant = authority.grant(principal.grantId);
    const problem = authorityProblem(grant, 'approve', { objectiveId: input.objectiveId, language: facts.language, allowedFiles: facts.files, risk: facts.risk }, store.now());
    if (problem) throw new ApprovalError(problem.code, problem.reason);
    if (task.assignedWorker && task.assignedWorker === principal.principalId) throw new ApprovalError('self_approval', `${principal.principalId} is the worker assigned to ${task.id} and cannot approve its design`);

    const latest = approvals.latestRevision(input.objectiveId, input.taskId);
    if (latest) {
      const current = approvals.load(latest.approvalId);
      if ('record' in current && !current.row.revoked_at && current.record.designFingerprint === fingerprint) {
        // Same design already approved at the latest revision: idempotent, never a new revision.
        return { approvalId: current.row.approval_id, record: current.record };
      }
    }

    const now = store.now();
    const record: ApprovalRecord = {
      v: 1,
      objectiveId: input.objectiveId,
      taskId: input.taskId,
      revision,
      designFingerprint: fingerprint,
      allowedFiles: [...facts.files].sort(),
      filesSha256: filesDigest(facts.files),
      language: facts.language,
      risk: facts.risk,
      approverId: principal.principalId,
      role: grant!.role,
      grantId: grant!.grantId,
      scope: { objectiveIds: [...grant!.scope.objectiveIds], languages: [...grant!.scope.languages], pathPrefixes: [...grant!.scope.pathPrefixes], maxRisk: grant!.scope.maxRisk },
      approvedAt: now,
      expiresAt: input.ttlMs === undefined ? (grant!.notAfter ?? null) : Math.min(now + input.ttlMs, grant!.notAfter ?? Number.POSITIVE_INFINITY),
    };
    const approvalId = approvals.insert(record, latest?.approvalId, principal.principalId);
    return { approvalId, record };
  });
}

/** Withdraws an approval. Needs a credential whose grant permits "revoke" over the approval's objective; reviewers cannot rewrite a design, only escalate. */
export function revokeApproval(deps: ApprovalDeps, input: { approvalId: string; credential: string; reason: string }): void {
  const approvals = new DesignApprovalStore(deps.store);
  if (!input.reason.trim()) throw new ApprovalError('invalid_design', 'a revocation needs a reason');
  atomically(deps.store, () => {
    const loaded = approvals.load(input.approvalId);
    if ('error' in loaded) throw new ApprovalError(loaded.error.code, loaded.error.reason);
    if (loaded.row.revoked_at) return; // idempotent
    const principal = deps.authority.authenticate(input.credential, revokeDigest({ approvalId: input.approvalId }));
    if (!principal) throw new ApprovalError('not_authenticated', 'the credential does not authenticate this exact revocation');
    const { record } = loaded;
    const problem = authorityProblem(deps.authority.grant(principal.grantId), 'revoke', { objectiveId: record.objectiveId, language: record.language, allowedFiles: record.allowedFiles, risk: record.risk }, deps.store.now());
    if (problem) throw new ApprovalError(problem.code, problem.reason);
    approvals.revoke(input.approvalId, principal.principalId, input.reason);
  });
}

// ---- verification (the only thing the rest of the runtime trusts) ---------------------------------------------------

/**
 * Builds the verifier that routing, the runner and the reviewer all use. It trusts nothing in the check except as a key
 * to look up and a value to compare against what the store and the authority say.
 */
export function createApprovalVerifier(deps: ApprovalDeps): ApprovalVerifier {
  const { store, authority } = deps;
  const approvals = new DesignApprovalStore(store);
  const fail = (code: ApprovalErrorCode, reason: string): ApprovalVerdict => ({ ok: false, code, reason });

  return (check) => {
    if (typeof check.approvalRef !== 'string' || !/^da-[a-f0-9]{32}$/.test(check.approvalRef)) return fail('approval_unknown', 'approvalRef is not an approval record id');
    const loaded = approvals.load(check.approvalRef);
    if ('error' in loaded) return loaded.error;
    const { row, record } = loaded;
    const now = store.now();

    if (row.revoked_at) return fail('approval_revoked', `approval ${row.approval_id} was revoked by ${row.revoked_by}: ${row.revoke_reason ?? ''}`);
    if (row.superseded_by) return fail('approval_superseded', `approval ${row.approval_id} (revision ${record.revision}) was superseded by ${row.superseded_by}`);
    if (record.expiresAt !== null && now >= record.expiresAt) return fail('approval_expired', `approval ${row.approval_id} expired`);

    if (designFingerprint(check.design) !== record.designFingerprint) return fail('design_mismatch', 'the attached HLD/LLD/ADR is not the design that was approved');
    if (check.taskId !== record.taskId) return fail('task_mismatch', `approval is for task ${record.taskId}, not ${check.taskId}`);
    if (filesDigest(check.allowedFiles) !== record.filesSha256) return fail('task_mismatch', 'the task allows different files than the approval covered');

    const task = store.getTask(record.taskId);
    if (!task) return fail('task_unknown', `no task ${record.taskId} in the runtime store`);
    if (task.batchId !== record.objectiveId) return fail('task_mismatch', `task ${task.id} belongs to objective ${task.batchId}, not the approved ${record.objectiveId}`);
    const persisted = task.spec.request?.contract.allowedFiles;
    if (!persisted || filesDigest(persisted) !== record.filesSha256) return fail('task_mismatch', 'the persisted task no longer allows the files the approval covered');
    if (task.assignedWorker && task.assignedWorker === record.approverId) return fail('self_approval', `${record.approverId} is the worker assigned to ${task.id}`);

    // Authority is live: the grant must still exist and still cover what was approved.
    const problem = authorityProblem(authority.grant(record.grantId), 'approve', { objectiveId: record.objectiveId, language: record.language, allowedFiles: record.allowedFiles, risk: record.risk }, now);
    if (problem) return fail(problem.code, `${problem.reason} (approver ${record.approverId})`);

    return { ok: true, approval: { approvalId: row.approval_id, revision: record.revision, designFingerprint: record.designFingerprint, approverId: record.approverId, role: record.role, grantId: record.grantId, approvedAt: record.approvedAt } };
  };
}

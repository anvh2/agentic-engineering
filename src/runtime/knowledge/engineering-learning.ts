/**
 * Continuous learning, governed:
 *   Observation -> Evidence -> Candidate -> Validation -> Confidence -> Promotion -> Versioned skill -> Monitoring -> Rollback
 *
 * What this module decides and what it refuses to decide:
 *  - It turns RUNTIME-SIGNED outcome statements into candidate lessons. A statement counts only if it was signed by an
 *    `evidence-signer` key, the runtime verified the work, and a reviewer other than the worker accepted or rejected it.
 *    Worker prose, repetition and frequency of a claim are not evidence and never raise confidence.
 *  - Candidates are INACTIVE (`approved:false`). Activation is a signed promotion in the knowledge store, so a model can never
 *    promote its own lesson into trusted policy. Promotion, revocation and rollback keep their existing authority path.
 *  - Lessons are scoped to the project that produced the evidence. A lesson reaches global scope only when several projects
 *    each qualify on their own AND the supporting reviews come from more than one independent reviewer.
 *  - Monitoring produces RECOMMENDATIONS (revoke/roll back), never actions.
 *
 * Adapted from the project-scoped, confidence-weighted instinct idea in ECC `skills/continuous-learning-v2` and the
 * `scripts/lib/skill-evolution` health/versioning modules (MIT, affaan-m/ECC at b92f181b3b748d1abbc2afd94af6aa7d8c8fca29).
 * ECC promotes by observation frequency; this implementation deliberately does not.
 */
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, hashValue, scanForSecrets, sha256Hex, SHA256_PATTERN } from './canonical.ts';
import { wilson95 } from './engineering-eval.ts';
import type { KnowledgeEntry } from './engineering-knowledge.ts';
import type { SkillHealth, SkillRun } from './engineering-skill-health.ts';
import { signStatement, verifyStatement, type SignedStatement, type TrustedKeyring } from './trust.ts';

export const OUTCOME_DOMAIN = 'learning.outcome/v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const SKILL_ID = /^[a-z][a-z0-9-]{1,79}$/;
/** Exactly the knowledge catalog's id format, so a project's candidates are scoped by the same string the catalog is built with. */
const PROJECT_ID = /^[a-z][a-z0-9-]{1,79}$/;

/** What the runtime's evidence-signer attests about one finished task. */
export interface OutcomePayload {
  outcomeId: string;
  projectId: string;
  taskId: string;
  /** The lesson the task exercised or demonstrated, as short plain text. Hashed to deduplicate across tasks. */
  lessonText: string;
  verdict: 'accepted' | 'rejected';
  runtimeVerified: boolean;
  workerPrincipal: string;
  reviewerPrincipal: string;
  /** Root hash of the run's evidence capsule: the audit trail for this observation. */
  capsuleRoot: string;
  /** Skills pinned in the task, so outcomes also feed per-skill health. */
  skills: readonly { id: string; revision: string }[];
  at: number;
}
export interface Outcome extends OutcomePayload { lessonDigest: string; signerPrincipal: string }
export type RejectedOutcome = Readonly<{ index: number; reason: string }>;

export const lessonDigestOf = (text: string): string => sha256Hex(text.trim().replace(/\s+/g, ' ').toLowerCase());

export function signOutcome(privateKeyPem: string, keyId: string, payload: OutcomePayload): SignedStatement<OutcomePayload> {
  return signStatement(privateKeyPem, keyId, OUTCOME_DOMAIN, payload);
}

function problem(p: OutcomePayload): string | undefined {
  if (!p || typeof p !== 'object') return 'malformed outcome';
  if (![p.outcomeId, p.taskId, p.workerPrincipal, p.reviewerPrincipal].every((s) => typeof s === 'string' && ID.test(s)) || typeof p.projectId !== 'string' || !PROJECT_ID.test(p.projectId)) return 'invalid identifier';
  if (typeof p.lessonText !== 'string' || !p.lessonText.trim() || p.lessonText.length > 1200 || p.lessonText.includes('\u0000')) return 'invalid lesson text';
  if (p.verdict !== 'accepted' && p.verdict !== 'rejected') return 'invalid verdict';
  if (p.runtimeVerified !== true) return 'outcome was not verified by the runtime';
  if (p.reviewerPrincipal === p.workerPrincipal) return 'reviewer is the worker';
  if (typeof p.capsuleRoot !== 'string' || !SHA256_PATTERN.test(p.capsuleRoot)) return 'invalid capsule root';
  if (!Array.isArray(p.skills) || p.skills.length > 6 || p.skills.some((s) => !s || !SKILL_ID.test(s.id) || typeof s.revision !== 'string' || !ID.test(s.revision))) return 'invalid skills';
  if (!Number.isFinite(p.at) || p.at < 0) return 'invalid timestamp';
  if (scanForSecrets(p).length) return 'outcome contains a credential';
  return undefined;
}

/** Verifies signed outcomes. Unsigned, mis-keyed, unverified, self-reviewed and duplicate observations are reported, not counted. */
export function ingestOutcomes(statements: readonly SignedStatement<OutcomePayload>[], keyring: TrustedKeyring, now: number): { outcomes: readonly Outcome[]; rejected: readonly RejectedOutcome[] } {
  const outcomes: Outcome[] = [];
  const rejected: RejectedOutcome[] = [];
  const seen = new Set<string>();
  statements.forEach((statement, index) => {
    const verdict = verifyStatement<OutcomePayload>(keyring, statement, { domain: OUTCOME_DOMAIN, role: 'evidence-signer', now });
    if (!verdict.ok) return void rejected.push({ index, reason: verdict.reason });
    const bad = problem(verdict.payload);
    if (bad) return void rejected.push({ index, reason: bad });
    const p = verdict.payload;
    const lessonDigest = lessonDigestOf(p.lessonText);
    const slot = JSON.stringify([p.projectId, p.taskId, lessonDigest]);
    if (seen.has(slot) || seen.has(`id:${p.outcomeId}`)) return void rejected.push({ index, reason: 'duplicate observation' });
    seen.add(slot); seen.add(`id:${p.outcomeId}`);
    outcomes.push(Object.freeze({ ...p, lessonDigest, signerPrincipal: verdict.principalId }));
  });
  return Object.freeze({ outcomes: Object.freeze(outcomes), rejected: Object.freeze(rejected) });
}

const SQL = `
CREATE TABLE IF NOT EXISTS engineering_learning_outcomes (
  outcome_id TEXT NOT NULL PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, lesson_digest TEXT NOT NULL,
  outcome_json TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  UNIQUE (project_id, task_id, lesson_digest)
);
CREATE INDEX IF NOT EXISTS engineering_learning_by_project ON engineering_learning_outcomes(project_id, lesson_digest);
CREATE TRIGGER IF NOT EXISTS engineering_learning_no_update BEFORE UPDATE ON engineering_learning_outcomes BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS engineering_learning_no_delete BEFORE DELETE ON engineering_learning_outcomes BEGIN SELECT RAISE(ABORT,'append only'); END;
`;

/** Durable, append-only record of verified outcomes. Re-recording the same observation is a no-op, a conflicting one is an error. */
export class DurableLearningLog {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(db: DatabaseSync, options: { now?: () => number } = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SQL);
  }

  record(outcomes: readonly Outcome[]): { written: number; existing: number } {
    let written = 0, existing = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const o of outcomes) {
        const json = canonicalJson(o);
        const row = this.db.prepare('SELECT outcome_json FROM engineering_learning_outcomes WHERE project_id=? AND task_id=? AND lesson_digest=?').get(o.projectId, o.taskId, o.lessonDigest) as { outcome_json: string } | undefined;
        if (row) {
          if (row.outcome_json !== json) throw new Error('learning: conflicting outcome for an observation already recorded');
          existing++;
          continue;
        }
        this.db.prepare('INSERT INTO engineering_learning_outcomes (outcome_id,project_id,task_id,lesson_digest,outcome_json,recorded_at) VALUES (?,?,?,?,?,?)')
          .run(o.outcomeId, o.projectId, o.taskId, o.lessonDigest, json, this.now());
        written++;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { written, existing };
  }

  /** Outcomes of one project only. There is no call that returns another project's observations by accident. */
  forProject(projectId: string): readonly Outcome[] {
    const rows = this.db.prepare('SELECT outcome_json FROM engineering_learning_outcomes WHERE project_id=? ORDER BY recorded_at, outcome_id').all(projectId) as unknown as { outcome_json: string }[];
    return rows.map((r) => JSON.parse(r.outcome_json) as Outcome);
  }

  projects(): readonly string[] {
    return (this.db.prepare('SELECT DISTINCT project_id FROM engineering_learning_outcomes ORDER BY project_id').all() as unknown as { project_id: string }[]).map((r) => r.project_id);
  }
}

export interface CandidatePolicy {
  /** Distinct verified tasks required before a lesson can be proposed. */
  minObservations: number;
  /** Lower bound of the 95% Wilson interval on the accepted rate that the lesson must reach. */
  minConfidence: number;
  /** Global scope: projects that each qualify independently. */
  minProjects: number;
  /** Global scope: distinct reviewer principals across the supporting evidence. */
  minReviewers: number;
}
export const DEFAULT_CANDIDATE_POLICY: CandidatePolicy = Object.freeze({ minObservations: 5, minConfidence: 0.55, minProjects: 2, minReviewers: 2 });

export interface LessonCandidate {
  scope: 'project' | 'global';
  projectIds: readonly string[];
  lessonDigest: string;
  observations: number;
  accepted: number;
  rejected: number;
  /** Lower bound of the accepted rate: a pessimistic estimate that shrinks with small samples. */
  confidence: number;
  reviewers: readonly string[];
  evidenceRoots: readonly string[];
  /** Inactive. Becomes active only through a signed promotion in the knowledge store. */
  entry: KnowledgeEntry;
}

const validPolicy = (p: CandidatePolicy): boolean => Number.isSafeInteger(p.minObservations) && p.minObservations >= 1 && p.minConfidence >= 0 && p.minConfidence <= 1
  && Number.isSafeInteger(p.minProjects) && p.minProjects >= 2 && Number.isSafeInteger(p.minReviewers) && p.minReviewers >= 1;

interface Group { text: string; outcomes: Outcome[] }
const stats = (g: readonly Outcome[]) => {
  const tasks = new Set(g.map((o) => o.taskId));
  const accepted = g.filter((o) => o.verdict === 'accepted').length;
  return { observations: g.length, distinctTasks: tasks.size, accepted, rejected: g.length - accepted, confidence: wilson95(accepted, g.length).low };
};

function candidateEntry(digest: string, text: string, scope: 'project' | 'global', projectId: string | undefined, roots: readonly string[]): KnowledgeEntry {
  const evidence = sha256Hex(canonicalJson([...roots].sort())).slice(0, 16);
  // The id includes the scope: the store allows one active row per id, so a project lesson, another project's copy of it and
  // a global lesson must never share an id (promoting one would block or retire another).
  const idSeed = scope === 'project' ? sha256Hex(`${projectId}\n${digest}`) : digest;
  return Object.freeze({
    id: `lesson-${idSeed.slice(0, 12)}`, revision: `v1-${evidence.slice(0, 8)}`, kind: 'lesson', language: 'common',
    body: text.trim().replace(/\s+/g, ' '), source: `learning:${scope} evidence:sha256:${evidence}`, approved: false,
    ...(scope === 'project' && projectId ? { projectId } : {}),
  });
}

/**
 * Candidate lessons from verified outcomes. Pure and deterministic. A project's lessons come only from that project's
 * outcomes; global candidates additionally require independent corroboration across projects and reviewers.
 */
export function proposeCandidates(outcomes: readonly Outcome[], policy: CandidatePolicy = DEFAULT_CANDIDATE_POLICY): readonly LessonCandidate[] {
  if (!validPolicy(policy)) throw new Error('learning: invalid candidate policy');
  const byProject = new Map<string, Map<string, Group>>();
  for (const o of outcomes) {
    const projects = byProject.get(o.projectId) ?? new Map<string, Group>();
    const g = projects.get(o.lessonDigest) ?? { text: o.lessonText, outcomes: [] };
    g.outcomes.push(o);
    projects.set(o.lessonDigest, g);
    byProject.set(o.projectId, projects);
  }
  const candidates: LessonCandidate[] = [];
  const qualifying = new Map<string, { projectId: string; group: Group }[]>();
  for (const [projectId, groups] of [...byProject].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [digest, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const s = stats(group.outcomes);
      if (s.distinctTasks < policy.minObservations || s.confidence < policy.minConfidence) continue;
      const roots = group.outcomes.map((o) => o.capsuleRoot);
      candidates.push({ scope: 'project', projectIds: [projectId], lessonDigest: digest, observations: s.observations, accepted: s.accepted, rejected: s.rejected, confidence: s.confidence,
        reviewers: [...new Set(group.outcomes.map((o) => o.reviewerPrincipal))].sort(), evidenceRoots: roots, entry: candidateEntry(digest, group.text, 'project', projectId, roots) });
      qualifying.set(digest, [...(qualifying.get(digest) ?? []), { projectId, group }]);
    }
  }
  for (const [digest, supporters] of [...qualifying].sort(([a], [b]) => a.localeCompare(b))) {
    const reviewers = [...new Set(supporters.flatMap((s) => s.group.outcomes.map((o) => o.reviewerPrincipal)))].sort();
    if (supporters.length < policy.minProjects || reviewers.length < policy.minReviewers) continue;
    const all = supporters.flatMap((s) => s.group.outcomes);
    const s = stats(all);
    const roots = all.map((o) => o.capsuleRoot);
    candidates.push({ scope: 'global', projectIds: supporters.map((x) => x.projectId).sort(), lessonDigest: digest, observations: s.observations, accepted: s.accepted, rejected: s.rejected, confidence: s.confidence,
      reviewers, evidenceRoots: roots, entry: candidateEntry(digest, supporters[0]!.group.text, 'global', undefined, roots) });
  }
  return Object.freeze(candidates);
}

export interface CalibrationBin { low: number; high: number; predicted: number; observed: number | null; count: number }
/** Do stated confidences mean anything? Compares predicted confidence with the later observed acceptance rate. */
export function calibrationReport(predictions: readonly { confidence: number; accepted: boolean }[], bins = 5): { brier: number | null; bins: readonly CalibrationBin[] } {
  if (!Number.isSafeInteger(bins) || bins < 1 || bins > 20) throw new Error('learning: invalid bin count');
  if (predictions.some((p) => !(p.confidence >= 0 && p.confidence <= 1) || typeof p.accepted !== 'boolean')) throw new Error('learning: invalid prediction');
  const out: CalibrationBin[] = Array.from({ length: bins }, (_, i) => ({ low: i / bins, high: (i + 1) / bins, predicted: 0, observed: null, count: 0 }));
  const sums = out.map(() => ({ p: 0, y: 0 }));
  for (const pr of predictions) {
    const i = Math.min(bins - 1, Math.floor(pr.confidence * bins));
    sums[i]!.p += pr.confidence; sums[i]!.y += pr.accepted ? 1 : 0; out[i]!.count++;
  }
  const filled = out.map((b, i) => (b.count ? { ...b, predicted: sums[i]!.p / b.count, observed: sums[i]!.y / b.count } : b));
  const brier = predictions.length ? predictions.reduce((n, p) => n + (p.confidence - (p.accepted ? 1 : 0)) ** 2, 0) / predictions.length : null;
  return { brier, bins: filled };
}

/** One SkillRun per skill pinned in each verified outcome, so skill health is computed from the same evidence. */
export function skillRunsFromOutcomes(outcomes: readonly Outcome[]): readonly SkillRun[] {
  // One run per (task, skill version): several lessons from one task are one use of the skill, not several. A run is accepted
  // only if every verified outcome of that task for the skill was accepted.
  const runs = new Map<string, { skillId: string; revision: string; taskId: string; projectId: string; accepted: boolean; at: number }>();
  for (const o of outcomes) {
    for (const s of o.skills) {
      const key = JSON.stringify([o.projectId, o.taskId, s.id, s.revision]);
      const run = runs.get(key);
      if (run) { run.accepted &&= o.verdict === 'accepted'; run.at = Math.max(run.at, o.at); }
      else runs.set(key, { skillId: s.id, revision: s.revision, taskId: o.taskId, projectId: o.projectId, accepted: o.verdict === 'accepted', at: o.at });
    }
  }
  return [...runs.values()].map((r) => ({ skillId: r.skillId, revision: r.revision, taskId: r.taskId, projectId: r.projectId, outcome: r.accepted ? 'accepted' as const : 'rejected' as const, independentlyVerified: true, at: r.at }));
}

export type Recommendation = Readonly<{ action: 'revoke-or-rollback' | 'monitor' | 'none'; skillId: string; revision: string; reason: string }>;
/** Advisory only: the operator signs the revocation or rollback through the knowledge store. */
export function recommendActions(health: readonly SkillHealth[]): readonly Recommendation[] {
  return Object.freeze(health.map((h): Recommendation => {
    if (h.trend === 'declining') return { action: 'revoke-or-rollback', skillId: h.skillId, revision: h.revision, reason: `acceptance fell from ${h.priorAcceptanceRate} to ${h.recentAcceptanceRate} over the last window` };
    if (h.trend === 'unmeasured') return { action: 'monitor', skillId: h.skillId, revision: h.revision, reason: 'no verified runs in the window: unmeasured, not healthy' };
    if (h.trend === 'insufficient') return { action: 'monitor', skillId: h.skillId, revision: h.revision, reason: 'too few verified runs to judge' };
    return { action: 'none', skillId: h.skillId, revision: h.revision, reason: h.trend };
  }));
}

/** An inactive copy of an earlier revision under a fresh revision id, ready for a signed `supersede` (rollback by re-promotion). */
export function buildRollbackCandidate(previous: KnowledgeEntry, nextRevision: string): KnowledgeEntry {
  if (previous.revision === nextRevision) throw new Error('learning: rollback needs a new revision id');
  return Object.freeze({ ...previous, revision: nextRevision, approved: false, source: `${previous.source} rollback-of:${previous.revision}` });
}

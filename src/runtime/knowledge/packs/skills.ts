/**
 * Skill manifests: parsing, deterministic rendering, conversion to knowledge candidates and task-relevant selection.
 *
 * Activation path (nothing here can shortcut it):
 *   manifest file -> `skillToCandidate` (approved:false) -> signed promotion into the durable store (engineering-knowledge-store)
 *   -> `selectSkills` considers ONLY skills whose current candidate digest equals an ACTIVE promoted entry -> `catalog.resolve`
 *   pins the selection digest in the task. A revoked, superseded, edited or never-promoted skill is therefore never selected
 *   for a new task, and a skill manifest can grant no tool, file, verifier or approval (see schema.ts).
 */
import { hashValue } from '../canonical.ts';
import { entryDigest, containsSuspiciousKnowledgeText, type KnowledgeEntry } from '../engineering-knowledge.ts';
import { scanForSecrets } from '../canonical.ts';
import { skillManifestSchema, type SkillManifest, type TaskLanguage, type TaskType } from './schema.ts';

const MAX_RENDERED_BYTES = 6_000;

export function parseSkillManifest(raw: unknown): SkillManifest {
  const parsed = skillManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`skill manifest invalid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`);
  const manifest = parsed.data;
  if (scanForSecrets(manifest).length) throw new Error(`skill manifest ${manifest.id} contains a credential`);
  if (containsSuspiciousKnowledgeText(JSON.stringify(manifest))) throw new Error(`skill manifest ${manifest.id} contains a reserved override token`);
  if (manifest.dependsOn.includes(manifest.id)) throw new Error(`skill manifest ${manifest.id} depends on itself`);
  if (new Set(manifest.scenarios.map((s) => s.id)).size !== manifest.scenarios.length) throw new Error(`skill manifest ${manifest.id} has duplicate scenario ids`);
  if (!manifest.scenarios.some((s) => s.selected) || !manifest.scenarios.some((s) => !s.selected)) throw new Error(`skill manifest ${manifest.id} needs both a positive and a negative scenario`);
  return manifest;
}

export const skillDigest = (m: SkillManifest): string => hashValue(m);

/** Deterministic text placed in a worker or specialist prompt. Instructional data, never authority. */
export function renderSkill(m: SkillManifest, mode: 'compact' | 'full' = 'compact'): string {
  const lines = [
    `Skill ${m.id}@${m.version}: ${m.title}`,
    m.summary,
    'Workflow:',
    ...m.workflow.map((w, i) => `${i + 1}. ${w.step}${w.check ? ` (check: ${w.check})` : ''}`),
    'Constraints:',
    ...m.constraints.map((c) => `- ${c}`),
    'Verify:',
    ...m.verification.map((v) => `- ${v}`),
  ];
  if (mode === 'full') lines.push('Examples:', ...m.examples.map((e) => `- ${e.title}: ${e.situation} -> ${e.guidance}`));
  return lines.join('\n');
}

export const skillRevision = (m: SkillManifest): string => `v${m.version.replaceAll('.', '-')}-${skillDigest(m).slice(0, 8)}`;

/** An INACTIVE knowledge entry for the manifest. Activation requires a signed promotion by a `promoter` key. */
export function skillToCandidate(m: SkillManifest): KnowledgeEntry {
  const body = renderSkill(m, 'compact');
  if (Buffer.byteLength(body, 'utf8') > MAX_RENDERED_BYTES) throw new Error(`skill ${m.id} renders to more than ${MAX_RENDERED_BYTES} bytes`);
  // The knowledge catalog gates only implementation languages. Review-only languages (ruby, rust) are catalogued as common and
  // are still selected only for requests in that language, so a Go or JS worker prompt can never receive them.
  const only = m.activation.languages.length === 1 ? m.activation.languages[0]! : undefined;
  const language: KnowledgeEntry['language'] = only === 'go' || only === 'js' || only === 'ts' ? only : 'common';
  return Object.freeze({
    id: m.id, revision: skillRevision(m), kind: 'skill', language, body,
    source: `engineering/skills/${m.id}.json sha256:${skillDigest(m)}`, approved: false,
  });
}

/** Digest the store records when this exact manifest is promoted. */
export const promotedDigestOf = (m: SkillManifest): string => entryDigest({ ...skillToCandidate(m), approved: true });

export interface SkillRequest { language: TaskLanguage; taskType: TaskType; text: string }
export type SkillOmission = Readonly<{ id: string; reason: 'not-promoted' | 'stale-or-revoked' | 'language' | 'task-type' | 'no-keyword' | 'missing-dependency' | 'budget' | 'limit' }>;
export interface SkillSelection { selected: readonly string[]; omitted: readonly SkillOmission[]; bytes: number; scores: Readonly<Record<string, number>> }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (haystack: string, keyword: string) => new RegExp(`(^|[^a-z0-9])${escape(keyword)}($|[^a-z0-9])`).test(haystack);
const MAX_TEXT = 4_000;

/**
 * Deterministic, budgeted selection. `active` maps skill id -> the digest of the ACTIVE promoted entry (from the durable
 * store's active catalog). The request text is untrusted: it can only influence the ranking of already promoted skills.
 */
export function selectSkills(
  manifests: readonly SkillManifest[],
  active: ReadonlyMap<string, string>,
  request: SkillRequest,
  options: { budgetBytes?: number; maxSkills?: number } = {},
): SkillSelection {
  const budget = options.budgetBytes ?? 4_000, limit = options.maxSkills ?? 6;
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 64_000 || !Number.isSafeInteger(limit) || limit < 0 || limit > 32) throw new Error('skills: invalid selection budget');
  const haystack = request.text.slice(0, MAX_TEXT).toLowerCase();
  const omitted: SkillOmission[] = [];
  const scores: Record<string, number> = {};
  const eligible: SkillManifest[] = [];
  for (const m of [...manifests].sort((a, b) => a.id.localeCompare(b.id))) {
    const activeDigest = active.get(m.id);
    if (activeDigest === undefined) { omitted.push({ id: m.id, reason: 'not-promoted' }); continue; }
    if (activeDigest !== promotedDigestOf(m)) { omitted.push({ id: m.id, reason: 'stale-or-revoked' }); continue; }
    if (!m.activation.languages.includes('common') && !m.activation.languages.includes(request.language)) { omitted.push({ id: m.id, reason: 'language' }); continue; }
    if (!m.activation.taskTypes.includes(request.taskType)) { omitted.push({ id: m.id, reason: 'task-type' }); continue; }
    const hits = m.activation.keywords.filter((k) => mentions(haystack, k)).length;
    if (hits === 0) { omitted.push({ id: m.id, reason: 'no-keyword' }); continue; }
    scores[m.id] = m.activation.priority + 10 * hits;
    eligible.push(m);
  }
  eligible.sort((a, b) => scores[b.id]! - scores[a.id]! || a.id.localeCompare(b.id));
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const chosen: string[] = [];
  let bytes = 0;
  const size = (m: SkillManifest) => Buffer.byteLength(renderSkill(m), 'utf8');
  for (const m of eligible) {
    if (chosen.includes(m.id)) continue;
    // A skill is only useful together with what it builds on; take the dependencies too or not at all.
    const closure = [...m.dependsOn.filter((d) => !chosen.includes(d)), m.id];
    const missing = closure.find((id) => !byId.has(id) || active.get(id) !== promotedDigestOf(byId.get(id)!) || (byId.get(id)!.activation.languages.includes('common') === false && !byId.get(id)!.activation.languages.includes(request.language)));
    if (missing) { omitted.push({ id: m.id, reason: 'missing-dependency' }); continue; }
    const cost = closure.reduce((n, id) => n + size(byId.get(id)!), 0);
    if (chosen.length + closure.length > limit) { omitted.push({ id: m.id, reason: 'limit' }); continue; }
    if (bytes + cost > budget) { omitted.push({ id: m.id, reason: 'budget' }); continue; }
    chosen.push(...closure);
    bytes += cost;
  }
  return Object.freeze({ selected: Object.freeze([...chosen].sort()), omitted: Object.freeze(omitted), bytes, scores: Object.freeze(scores) });
}

export interface ScenarioReport { total: number; passed: number; failures: readonly { skill: string; scenario: string; expected: boolean; actual: boolean }[] }

/**
 * Runs every manifest's declared scenarios through the REAL selector with all skills treated as promoted and no budget
 * pressure. Measures the selector's precision on the shipped catalog: a positive scenario must select its skill, a negative
 * one must not.
 */
export function evaluateSkillScenarios(manifests: readonly SkillManifest[]): ScenarioReport {
  const active = new Map(manifests.map((m) => [m.id, promotedDigestOf(m)]));
  const failures: { skill: string; scenario: string; expected: boolean; actual: boolean }[] = [];
  let total = 0;
  for (const m of manifests) {
    for (const s of m.scenarios) {
      total++;
      const actual = selectSkills(manifests, active, { language: s.task.language, taskType: s.task.taskType, text: s.task.text }, { budgetBytes: 64_000, maxSkills: 32 }).selected.includes(m.id);
      if (actual !== s.selected) failures.push({ skill: m.id, scenario: s.id, expected: s.selected, actual });
    }
  }
  return Object.freeze({ total, passed: total - failures.length, failures: Object.freeze(failures) });
}

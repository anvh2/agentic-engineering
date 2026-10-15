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

/** Memoizes the rendered size and promoted digest of manifests for the duration of one selection pass (or scenario run). */
export interface SkillCache { digest(m: SkillManifest): string; size(m: SkillManifest): number }
export function createSkillCache(): SkillCache {
  const digests = new Map<SkillManifest, string>(), sizes = new Map<SkillManifest, number>();
  return {
    digest: (m) => digests.get(m) ?? (digests.set(m, promotedDigestOf(m)), digests.get(m)!),
    size: (m) => sizes.get(m) ?? (sizes.set(m, Buffer.byteLength(renderSkill(m), 'utf8')), sizes.get(m)!),
  };
}

export interface SkillRequest { language: TaskLanguage; taskType: TaskType; text: string }
export type SkillOmission = Readonly<{ id: string; reason: 'not-promoted' | 'stale-or-revoked' | 'language' | 'task-type' | 'no-keyword' | 'missing-dependency' | 'budget' | 'limit' }>;
export interface SkillSelection { selected: readonly string[]; omitted: readonly SkillOmission[]; bytes: number; scores: Readonly<Record<string, number>> }

/** Light suffix stemming so "swallows", "swallowed" and "swallowing" meet. Deliberately simple and deterministic. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('es') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
  return w;
}
const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const containsRun = (haystack: readonly string[], needle: readonly string[]): boolean => {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) if (needle.every((t, j) => haystack[i + j] === t)) return true;
  return false;
};
export type Matching = 'exact' | 'stemmed';
/** Whether `keyword` (one or more words) appears in the already-tokenized text as a contiguous run of whole words. */
function mentions(haystack: readonly string[], keyword: string, matching: Matching): boolean {
  const needle = tokens(keyword);
  return containsRun(matching === 'stemmed' ? haystack.map(stem) : haystack, matching === 'stemmed' ? needle.map(stem) : needle);
}
const MAX_TEXT = 4_000;

/**
 * Deterministic, budgeted selection. `active` maps skill id -> the digest of the ACTIVE promoted entry (from the durable
 * store's active catalog). The request text is untrusted: it can only influence the ranking of already promoted skills.
 */
export function selectSkills(
  manifests: readonly SkillManifest[],
  active: ReadonlyMap<string, string>,
  request: SkillRequest,
  options: { budgetBytes?: number; maxSkills?: number; matching?: Matching; cache?: SkillCache } = {},
): SkillSelection {
  const budget = options.budgetBytes ?? 4_000, limit = options.maxSkills ?? 6;
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 64_000 || !Number.isSafeInteger(limit) || limit < 0 || limit > 32) throw new Error('skills: invalid selection budget');
  const haystack = tokens(request.text.slice(0, MAX_TEXT)), matching = options.matching ?? 'stemmed';
  const cache = options.cache ?? createSkillCache();
  const omitted: SkillOmission[] = [];
  const scores: Record<string, number> = {};
  const eligible: SkillManifest[] = [];
  for (const m of [...manifests].sort((a, b) => a.id.localeCompare(b.id))) {
    const activeDigest = active.get(m.id);
    if (activeDigest === undefined) { omitted.push({ id: m.id, reason: 'not-promoted' }); continue; }
    if (activeDigest !== cache.digest(m)) { omitted.push({ id: m.id, reason: 'stale-or-revoked' }); continue; }
    if (!m.activation.languages.includes('common') && !m.activation.languages.includes(request.language)) { omitted.push({ id: m.id, reason: 'language' }); continue; }
    if (!m.activation.taskTypes.includes(request.taskType)) { omitted.push({ id: m.id, reason: 'task-type' }); continue; }
    const hits = m.activation.keywords.filter((k) => mentions(haystack, k, matching)).length;
    if (hits === 0) { omitted.push({ id: m.id, reason: 'no-keyword' }); continue; }
    scores[m.id] = m.activation.priority + 10 * hits;
    eligible.push(m);
  }
  eligible.sort((a, b) => scores[b.id]! - scores[a.id]! || a.id.localeCompare(b.id));
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const usable = (d: SkillManifest): boolean => active.get(d.id) === cache.digest(d) && (d.activation.languages.includes('common') || d.activation.languages.includes(request.language));
  /** The skill and everything it transitively builds on, dependencies first; undefined if any link is unusable (or cyclic). */
  const closureOf = (root: SkillManifest): SkillManifest[] | undefined => {
    const order: SkillManifest[] = [], done = new Set<string>(), visiting = new Set<string>();
    const visit = (cur: SkillManifest): boolean => {
      if (done.has(cur.id)) return true;
      if (visiting.has(cur.id)) return false;
      visiting.add(cur.id);
      for (const id of cur.dependsOn) { const dep = byId.get(id); if (!dep || !usable(dep) || !visit(dep)) return false; }
      visiting.delete(cur.id); done.add(cur.id); order.push(cur);
      return true;
    };
    return visit(root) ? order : undefined;
  };
  const chosen: string[] = [];
  let bytes = 0;
  for (const m of eligible) {
    if (chosen.includes(m.id)) continue;
    // A skill is only useful together with what it builds on; take all of it (transitively) or none of it.
    const closure = closureOf(m);
    if (!closure) { omitted.push({ id: m.id, reason: 'missing-dependency' }); continue; }
    const fresh = closure.filter((c) => !chosen.includes(c.id));
    const cost = fresh.reduce((n, c) => n + cache.size(c), 0);
    if (chosen.length + fresh.length > limit) { omitted.push({ id: m.id, reason: 'limit' }); continue; }
    if (bytes + cost > budget) { omitted.push({ id: m.id, reason: 'budget' }); continue; }
    chosen.push(...fresh.map((c) => c.id));
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
  const cache = createSkillCache();
  const active = new Map(manifests.map((m) => [m.id, cache.digest(m)]));
  const failures: { skill: string; scenario: string; expected: boolean; actual: boolean }[] = [];
  let total = 0;
  for (const m of manifests) {
    for (const s of m.scenarios) {
      total++;
      const actual = selectSkills(manifests, active, { language: s.task.language, taskType: s.task.taskType, text: s.task.text }, { budgetBytes: 64_000, maxSkills: 32, cache }).selected.includes(m.id);
      if (actual !== s.selected) failures.push({ skill: m.id, scenario: s.id, expected: s.selected, actual });
    }
  }
  return Object.freeze({ total, passed: total - failures.length, failures: Object.freeze(failures) });
}

/** id -> digest of every ACTIVE promoted skill entry in a catalog (the durable store's `activeCatalog()`), the selector's trust input. */
export function activeSkillDigests(entries: readonly KnowledgeEntry[]): ReadonlyMap<string, string> {
  return new Map(entries.filter((e) => e.kind === 'skill' && e.approved).map((e) => [e.id, entryDigest(e)]));
}

export interface SkillPin {
  /** Goes into `CodingTask.knowledge`; the runner and the reviewer recompute the digest from the same trusted catalog. */
  knowledge: { ids: string[]; selectionDigest: string } | undefined;
  selection: SkillSelection;
}

/**
 * The seam between skills and a task contract. Selects promoted skills for the task and resolves them in the runtime's own
 * catalog to the digest the task pins. The result adds ONLY guidance text: no allowed file, verifier command, tool or approval
 * can come out of this function, and a skill revoked or edited later makes the pin fail to resolve (the task stays with Claude).
 */
export function pinSkillsForTask(
  manifests: readonly SkillManifest[],
  catalog: { list(): readonly KnowledgeEntry[]; resolve(request: { language: 'go' | 'js' | 'ts'; ids: readonly string[]; maxBytes?: number }): { digest: string; omitted: readonly string[] } },
  request: SkillRequest & { language: 'go' | 'js' | 'ts' },
  options: { budgetBytes?: number; maxSkills?: number } = {},
): SkillPin {
  const selection = selectSkills(manifests, activeSkillDigests(catalog.list()), request, options);
  if (selection.selected.length === 0) return { knowledge: undefined, selection };
  const resolved = catalog.resolve({ language: request.language, ids: selection.selected });
  if (resolved.omitted.length) throw new Error(`skills: selection exceeds the catalog budget (${resolved.omitted.join(', ')})`);
  return { knowledge: { ids: [...selection.selected], selectionDigest: resolved.digest }, selection };
}

/**
 * Read-only control plane for the engineering pack: status, drift, readiness and health as one machine-readable report.
 *
 * Nothing here writes, signs, promotes, installs hooks or edits configuration. Inputs are passed in (or read through a
 * read-only database handle), so the same report backs the CLI, the Mastra Studio route and tests. Provider readiness is derived
 * from configuration only; a network probe happens solely when the caller asks for it and only against a loopback address.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hashValue } from './canonical.ts';
import { diagnoseEngineeringSetup, type DoctorFinding } from './engineering-doctor.ts';
import { entryDigest, EngineeringKnowledgeCatalog, type KnowledgeEntry } from './engineering-knowledge.ts';
import { recommendActions, type Recommendation } from './engineering-learning.ts';
import { skillHealth, type SkillHealth, type SkillRun } from './engineering-skill-health.ts';
import type { Trial } from './engineering-eval.ts';
import { negotiate } from './packs/agents.ts';
import type { PackRegistry } from './packs/loader.ts';
import { activeSkillDigests, evaluateSkillScenarios, promotedDigestOf, type ScenarioReport } from './packs/skills.ts';

export const STATUS_SCHEMA = 'engineering-status/v1';

export interface ProviderReadiness {
  id: 'ollama' | 'claude' | 'codex';
  configured: boolean;
  /** Where the answer came from. `probe` only when the caller explicitly asked and the target was loopback. */
  basis: 'environment' | 'probe' | 'not-checked';
  detail: string;
  model?: string;
  declaredContextTokens?: number;
}

export interface EngineeringReport {
  schema: typeof STATUS_SCHEMA;
  generatedAt: number;
  pack: { loaded: boolean; error?: string; digest?: string; skills: number; agents: number };
  scenarios?: ScenarioReport;
  skills: readonly { id: string; version: string; category: string; state: 'active' | 'not-promoted' | 'stale'; bytes: number }[];
  agents: readonly { id: string; version: string; name: string; tools: readonly string[]; taskTypes: readonly string[]; languages: readonly string[]; skillPool: number; skillsActive: number; mastraOllama: 'supported' | string }[];
  drift: { stale: readonly string[]; orphaned: readonly string[]; unpromoted: readonly string[] };
  health: readonly SkillHealth[];
  recommendations: readonly Recommendation[];
  providers: readonly ProviderReadiness[];
  issues: readonly DoctorFinding[];
  /** Digest of everything above except `generatedAt`, so two reports can be compared byte-for-byte. */
  reportDigest: string;
}

export interface ReportInput {
  registry: PackRegistry | undefined;
  registryError?: string;
  /** Active promoted entries from the durable knowledge store (any kind). */
  activeEntries: readonly KnowledgeEntry[];
  skillRuns?: readonly SkillRun[];
  trials?: readonly Trial[];
  env?: NodeJS.ProcessEnv;
  now: number;
  /** Overrides environment-derived readiness, e.g. with a probe result. */
  providers?: readonly ProviderReadiness[];
}

export function providerReadiness(env: NodeJS.ProcessEnv = process.env): readonly ProviderReadiness[] {
  const ctx = Number(env.OLLAMA_NUM_CTX);
  const url = env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  return [
    { id: 'ollama', configured: true, basis: 'environment', detail: `endpoint ${url} (not contacted)`, model: env.OLLAMA_MODEL ?? 'qwen3:8b', ...(Number.isSafeInteger(ctx) && ctx > 0 ? { declaredContextTokens: ctx } : {}) },
    { id: 'claude', configured: false, basis: 'not-checked', detail: 'Claude Code is the Engineering Lead harness; availability is not probed by this report' },
    { id: 'codex', configured: false, basis: 'not-checked', detail: 'Codex readiness is checked by the provider registry when a task selects it; not probed here' },
  ];
}

/** Optional readiness probe. Only a loopback Ollama endpoint is contacted; anything else is reported as skipped, never fetched. */
export async function probeOllama(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, timeoutMs = 2000): Promise<ProviderReadiness> {
  const base = env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  let host: string;
  try { host = new URL(base).hostname; } catch { return { id: 'ollama', configured: false, basis: 'probe', detail: 'OLLAMA_BASE_URL is not a valid URL' }; }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return { id: 'ollama', configured: true, basis: 'not-checked', detail: `probe skipped: ${host} is not a loopback address` };
  try {
    const res = await fetchImpl(`${base.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    const model = env.OLLAMA_MODEL ?? 'qwen3:8b';
    if (!res.ok) return { id: 'ollama', configured: true, basis: 'probe', detail: `endpoint answered HTTP ${res.status}`, model };
    const body = (await res.json()) as { models?: { name?: string }[] };
    const present = (body.models ?? []).some((m) => m.name === model || m.name?.startsWith(`${model}:`));
    return { id: 'ollama', configured: present, basis: 'probe', detail: present ? 'endpoint reachable and model present' : `endpoint reachable but model ${model} is not installed`, model };
  } catch {
    return { id: 'ollama', configured: false, basis: 'probe', detail: 'endpoint unreachable' };
  }
}

/** Active promoted entries via a READ-ONLY connection. A row whose stored digest no longer matches its manifest fails the read. */
export function readActiveKnowledge(dbPath: string): readonly KnowledgeEntry[] {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT manifest_json, digest FROM engineering_knowledge WHERE revoked_at IS NULL ORDER BY id').all() as unknown as { manifest_json: string; digest: string }[];
    return rows.map((row) => {
      const entry = JSON.parse(row.manifest_json) as KnowledgeEntry;
      if (entryDigest(entry) !== row.digest) throw new Error('knowledge: corrupt stored manifest');
      return entry;
    });
  } catch (e) {
    if (/no such table/.test((e as Error).message)) return [];
    throw e;
  } finally {
    db.close();
  }
}

/** Where the durable knowledge store lives: `<workdir>/engineering/knowledge.db` (runtime state, gitignored). */
export const knowledgeDbPath = (workdir: string): string => join(workdir, 'engineering', 'knowledge.db');

/**
 * The runtime's trusted catalog of GLOBAL promoted entries, read fresh from the store through a read-only connection, or
 * `undefined` when nothing has ever been promoted. A corrupted store throws: a damaged trust root must stop the work that depends
 * on it, not silently degrade into "no guidance". Project-scoped lessons are excluded here; they need a project context.
 */
export function loadActiveCatalog(dbPath: string): EngineeringKnowledgeCatalog | undefined {
  const entries = readActiveKnowledge(dbPath).filter((e) => e.projectId === undefined);
  return entries.length ? new EngineeringKnowledgeCatalog(entries) : undefined;
}

/** id -> digest of active promoted skills, for optional guidance. Any failure yields no skills (guidance is optional). */
export function defaultActiveSkills(dbPath: string): ReadonlyMap<string, string> {
  try { return activeSkillDigests(readActiveKnowledge(dbPath)); } catch { return new Map(); }
}

export function buildEngineeringReport(input: ReportInput): EngineeringReport {
  const env = input.env ?? process.env;
  const issues: DoctorFinding[] = [];
  const active = activeSkillDigests(input.activeEntries);
  const registry = input.registry;
  const stale: string[] = [], orphaned: string[] = [], unpromoted: string[] = [];
  let scenarios: ScenarioReport | undefined;
  let skills: EngineeringReport['skills'] = [];
  let agents: EngineeringReport['agents'] = [];

  if (!registry) {
    issues.push({ code: 'pack_unloaded', level: 'error', detail: input.registryError ?? 'engineering pack not loaded' });
  } else {
    scenarios = evaluateSkillScenarios(registry.skills);
    if (scenarios.failures.length) issues.push({ code: 'skill_scenarios_failing', level: 'error', detail: scenarios.failures.map((f) => `${f.skill}/${f.scenario}`).join(', ') });
    const stateOf = (id: string, digest: string): 'active' | 'not-promoted' | 'stale' => (!active.has(id) ? 'not-promoted' : active.get(id) === digest ? 'active' : 'stale');
    skills = registry.skills.map((s) => {
      const state = stateOf(s.id, promotedDigestOf(s));
      if (state === 'stale') stale.push(s.id);
      else if (state === 'not-promoted') unpromoted.push(s.id);
      return { id: s.id, version: s.version, category: s.category, state, bytes: Buffer.byteLength(JSON.stringify(s)) };
    });
    for (const id of active.keys()) if (!registry.skillById.has(id)) orphaned.push(id);
    const ctx = Number(env.OLLAMA_NUM_CTX);
    agents = registry.agents.map((a) => {
      const pool = [...a.skills, ...a.optionalSkills];
      const fit = negotiate(a, 'mastra', 'ollama', Number.isSafeInteger(ctx) && ctx > 0 ? ctx : undefined, { requireKnownContext: true });
      return { id: a.id, version: a.version, name: a.name, tools: [...a.tools], taskTypes: [...a.taskTypes], languages: [...a.languages], skillPool: pool.length, skillsActive: pool.filter((id) => active.get(id) === promotedDigestOf(registry.skillById.get(id)!)).length, mastraOllama: fit.supported ? 'supported' : fit.reason };
    });
    if (active.size === 0) issues.push({ code: 'no_promoted_skills', level: 'warning', detail: 'No skills are promoted: specialists and workers run without skill guidance. Promotion needs a signed grant.' });
    if (stale.length) issues.push({ code: 'promoted_skill_stale', level: 'warning', detail: `Manifest changed after promotion (not selected until re-promoted): ${stale.join(', ')}` });
    if (orphaned.length) issues.push({ code: 'promoted_skill_orphaned', level: 'warning', detail: `Promoted but absent from the pack: ${orphaned.join(', ')}` });
    for (const a of agents) if (a.skillsActive === 0 && active.size > 0) issues.push({ code: 'agent_without_active_skills', level: 'info', detail: a.id });
    if (!(Number.isSafeInteger(ctx) && ctx > 0)) issues.push({ code: 'model_context_undeclared', level: 'warning', detail: 'OLLAMA_NUM_CTX is not set: specialists are refused on the Mastra harness until the local model\'s context window is declared (they need at least 8192 tokens)' });
    else for (const a of agents) if (a.mastraOllama !== 'supported') issues.push({ code: 'agent_unsupported_on_configured_model', level: 'warning', detail: `${a.id}: ${a.mastraOllama}` });
  }

  const health = skillHealth(input.skillRuns ?? [], input.now);
  const recommendations = recommendActions(health).filter((r) => r.action !== 'none');
  for (const r of recommendations) if (r.action === 'revoke-or-rollback') issues.push({ code: 'skill_declining', level: 'warning', detail: `${r.skillId}@${r.revision}: ${r.reason}` });

  // The doctor builds one catalog, which is global by construction; project-scoped lessons are counted, never mixed in.
  const global = input.activeEntries.filter((e) => e.projectId === undefined);
  const scoped = input.activeEntries.length - global.length;
  if (scoped) issues.push({ code: 'project_scoped_entries', level: 'info', detail: `${scoped} active project-scoped entr${scoped === 1 ? 'y' : 'ies'} (visible only to their own project)` });
  for (const f of diagnoseEngineeringSetup({ entries: global, trials: input.trials ?? [], configuredAdapters: ['go', 'js'], hooksEnabled: false })) {
    if (f.code === 'no_approved_knowledge' && active.size > 0) continue; // skills are the approved knowledge; the doctor only looked at global rules
    if (!issues.some((i) => i.code === f.code)) issues.push(f);
  }

  const body = {
    schema: STATUS_SCHEMA,
    pack: registry ? { loaded: true, digest: registry.digest, skills: registry.skills.length, agents: registry.agents.length } : { loaded: false, error: input.registryError, skills: 0, agents: 0 },
    scenarios, skills, agents, drift: { stale, orphaned, unpromoted }, health, recommendations, providers: input.providers ?? providerReadiness(env), issues,
  };
  return Object.freeze({ ...body, generatedAt: input.now, reportDigest: hashValue(JSON.parse(JSON.stringify(body))) }) as EngineeringReport;
}

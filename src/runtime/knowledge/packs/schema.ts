/**
 * Portable, framework-independent manifests for engineering skills and specialist agents.
 *
 * A manifest is DATA. The schemas are strict (`z.strictObject`): there is no field through which a skill or an agent could
 * request tools, allowed files, verifier argv, approvals or write access, and an unknown field is a validation error rather
 * than something silently ignored. Authority comes only from the runtime (hooks.TOOL_CLASSES, the language adapters, signed
 * promotion), never from a manifest.
 *
 * Nothing here imports Mastra or any provider. Mastra, Claude Code and other harnesses render these manifests through
 * adapters (see src/integrations/mastra/specialist-agents.ts and packs/harness.ts).
 */
import { z } from 'zod';

/** ECC revision the adapted content was reviewed against. Attribution only; nothing is fetched or executed from it. */
export const ECC_COMMIT = 'b92f181b3b748d1abbc2afd94af6aa7d8c8fca29';

export const TASK_TYPES = ['plan', 'explore', 'design', 'implement', 'test', 'review', 'debug', 'refactor', 'document', 'operate', 'evaluate'] as const;
export type TaskType = typeof TASK_TYPES[number];
/** `ruby` and `rust` exist for read-only review content only. The language adapters still delegate no Ruby or Rust implementation. */
export const PACK_LANGUAGES = ['go', 'js', 'ts', 'ruby', 'rust', 'common'] as const;
export const TASK_LANGUAGES = ['go', 'js', 'ts', 'ruby', 'rust'] as const;
export type TaskLanguage = typeof TASK_LANGUAGES[number];
export const HARNESSES = ['mastra', 'claude-code', 'codex', 'qwen'] as const;
export type Harness = typeof HARNESSES[number];
export const SKILL_CATEGORIES = ['research', 'architecture', 'implementation', 'quality', 'security', 'reliability', 'operations', 'agent-engineering', 'optimization'] as const;

export const PACK_ID = /^[a-z][a-z0-9-]{2,63}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !s.includes('\u0000'), 'NUL byte');
const short = text(200);
const long = text(1200);

export const provenanceSchema = z.strictObject({
  origin: z.enum(['original', 'ecc-adapted']),
  sources: z.array(z.strictObject({ path: short, commit: z.string().regex(/^[a-f0-9]{40}$/) })).max(8),
  license: z.enum(['Apache-2.0', 'MIT']),
  notes: long,
}).refine((p) => p.origin === 'original' || p.sources.length > 0, { message: 'adapted content must name its source files' });

export const skillManifestSchema = z.strictObject({
  schema: z.literal('engineering-skill/v1'),
  id: z.string().regex(PACK_ID),
  version: z.string().regex(SEMVER),
  title: short,
  summary: long,
  category: z.enum(SKILL_CATEGORIES),
  provenance: provenanceSchema,
  activation: z.strictObject({
    languages: z.array(z.enum(PACK_LANGUAGES)).min(1).max(PACK_LANGUAGES.length),
    taskTypes: z.array(z.enum(TASK_TYPES)).min(1).max(TASK_TYPES.length),
    /** Lower-case words or phrases; a task must mention at least one for the skill to be considered. */
    keywords: z.array(z.string().regex(/^[a-z0-9][a-z0-9 ._-]{1,39}$/)).min(2).max(24),
    priority: z.number().int().min(0).max(100),
  }),
  inputs: z.array(z.strictObject({ name: short, description: long, required: z.boolean() })).min(1).max(8),
  outputs: z.array(z.strictObject({ name: short, description: long })).min(1).max(8),
  workflow: z.array(z.strictObject({ step: long, check: long.optional() })).min(3).max(14),
  constraints: z.array(long).min(1).max(10),
  examples: z.array(z.strictObject({ title: short, situation: long, guidance: long })).min(1).max(4),
  verification: z.array(long).min(1).max(8),
  compatibility: z.strictObject({ harnesses: z.array(z.enum(HARNESSES)).min(1).max(HARNESSES.length) }),
  dependsOn: z.array(z.string().regex(PACK_ID)).max(4),
  /** Executable usage scenarios: the registry test runs them through the real selector. */
  scenarios: z.array(z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    task: z.strictObject({ language: z.enum(TASK_LANGUAGES), taskType: z.enum(TASK_TYPES), text: text(400) }),
    selected: z.boolean(),
  })).min(2).max(8),
});
export type SkillManifest = z.infer<typeof skillManifestSchema>;

export const OUTPUT_KINDS = ['findings', 'plan', 'report'] as const;
export const agentManifestSchema = z.strictObject({
  schema: z.literal('engineering-agent/v1'),
  id: z.string().regex(PACK_ID),
  version: z.string().regex(SEMVER),
  name: short,
  responsibility: long,
  /** Why this role exists rather than another one; reviewed when the catalog changes. */
  rationale: long,
  taskTypes: z.array(z.enum(TASK_TYPES)).min(1).max(TASK_TYPES.length),
  languages: z.array(z.enum(PACK_LANGUAGES)).min(1).max(PACK_LANGUAGES.length),
  skills: z.array(z.string().regex(PACK_ID)).min(1).max(6),
  optionalSkills: z.array(z.string().regex(PACK_ID)).max(6),
  /** Tool ids requested. The runtime grants only those whose class is `read` (hooks.TOOL_CLASSES); anything else fails validation. */
  tools: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]{2,39}$/)).min(1).max(8),
  providers: z.array(z.strictObject({ id: z.enum(['ollama', 'claude', 'codex']), minContextTokens: z.number().int().min(2048).max(1_000_000) })).min(1).max(3),
  compatibility: z.strictObject({ harnesses: z.array(z.enum(HARNESSES)).min(1).max(HARNESSES.length) }),
  output: z.strictObject({ kind: z.enum(OUTPUT_KINDS), maxFindings: z.number().int().min(1).max(40) }),
  guidance: z.array(long).min(2).max(10),
  escalation: z.strictObject({
    onInvalidOutput: z.enum(['fail', 'retry-once']),
    onUncertain: z.literal('report-unknown'),
    onProviderUnavailable: z.literal('fail'),
    handoff: long,
  }),
  limits: z.strictObject({ maxSteps: z.number().int().min(1).max(40), timeoutMs: z.number().int().min(5_000).max(1_800_000), maxOutputBytes: z.number().int().min(1024).max(65_536) }),
  provenance: provenanceSchema,
  scenarios: z.array(z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    task: z.strictObject({ language: z.enum(TASK_LANGUAGES), taskType: z.enum(TASK_TYPES), text: text(400) }),
    shouldHandle: z.boolean(),
  })).min(2).max(8),
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

/** The one result shape every specialist must return. Findings feed review consensus; they never approve anything. */
export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const specialistReportSchema = z.strictObject({
  summary: text(1500),
  status: z.enum(['no-issues', 'issues', 'insufficient-evidence']),
  findings: z.array(z.strictObject({
    severity: z.enum(SEVERITIES),
    path: text(400),
    evidence: text(1200),
    description: text(1200),
    recommendation: text(1200).optional(),
  })).max(40),
  unknowns: z.array(text(400)).max(20),
});
export type SpecialistReport = z.infer<typeof specialistReportSchema>;

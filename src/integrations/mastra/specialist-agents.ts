/**
 * Mastra rendering of the portable specialist manifests (engineering/agents/*.json).
 *
 * What this module guarantees:
 *  - Constructing an Agent makes NO model call and touches no repository. Registration only makes the specialist visible.
 *  - Tools come from a runtime-owned table restricted to `read` class tools (see hooks.TOOL_CLASSES). A manifest can name a
 *    tool but cannot create one, and `assertReadOnlyToolTable` fails loudly at import if the table ever drifts.
 *  - The repository the tools may read is NEVER chosen by the model. It arrives through Mastra's RequestContext, set by
 *    specialist-review-workflow from a path the runtime has checked; without it every tool fails closed.
 *  - Output is advisory. Nothing here can produce a PASS or an approval.
 *
 * Registration is bounded (MAX_SPECIALISTS) and a failed pack load degrades to "no specialists" with a recorded reason instead
 * of preventing the coding workers from registering.
 */
import { Agent } from '@mastra/core/agent';
import { findProjectRoot } from '../../core/paths.ts';
import { listFiles, readFile, searchFiles } from '../../workers/tools/repository-tools.ts';
import { gitDiff, gitStatus } from '../../workers/tools/execution-tools.ts';
import { TOOL_CLASSES } from '../../runtime/knowledge/engineering-hooks.ts';
import { loadPackRegistry, type PackRegistry } from '../../runtime/knowledge/packs/loader.ts';
import { renderAgentInstructions } from '../../runtime/knowledge/packs/agents.ts';
import type { AgentManifest } from '../../runtime/knowledge/packs/schema.ts';
import { bindAgent, modelResolverFromEnv, ModelResolutionError, ollamaSettings, type ModelResolver, type ResolvedModel } from '../../runtime/models/index.ts';

export const MAX_SPECIALISTS = 64;

/** Runtime-owned. Adding a tool here is a permission change reviewed as code, never a manifest edit. */
export const SPECIALIST_TOOL_TABLE = { listFiles, readFile, searchFiles, gitDiff, gitStatus } as const;
type ToolId = keyof typeof SPECIALIST_TOOL_TABLE;

export function assertReadOnlyToolTable(): void {
  for (const id of Object.keys(SPECIALIST_TOOL_TABLE)) {
    if (TOOL_CLASSES[id] !== 'read') throw new Error(`specialist tool ${id} is not read-class`);
  }
}
assertReadOnlyToolTable();

/**
 * What a specialist needs from a model, derived from its manifest. It can only narrow which models are acceptable; it never
 * names or grants one. Context size is not checked here: `negotiate` owns the manifest's per-provider minimum.
 */
export const specialistModelRequirements = (manifest: AgentManifest) => ({ toolCalling: manifest.tools.length > 0, structuredOutput: true }) as const;

/**
 * The authorized model for a specialist, or a ModelResolutionError. Which model that is comes from runtime configuration
 * (src/runtime/models), never from the manifest, so a specialist can move between compatible models with no manifest change.
 */
export function resolveSpecialistModel(manifest: AgentManifest, resolver: ModelResolver = modelResolverFromEnv()): ResolvedModel {
  return resolver.resolve({ agentId: specialistAgentId(manifest), role: 'specialist', requires: specialistModelRequirements(manifest) });
}

/** @deprecated Use `resolveSpecialistModel`. Kept for callers of the pre-registry env wiring; returns the default local model. */
export function specialistModelConfig(env: NodeJS.ProcessEnv = process.env) {
  return modelResolverFromEnv(env).resolve({ agentId: 'specialist-default', role: 'specialist' }).model;
}

/** Context window the operator declares for the local model; undefined when unknown (never guessed). */
export function declaredContextTokens(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return ollamaSettings(env).contextTokens;
}

export const specialistAgentId = (manifest: AgentManifest): string => `specialist-${manifest.id}`;
export const specialistRegistryKey = (manifest: AgentManifest): string => `specialist_${manifest.id.replaceAll('-', '_')}`;

export interface SpecialistModelOptions {
  /** Test seam: a ready-made Mastra model that bypasses the resolver (and records no binding). Production paths never pass it. */
  model?: ConstructorParameters<typeof Agent>[0]['model'];
  resolver?: ModelResolver;
}

export function createMastraSpecialist(manifest: AgentManifest, options: SpecialistModelOptions = {}): Agent {
  const tools: Record<string, (typeof SPECIALIST_TOOL_TABLE)[ToolId]> = {};
  for (const id of manifest.tools) {
    if (!Object.hasOwn(SPECIALIST_TOOL_TABLE, id)) throw new Error(`Mastra specialist ${manifest.id} requests tool ${id} that is not in the read-only table`);
    tools[id] = SPECIALIST_TOOL_TABLE[id as ToolId];
  }
  const resolved = options.model ? undefined : resolveSpecialistModel(manifest, options.resolver);
  const agent = new Agent({
    id: specialistAgentId(manifest),
    name: manifest.name,
    description: manifest.responsibility,
    instructions: renderAgentInstructions(manifest),
    model: options.model ?? resolved!.model,
    tools,
    defaultOptions: { maxSteps: manifest.limits.maxSteps },
  });
  if (!resolved) return agent;
  boundModels.set(agent, resolved.model);
  return bindAgent(agent, resolved.binding);
}

const boundModels = new WeakMap<object, ResolvedModel['model']>();

/**
 * The exact model configuration object the resolver gave this specialist at construction. Mastra can repoint an agent later
 * (`Agent.__updateModel`, e.g. Studio's model picker), which replaces `agent.model` but not its binding; a caller that must
 * run on the bound model compares `agent.model` to this by reference. Undefined for agents built without the resolver.
 */
export const boundModelOf = (agent: object | undefined | null): Readonly<ResolvedModel['model']> | undefined => (agent ? boundModels.get(agent) : undefined);

export interface SpecialistRegistration {
  /** Agents keyed for `new Mastra({ agents })`; empty when the pack could not be loaded. */
  agents: Record<string, Agent>;
  registry: PackRegistry | undefined;
  /** Why no specialists were registered, when that is the case. */
  error: string | undefined;
  /** Specialists left out because no authorized, available, capable model could be resolved for them. Never silently substituted. */
  refused: { id: string; code: string; reason: string }[];
}

/** Locates the pack from the working directory first (how `mastra dev` and the built server run), then from this file. */
export function locatePackRoot(): string | null {
  return findProjectRoot(process.cwd()) ?? findProjectRoot(import.meta.dirname);
}

export function registerSpecialists(registryOrRoot: PackRegistry | string | null = locatePackRoot(), options: SpecialistModelOptions = {}): SpecialistRegistration {
  const refused: SpecialistRegistration['refused'] = [];
  try {
    if (registryOrRoot === null) throw new Error('project root not found; engineering pack not loaded');
    const registry = typeof registryOrRoot === 'string' ? loadPackRegistry(registryOrRoot) : registryOrRoot;
    if (registry.agents.length > MAX_SPECIALISTS) throw new Error(`pack declares ${registry.agents.length} agents, limit is ${MAX_SPECIALISTS}`);
    // One resolver for the whole catalog; an invalid model configuration throws here and registers nothing (fail closed).
    const resolver = options.model ? undefined : (options.resolver ?? modelResolverFromEnv());
    const agents: Record<string, Agent> = {};
    for (const manifest of registry.agents) {
      const key = specialistRegistryKey(manifest);
      if (Object.hasOwn(agents, key)) throw new Error(`duplicate specialist registry key ${key}`);
      try {
        agents[key] = createMastraSpecialist(manifest, { ...options, ...(resolver ? { resolver } : {}) });
      } catch (err) {
        if (!(err instanceof ModelResolutionError)) throw err;
        refused.push({ id: manifest.id, code: err.code, reason: err.message });
      }
    }
    return { agents, registry, error: undefined, refused };
  } catch (err) {
    return { agents: {}, registry: undefined, error: (err as Error).message, refused };
  }
}

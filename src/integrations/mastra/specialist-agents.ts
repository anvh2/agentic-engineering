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

/** Model wiring: the same local Ollama endpoint the coding workers use. Reading env here does not contact the endpoint. */
export function specialistModelConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    providerId: 'ollama',
    modelId: env.OLLAMA_MODEL ?? 'qwen3:8b',
    url: `${(env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '')}/v1`,
    apiKey: env.OLLAMA_API_KEY || 'ollama',
  } as const;
}

/** Context window the operator declares for the local model; undefined when unknown (never guessed). */
export function declaredContextTokens(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.OLLAMA_NUM_CTX;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export const specialistAgentId = (manifest: AgentManifest): string => `specialist-${manifest.id}`;
export const specialistRegistryKey = (manifest: AgentManifest): string => `specialist_${manifest.id.replaceAll('-', '_')}`;

export function createMastraSpecialist(manifest: AgentManifest, options: { model?: ConstructorParameters<typeof Agent>[0]['model'] } = {}): Agent {
  const tools: Record<string, (typeof SPECIALIST_TOOL_TABLE)[ToolId]> = {};
  for (const id of manifest.tools) {
    if (!Object.hasOwn(SPECIALIST_TOOL_TABLE, id)) throw new Error(`Mastra specialist ${manifest.id} requests tool ${id} that is not in the read-only table`);
    tools[id] = SPECIALIST_TOOL_TABLE[id as ToolId];
  }
  return new Agent({
    id: specialistAgentId(manifest),
    name: manifest.name,
    description: manifest.responsibility,
    instructions: renderAgentInstructions(manifest),
    model: options.model ?? specialistModelConfig(),
    tools,
    defaultOptions: { maxSteps: manifest.limits.maxSteps },
  });
}

export interface SpecialistRegistration {
  /** Agents keyed for `new Mastra({ agents })`; empty when the pack could not be loaded. */
  agents: Record<string, Agent>;
  registry: PackRegistry | undefined;
  /** Why no specialists were registered, when that is the case. */
  error: string | undefined;
}

/** Locates the pack from the working directory first (how `mastra dev` and the built server run), then from this file. */
export function locatePackRoot(): string | null {
  return findProjectRoot(process.cwd()) ?? findProjectRoot(import.meta.dirname);
}

export function registerSpecialists(registryOrRoot: PackRegistry | string | null = locatePackRoot(), options: { model?: ConstructorParameters<typeof Agent>[0]['model'] } = {}): SpecialistRegistration {
  try {
    if (registryOrRoot === null) throw new Error('project root not found; engineering pack not loaded');
    const registry = typeof registryOrRoot === 'string' ? loadPackRegistry(registryOrRoot) : registryOrRoot;
    if (registry.agents.length > MAX_SPECIALISTS) throw new Error(`pack declares ${registry.agents.length} agents, limit is ${MAX_SPECIALISTS}`);
    const agents: Record<string, Agent> = {};
    for (const manifest of registry.agents) {
      const key = specialistRegistryKey(manifest);
      if (Object.hasOwn(agents, key)) throw new Error(`duplicate specialist registry key ${key}`);
      agents[key] = createMastraSpecialist(manifest, options);
    }
    return { agents, registry, error: undefined };
  } catch (err) {
    return { agents: {}, registry: undefined, error: (err as Error).message };
  }
}

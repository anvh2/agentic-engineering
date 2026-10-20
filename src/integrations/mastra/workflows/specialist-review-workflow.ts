import { createStep, createWorkflow } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { delimiter } from 'node:path';
import { hashValue } from '../../../runtime/knowledge/canonical.ts';
import { loadPackRegistry, type PackRegistry } from '../../../runtime/knowledge/packs/loader.ts';
import { handles, negotiate, parseSpecialistReport } from '../../../runtime/knowledge/packs/agents.ts';
import { buildFindingStatements, checkRepository, composeReviewPrompt, REVIEW_STATUSES, type FindingSigner, type ReviewStatus } from '../../../runtime/knowledge/packs/review.ts';
import { PACK_ID, specialistReportSchema, TASK_LANGUAGES, TASK_TYPES, type AgentManifest } from '../../../runtime/knowledge/packs/schema.ts';
import { REPOSITORY_ROOT_CONTEXT_KEY } from '../../../workers/tools/repository-tools.ts';
import { createMastraSpecialist, locatePackRoot, resolveSpecialistModel, specialistRegistryKey } from '../specialist-agents.ts';
import { bindingMetadata, bindingOf, ModelConfigError, ModelResolutionError, modelResolverFromEnv, type ModelBinding, type ModelResolver, type ResolvedModel } from '../../../runtime/models/index.ts';
import { findProjectRoot } from '../../../core/paths.ts';
import { defaultActiveSkills, knowledgeDbPath } from '../../../runtime/knowledge/engineering-control.ts';
import { join } from 'node:path';

/**
 * specialist-review-workflow: the supported way to run a read-only specialist from Mastra Studio, the API or another workflow.
 *
 *   prepare-specialist-review   validate the request, check the repository against operator-configured roots, check task fit and
 *                               capability, select promoted skills, compose the prompt. A refusal here makes NO model call.
 *   run-specialist              one bounded agent run with the repository passed through RequestContext (never chosen by the
 *                               model), a timeout, cancellation and trace metadata; output parsed against the report contract.
 *   finalize-specialist-review  assemble the advisory result and, when a runtime signer exists, signed findings for consensus.
 *
 * Nothing in this workflow can PASS or approve: `advisory` is the literal `true`, the report schema has no verdict field, and a
 * provider failure ends the run with an explicit status. There is no fallback to another model or provider. Mastra step
 * retries are not configured, so the manifest's escalation policy is the only retry authority.
 */

const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;

export const specialistReviewInputSchema = z.object({
  specialistId: z.string().regex(PACK_ID),
  repository: z.string().min(1).max(1024).describe('Absolute path of the repository to inspect (read-only). Must lie inside a configured root.'),
  taskId: z.string().regex(IDENT),
  language: z.enum(TASK_LANGUAGES),
  taskType: z.enum(TASK_TYPES),
  objective: z.string().trim().min(1).max(2000),
  focusPaths: z.array(z.string().min(1).max(400)).max(20).default([]),
  reviewId: z.string().regex(IDENT).optional(),
});
export type SpecialistReviewInput = z.input<typeof specialistReviewInputSchema>;

const statusSchema = z.enum(REVIEW_STATUSES);
/** Who ran on what: agent identity, provider and model are three separate facts. No credential is ever part of it. */
const modelBindingSchema = z.object({ agentId: z.string(), role: z.enum(['coding-worker', 'specialist']), providerId: z.string(), modelId: z.string() });
const skillsSchema = z.object({ selected: z.array(z.string()), omitted: z.array(z.object({ id: z.string(), reason: z.string() })), digest: z.string().nullable() });
const usageSchema = z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), totalTokens: z.number().nullable() });
const toolCallsSchema = z.array(z.object({ tool: z.string(), count: z.number() }));

export const specialistReviewResultSchema = z.object({
  status: statusSchema,
  specialistId: z.string(),
  taskId: z.string(),
  reviewId: z.string(),
  manifestVersion: z.string().nullable(),
  manifestDigest: z.string().nullable(),
  /** The agent/provider/model this review ran on; null when it was refused before a model was resolved. */
  model: modelBindingSchema.nullable(),
  reasons: z.array(z.string()),
  report: specialistReportSchema.nullable(),
  skills: skillsSchema,
  toolCalls: toolCallsSchema,
  usage: usageSchema,
  inferenceCalls: z.number(),
  elapsedMs: z.number(),
  /** Always true: a specialist result is input to review, never a decision. */
  advisory: z.literal(true),
  findingStatements: z.array(z.unknown()),
  workflowRunId: z.string(),
});
export type SpecialistReviewResult = z.infer<typeof specialistReviewResultSchema>;

const prepareOutputSchema = z.object({
  ok: z.boolean(),
  reasons: z.array(z.string()),
  specialistId: z.string(),
  taskId: z.string(),
  reviewId: z.string(),
  manifestVersion: z.string().nullable(),
  manifestDigest: z.string().nullable(),
  model: modelBindingSchema.nullable(),
  root: z.string().nullable(),
  prompt: z.string().nullable(),
  skills: skillsSchema,
});

const runOutputSchema = z.object({
  status: statusSchema,
  reasons: z.array(z.string()),
  specialistId: z.string(),
  taskId: z.string(),
  reviewId: z.string(),
  manifestVersion: z.string().nullable(),
  manifestDigest: z.string().nullable(),
  model: modelBindingSchema.nullable(),
  report: specialistReportSchema.nullable(),
  skills: skillsSchema,
  toolCalls: toolCallsSchema,
  usage: usageSchema,
  inferenceCalls: z.number(),
  elapsedMs: z.number(),
});

const stateSchema = z.object({ phase: z.enum(['preparing', 'specialist_running', 'reported', 'refused', 'failed']).optional(), specialistId: z.string().optional(), detail: z.string().optional() });
type WorkflowState = z.infer<typeof stateSchema>;

/** Minimal surface of a Mastra Agent that the workflow uses, so tests can substitute a scripted agent. */
export interface SpecialistAgentLike {
  generate(prompt: string, options: Record<string, unknown>): Promise<{ text?: string; steps?: readonly unknown[]; toolCalls?: readonly unknown[]; toolResults?: readonly unknown[]; usage?: Record<string, unknown> }>;
}

export interface SpecialistReviewDeps {
  /** Pack to run from. Default: loaded on first use from the project root. */
  registry?: PackRegistry;
  /** Repositories a specialist may read must lie inside one of these. Default: AGENTIC_SPECIALIST_ROOTS, else the project root. */
  allowedRoots?: () => readonly string[];
  /** id -> digest of ACTIVE promoted skills. Default: read from the project's durable store; unreadable or empty means no skills. */
  activeSkills?: () => ReadonlyMap<string, string>;
  /** Runtime-held reviewer key per specialist, used to sign findings for consensus. Default: none (no statements). */
  findingSigner?: (manifest: AgentManifest) => FindingSigner | undefined;
  resolveAgent?: (manifest: AgentManifest, ctx: { mastra: unknown }) => SpecialistAgentLike;
  /** Overrides the declared context window of the resolved model (test seam). Default: the model registry's declared value. */
  contextTokens?: () => number | undefined;
  /** Which models specialists may run on. Default: the process's model configuration (src/runtime/models), read per run. */
  modelResolver?: ModelResolver;
  timeoutMs?: number;
}

export function allowedRootsFromEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const configured = (env.AGENTIC_SPECIALIST_ROOTS ?? '').split(delimiter).map((s) => s.trim()).filter(Boolean);
  if (configured.length) return configured;
  const root = findProjectRoot(process.cwd()) ?? findProjectRoot(import.meta.dirname);
  return root ? [root] : [];
}

const emptySkills = { selected: [] as string[], omitted: [] as { id: string; reason: string }[], digest: null as string | null };
const noUsage = { inputTokens: null, outputTokens: null, totalTokens: null } as const;

function countToolCalls(result: Awaited<ReturnType<SpecialistAgentLike['generate']>>): { tool: string; count: number }[] {
  const counts = new Map<string, number>();
  const add = (item: unknown) => {
    const rec = item as { toolName?: unknown; payload?: { toolName?: unknown } } | undefined;
    const name = rec?.toolName ?? rec?.payload?.toolName;
    if (typeof name === 'string') counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const steps = (result.steps ?? []) as readonly { toolCalls?: readonly unknown[] }[];
  if (steps.length) steps.forEach((step) => (step.toolCalls ?? []).forEach(add));
  else (result.toolCalls ?? result.toolResults ?? []).forEach(add);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tool, count]) => ({ tool, count }));
}

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function createSpecialistReviewWorkflow(deps: SpecialistReviewDeps = {}) {
  let cachedRegistry: PackRegistry | undefined = deps.registry;
  const registry = (): PackRegistry => {
    if (cachedRegistry) return cachedRegistry;
    const root = locatePackRoot();
    if (!root) throw new Error('project root not found; engineering pack not loaded');
    return (cachedRegistry = loadPackRegistry(root));
  };

  const publish = async (ctx: { setState: (s: WorkflowState) => Promise<void> }, state: WorkflowState) => {
    try { await ctx.setState(state); } catch { /* Studio visibility must never break a review */ }
  };

  const prepare = createStep({
    id: 'prepare-specialist-review',
    description: 'Validates the request, checks the repository against the configured roots, checks that the specialist fits the task and runs on this harness, selects promoted skills and composes the prompt. Any refusal ends the run before a model is called.',
    inputSchema: specialistReviewInputSchema,
    outputSchema: prepareOutputSchema,
    stateSchema,
    execute: async ({ inputData, setState }) => {
      const reviewId = inputData.reviewId ?? `review-${inputData.taskId}`;
      const base = { specialistId: inputData.specialistId, taskId: inputData.taskId, reviewId, manifestVersion: null as string | null, manifestDigest: null as string | null, model: null as ModelBinding | null, root: null as string | null, prompt: null as string | null, skills: emptySkills };
      const refuse = async (...reasons: string[]) => { await publish({ setState }, { phase: 'refused', specialistId: inputData.specialistId, detail: reasons[0] }); return { ...base, ok: false, reasons }; };
      await publish({ setState }, { phase: 'preparing', specialistId: inputData.specialistId });

      let manifest: AgentManifest | undefined;
      let pack: PackRegistry;
      try { pack = registry(); } catch (err) { return refuse(`pack_unavailable: ${(err as Error).message}`); }
      manifest = pack.agentById.get(inputData.specialistId);
      if (!manifest) return refuse(`unknown_specialist: ${inputData.specialistId}`);
      const identified = { ...base, manifestVersion: manifest.version, manifestDigest: hashValue(manifest) };
      const refuseKnown = async (...reasons: string[]) => { await publish({ setState }, { phase: 'refused', specialistId: inputData.specialistId, detail: reasons[0] }); return { ...identified, ok: false, reasons }; };

      if (!handles(manifest, { language: inputData.language, taskType: inputData.taskType })) return refuseKnown(`out_of_scope: ${manifest.id} does not handle ${inputData.taskType} in ${inputData.language}`);
      // Which model runs this specialist is runtime configuration. A refusal here is final: no other model is tried.
      let resolved: ResolvedModel;
      try {
        resolved = resolveSpecialistModel(manifest, deps.modelResolver ?? modelResolverFromEnv());
      } catch (err) {
        if (err instanceof ModelResolutionError || err instanceof ModelConfigError) return refuseKnown(`model_refused: ${err.message}`);
        throw err;
      }
      // From here on a refusal still names the model that was considered: `model` is null only when none could be resolved.
      const withModel = { ...identified, model: resolved.binding };
      const refuseBound = async (...reasons: string[]) => { await publish({ setState }, { phase: 'refused', specialistId: inputData.specialistId, detail: reasons[0] }); return { ...withModel, ok: false, reasons }; };
      const fit = negotiate(manifest, 'mastra', resolved.binding.providerId, deps.contextTokens ? deps.contextTokens() : resolved.capabilities.contextTokens, { requireKnownContext: true });
      if (!fit.supported) return refuseBound(`unsupported: ${fit.reason}`);
      const repo = await checkRepository(inputData.repository, (deps.allowedRoots ?? allowedRootsFromEnv)());
      if (!repo.ok) return refuseBound(`repository_refused: ${repo.reason}`);

      try {
        const pool = [...manifest.skills, ...manifest.optionalSkills].map((id) => pack.skillById.get(id)!);
        const composed = composeReviewPrompt(manifest, { specialistId: manifest.id, taskId: inputData.taskId, language: inputData.language, taskType: inputData.taskType, objective: inputData.objective, focusPaths: inputData.focusPaths },
          pool, (deps.activeSkills ?? (() => defaultActiveSkills(knowledgeDbPath(join(findProjectRoot() ?? process.cwd(), '.workdir')))))());
        return { ...withModel, ok: true, reasons: [], root: repo.root, prompt: composed.prompt,
          skills: { selected: [...composed.skills.selected], omitted: composed.skills.omitted.map((o) => ({ id: o.id, reason: o.reason })), digest: composed.skills.digest } };
      } catch (err) {
        return refuseBound(`invalid_request: ${(err as Error).message}`);
      }
    },
  });

  const run = createStep({
    id: 'run-specialist',
    description: 'One bounded, read-only agent run. The repository root travels in RequestContext; the model cannot choose it. Provider errors, timeouts and cancellation are explicit statuses; there is no fallback provider.',
    inputSchema: prepareOutputSchema,
    outputSchema: runOutputSchema,
    stateSchema,
    execute: async ({ inputData, setState, mastra, tracingContext, runId, abortSignal }) => {
      const identity = { specialistId: inputData.specialistId, taskId: inputData.taskId, reviewId: inputData.reviewId, manifestVersion: inputData.manifestVersion, manifestDigest: inputData.manifestDigest, model: inputData.model, skills: inputData.skills };
      const ended = (status: ReviewStatus, reasons: string[], extra: Partial<z.infer<typeof runOutputSchema>> = {}) => ({ ...identity, status, reasons, report: null, toolCalls: [], usage: noUsage, inferenceCalls: 0, elapsedMs: 0, ...extra });
      if (!inputData.ok || !inputData.prompt || !inputData.root) return ended('REFUSED', inputData.reasons);

      const manifest = registry().agentById.get(inputData.specialistId)!;
      const started = Date.now();
      await publish({ setState }, { phase: 'specialist_running', specialistId: manifest.id });

      const requestContext = new RequestContext();
      requestContext.set(REPOSITORY_ROOT_CONTEXT_KEY, inputData.root);
      requestContext.set('specialist-id', manifest.id);
      requestContext.set('task-id', inputData.taskId);
      requestContext.set('workflow-run-id', runId);

      const agent: SpecialistAgentLike = deps.resolveAgent
        ? deps.resolveAgent(manifest, { mastra })
        : ((mastra as { getAgent?: (id: string) => unknown } | undefined)?.getAgent?.(specialistRegistryKey(manifest)) as SpecialistAgentLike | undefined) ?? (createMastraSpecialist(manifest, deps.modelResolver ? { resolver: deps.modelResolver } : {}) as unknown as SpecialistAgentLike);
      // A registered agent was constructed with a model at startup. It must be the one this run was authorized and negotiated
      // for; otherwise the run would use a model nobody checked. Test doubles carry no binding and are not checked.
      const bound = bindingOf(agent);
      if (bound && inputData.model && (bound.agentId !== inputData.model.agentId || bound.providerId !== inputData.model.providerId || bound.modelId !== inputData.model.modelId)) {
        await publish({ setState }, { phase: 'refused', specialistId: manifest.id, detail: 'model_binding_mismatch' });
        return ended('REFUSED', [`model_binding_mismatch: the registered agent is bound to ${bound.providerId}/${bound.modelId}, but this run was authorized for ${inputData.model.providerId}/${inputData.model.modelId}`]);
      }

      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), deps.timeoutMs ?? manifest.limits.timeoutMs);
      const signal = abortSignal ? AbortSignal.any([abortSignal, timeout.signal]) : timeout.signal;
      let calls = 0;
      let usage: z.infer<typeof usageSchema> = noUsage;
      const toolTotals = new Map<string, number>();
      let prompt = inputData.prompt;
      const attempts = manifest.escalation.onInvalidOutput === 'retry-once' ? 2 : 1;
      try {
        for (let attempt = 1; attempt <= attempts; attempt++) {
          calls++;
          let result: Awaited<ReturnType<SpecialistAgentLike['generate']>>;
          try {
            result = await agent.generate(prompt, {
              requestContext, maxSteps: manifest.limits.maxSteps, abortSignal: signal, tracingContext,
              tracingOptions: { metadata: { ...(inputData.model ? bindingMetadata(inputData.model) : {}), specialistId: manifest.id, manifestVersion: manifest.version, taskId: inputData.taskId, reviewId: inputData.reviewId, workflowRunId: runId, attempt }, tags: ['specialist-review', manifest.id] },
            });
          } catch (err) {
            const status: ReviewStatus = abortSignal?.aborted ? 'CANCELED' : timeout.signal.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR';
            await publish({ setState }, { phase: 'failed', specialistId: manifest.id, detail: status });
            return ended(status, [`${status.toLowerCase()}: ${String((err as Error)?.message ?? err).slice(0, 300)}`], { inferenceCalls: calls, usage, toolCalls: [...toolTotals].map(([tool, count]) => ({ tool, count })), elapsedMs: Date.now() - started });
          }
          // One generate() can make several model calls (one per step); cost accounting counts model calls, not invocations.
          calls += Math.max(0, (result.steps?.length ?? 1) - 1);
          for (const { tool, count } of countToolCalls(result)) toolTotals.set(tool, (toolTotals.get(tool) ?? 0) + count);
          // Mastra can return normally after an abort with whatever text it had; an aborted run is never a report.
          if (signal.aborted) {
            const status: ReviewStatus = abortSignal?.aborted ? 'CANCELED' : 'TIMEOUT';
            await publish({ setState }, { phase: 'failed', specialistId: manifest.id, detail: status });
            return ended(status, [`${status.toLowerCase()}: the run was aborted before a complete reply`], { inferenceCalls: calls, usage, toolCalls: [...toolTotals].map(([tool, count]) => ({ tool, count })), elapsedMs: Date.now() - started });
          }
          usage = {
            inputTokens: sumNullable(usage.inputTokens, numberOrNull(result.usage?.inputTokens ?? result.usage?.promptTokens)),
            outputTokens: sumNullable(usage.outputTokens, numberOrNull(result.usage?.outputTokens ?? result.usage?.completionTokens)),
            totalTokens: sumNullable(usage.totalTokens, numberOrNull(result.usage?.totalTokens)),
          };
          const parsed = parseSpecialistReport(result.text, manifest);
          const toolCalls = [...toolTotals].map(([tool, count]) => ({ tool, count })).sort((a, b) => a.tool.localeCompare(b.tool));
          if (parsed.ok) {
            await publish({ setState }, { phase: 'reported', specialistId: manifest.id, detail: parsed.report.status });
            return { ...ended('REPORTED', []), report: parsed.report, toolCalls, usage, inferenceCalls: calls, elapsedMs: Date.now() - started };
          }
          if (attempt === attempts) {
            await publish({ setState }, { phase: 'failed', specialistId: manifest.id, detail: 'invalid output' });
            return ended('INVALID_OUTPUT', [`invalid_output: ${parsed.reason}`], { toolCalls, usage, inferenceCalls: calls, elapsedMs: Date.now() - started });
          }
          prompt = `${inputData.prompt}\n\nYour previous reply was rejected (${parsed.reason}). Reply with the JSON report only.`;
        }
        return ended('INVALID_OUTPUT', ['invalid_output: no attempt produced a report']);
      } finally {
        clearTimeout(timer);
      }
    },
  });

  const finalize = createStep({
    id: 'finalize-specialist-review',
    description: 'Assembles the advisory result. When a runtime reviewer key is configured, findings are signed by the runtime for review consensus; the specialist itself never signs and never verifies.',
    inputSchema: runOutputSchema,
    outputSchema: specialistReviewResultSchema,
    stateSchema,
    execute: async ({ inputData, runId }) => {
      const manifest = registry().agentById.get(inputData.specialistId);
      const statements = manifest && inputData.report && inputData.status === 'REPORTED'
        ? buildFindingStatements(manifest, inputData.report, inputData.reviewId, deps.findingSigner?.(manifest))
        : [];
      return { ...inputData, advisory: true as const, findingStatements: [...statements], workflowRunId: runId };
    },
  });

  return createWorkflow({
    id: 'specialist-review-workflow',
    description: 'Runs one read-only specialist (see engineering/agents) against a repository inside the configured roots and returns an advisory, schema-validated report plus runtime-signed findings for review consensus. Cannot pass, approve or modify anything.',
    inputSchema: specialistReviewInputSchema,
    outputSchema: specialistReviewResultSchema,
    stateSchema,
    options: { validateInputs: true },
  })
    .then(prepare)
    .then(run)
    .then(finalize)
    .commit();
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (b === null) return a;
  return (a ?? 0) + b;
}

export const specialistReviewWorkflow = createSpecialistReviewWorkflow();

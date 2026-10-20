import { createStep, createWorkflow } from '@mastra/core/workflows';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { findProjectRoot } from '../../../core/paths.ts';
import type { MeetingRecord } from '../../../runtime/collaboration/record.ts';
import { renderMeetingRecord } from '../../../lead/collaboration/record-markdown.ts';
import { loadPackRegistry, type PackRegistry } from '../../../runtime/knowledge/packs/loader.ts';
import type { ProviderReadiness } from '../../../runtime/knowledge/engineering-control.ts';
import { COUNCIL_LIMITS } from '../../../runtime/council/contract.ts';
import { conveneCouncil, loadSidecar, noteWorkflowRun, prepareCouncil, recordCouncil, type CouncilDeps } from '../../../runtime/council/run.ts';
import type { SpecialistInvoker } from '../../../runtime/council/participant.ts';
import { allowedRootsFromEnv } from '../workflows/specialist-review-workflow.ts';
import { DEFAULT_SEATS } from '../../../runtime/council/panel.ts';
import { locatePackRoot } from '../specialist-agents.ts';
import { createMastraInvoker, type CouncilAgentLike } from './invoker.ts';
import { resolveLiveRoster } from './live-roster.ts';
import { createScriptedCouncilAgents, scriptedAgentKey, SCRIPTED_QUESTION } from './scripted.ts';

/**
 * engineering-council-workflow: three read-only Mastra specialists meet once, in three bounded rounds, and leave a durable record.
 *
 *   prepare-council   preflight and open the meeting. Every refusal (pack, panel, model, repository, question) ends here with
 *                     ZERO model calls.
 *   convene-council   the existing MeetingCoordinator drives the turns; each turn is one bounded call to a registered Mastra
 *                     agent. Agent and tool spans nest under this step in Studio.
 *   record-council    derive the record from the durable events and the call journal and write it next to the meeting.
 *
 * Nothing here retries a step, decides, approves or writes to a repository. The proposed decision has no authority.
 */

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const councilInputSchema = z.object({
  meetingId: z.string().regex(IDENT).optional().describe('Re-using the id of an OPEN meeting resumes it; of a closed one returns its record without any model call.'),
  mode: z.enum(['scripted', 'live']).default('scripted').describe('scripted: offline, canned, free. live: the local Ollama model; needs AGENTIC_COUNCIL_LIVE=1 on the process running it.'),
  question: z.string().max(COUNCIL_LIMITS.maxQuestionChars).optional().describe('The design question. Defaults to the built-in example.'),
  focusPaths: z.array(z.string().max(300)).max(10).optional(),
  repository: z.string().max(1024).optional().describe('Absolute path the specialists may read. Must lie inside AGENTIC_SPECIALIST_ROOTS (default: this project).'),
  limits: z.object({ maxInvocations: z.number().int().min(3).max(30).optional(), maxTokens: z.number().int().min(1).max(2_000_000).optional(), maxModelCallsPerSeat: z.number().int().min(1).max(8).optional(), maxTokensPerSeat: z.number().int().min(1).max(500_000).optional(), callTimeoutMs: z.number().int().min(1_000).max(1_800_000).optional(), turnTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional() }).optional(),
});
export type CouncilWorkflowInput = z.input<typeof councilInputSchema>;

const prepared = z.object({ status: z.enum(['ready', 'concluded', 'refused']), meetingId: z.string(), mode: z.enum(['SCRIPTED', 'LIVE']), resumed: z.boolean(), reasons: z.array(z.string()) });
const convened = z.object({ status: z.enum(['concluded', 'cancelled', 'suspended', 'superseded', 'skipped']), meetingId: z.string(), mode: z.enum(['SCRIPTED', 'LIVE']), reasons: z.array(z.string()), detail: z.string().nullable() });

export const councilResultSchema = z.object({
  /** recorded: a closed meeting with a record. refused: nothing started, no model call. suspended/superseded: the meeting is open and resumable. */
  status: z.enum(['recorded', 'refused', 'suspended', 'superseded']),
  meetingId: z.string(),
  mode: z.enum(['SCRIPTED', 'LIVE']),
  outcome: z.string().nullable(),
  reasons: z.array(z.string()),
  panel: z.array(z.object({ specialistId: z.string(), chair: z.boolean(), provider: z.string(), model: z.string() })),
  proposedDecision: z.string().nullable(),
  disagreementRaised: z.boolean().nullable(),
  accounting: z.object({ turnsReserved: z.number(), modelCalls: z.number(), reasks: z.number(), invalidReplies: z.number() }).nullable(),
  recordDir: z.string().nullable(),
  recordHash: z.string().nullable(),
  /** The literal 'pending': nothing was adopted. */
  humanApproval: z.literal('pending'),
  advisory: z.literal(true),
  workflowRunId: z.string(),
});
export type CouncilWorkflowResult = z.infer<typeof councilResultSchema>;

export interface CouncilWorkflowDeps {
  workdir?: string;
  registry?: PackRegistry;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  allowedRoots?: () => readonly string[];
  probe?: () => Promise<ProviderReadiness>;
  /** Tests: replace how a seat is run. Default: the registered Mastra agent through the read-only invoker. */
  invokerFor?: (ctx: { mode: 'SCRIPTED' | 'LIVE'; repositoryRoot: string; workflowRunId: string; mastra: unknown; tracingContext: unknown }) => SpecialistInvoker;
  log?: (line: string) => void;
}

export function createEngineeringCouncilWorkflow(deps: CouncilWorkflowDeps = {}) {
  let registry = deps.registry;
  const getRegistry = (): PackRegistry => {
    if (registry) return registry;
    const root = locatePackRoot();
    if (!root) throw new Error('project root not found; engineering pack not loaded');
    return (registry = loadPackRegistry(root));
  };
  const projectRoot = (): string => {
    const root = findProjectRoot(process.cwd()) ?? findProjectRoot(import.meta.dirname);
    if (!root) throw new Error('project root not found');
    return root;
  };
  const councilDeps = (): CouncilDeps => ({
    workdir: deps.workdir ?? join(projectRoot(), '.workdir'), registry: getRegistry(), env: deps.env, now: deps.now,
    allowedRoots: deps.allowedRoots ?? (() => allowedRootsFromEnv(deps.env)), probe: deps.probe, log: deps.log,
  });
  const modeOf = (m: 'scripted' | 'live') => (m === 'live' ? 'LIVE' : 'SCRIPTED') as 'LIVE' | 'SCRIPTED';

  const prepare = createStep({
    id: 'prepare-council',
    description: 'Preflight (pack, exactly 3 role-distinct read-only specialists, model readiness, repository inside the configured roots, question) and open the meeting. Any refusal ends the run before a model is called.',
    inputSchema: councilInputSchema,
    outputSchema: prepared,
    execute: async ({ inputData, runId, mastra }) => {
      const meetingId = inputData.meetingId ?? `council-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${inputData.mode}`;
      const mode = modeOf(inputData.mode);
      try {
        const d = councilDeps();
        // LIVE runs on the registered roster only. Checked before the meeting exists, so a refusal leaves no state behind.
        if (mode === 'LIVE' && !deps.invokerFor) {
          const seatIds = (loadSidecar(d.workdir, meetingId)?.panel ?? DEFAULT_SEATS).map((s) => s.specialistId);
          const roster = resolveLiveRoster(agentLookup(mastra), d.registry, seatIds, d.env);
          if (!roster.ok) return { status: 'refused' as const, meetingId, mode, resumed: false, reasons: [...roster.reasons] };
        }
        const useExample = !inputData.question;
        const result = await prepareCouncil(d, {
          meetingId, mode, question: inputData.question ?? SCRIPTED_QUESTION.question, focusPaths: inputData.focusPaths ?? (useExample ? [...SCRIPTED_QUESTION.focusPaths] : []),
          repository: inputData.repository ?? projectRoot(), limits: inputData.limits as never,
        });
        if (result.status === 'refused') return { status: 'refused' as const, meetingId, mode, resumed: false, reasons: [...result.reasons] };
        noteWorkflowRun(d, meetingId, runId);
        return { status: result.status, meetingId, mode, resumed: result.status === 'ready' ? result.resumed : false, reasons: [] };
      } catch (err) {
        return { status: 'refused' as const, meetingId, mode, resumed: false, reasons: [`preflight_error: ${String((err as Error)?.message ?? err).slice(0, 300)}`] };
      }
    },
  });

  const convene = createStep({
    id: 'convene-council',
    description: 'Runs the meeting on the existing MeetingCoordinator: round 1 blind proposals, round 2 critique, round 3 chair synthesis. One bounded read-only specialist call per turn; the meeting, not this step, is durable.',
    inputSchema: prepared,
    outputSchema: convened,
    execute: async ({ inputData, mastra, tracingContext, runId, abortSignal }) => {
      const skip = (reasons: string[], detail: string | null = null) => ({ status: 'skipped' as const, meetingId: inputData.meetingId, mode: inputData.mode, reasons, detail });
      if (inputData.status === 'refused') return skip(inputData.reasons);
      if (inputData.status === 'concluded') return skip([], 'the meeting was already closed; its record is returned without any model call');
      const d = councilDeps();
      const sidecar = loadSidecar(d.workdir, inputData.meetingId);
      if (!sidecar) return skip(['sidecar_missing: the meeting was prepared but its sidecar is gone']);

      const invoker: SpecialistInvoker = deps.invokerFor
        ? deps.invokerFor({ mode: inputData.mode, repositoryRoot: sidecar.repository, workflowRunId: runId, mastra, tracingContext })
        : createMastraInvoker({
            repositoryRoot: sidecar.repository, workflowRunId: runId, tracingContext,
            resolveAgent: (specialistId) => {
              if (inputData.mode === 'SCRIPTED') {
                // Offline seam: a canned model, never a provider. The record says SCRIPTED.
                const registered = tryGet(mastra, scriptedAgentKey(specialistId));
                return (registered ?? Object.values(createScriptedCouncilAgents(d.registry, [specialistId]))[0]) as unknown as CouncilAgentLike;
              }
              // Re-checked per call: the registered, locally bound agent or a failed call. Never a newly constructed agent.
              const roster = resolveLiveRoster(agentLookup(mastra), d.registry, [specialistId], d.env);
              if (!roster.ok) throw new Error(roster.reasons.join('; '));
              return roster.agents.get(specialistId)!;
            },
          });
      const result = await conveneCouncil(d, sidecar, { invoker, signal: abortSignal, owner: `council-workflow:${runId}` });
      if (result.status === 'concluded') return { status: 'concluded' as const, meetingId: inputData.meetingId, mode: inputData.mode, reasons: [], detail: result.outcome };
      if (result.status === 'cancelled') return { status: 'cancelled' as const, meetingId: inputData.meetingId, mode: inputData.mode, reasons: [], detail: null };
      return { status: result.status, meetingId: inputData.meetingId, mode: inputData.mode, reasons: [], detail: result.status === 'suspended' ? result.reason : result.detail };
    },
  });

  const record = createStep({
    id: 'record-council',
    description: 'Derives the record from the hash-chained events and the call journal (no model writes any field) and persists record.json and record.md. Specialists stay advisory; the proposed decision has no authority.',
    inputSchema: convened,
    outputSchema: councilResultSchema,
    execute: async ({ inputData, runId }) => {
      const base = { meetingId: inputData.meetingId, mode: inputData.mode, humanApproval: 'pending' as const, advisory: true as const, workflowRunId: runId, panel: [] as CouncilWorkflowResult['panel'], proposedDecision: null, disagreementRaised: null, accounting: null, recordDir: null, recordHash: null };
      if (inputData.status === 'skipped' && inputData.reasons.length) return { ...base, status: 'refused' as const, outcome: null, reasons: inputData.reasons };
      if (inputData.status === 'suspended' || inputData.status === 'superseded') return { ...base, status: inputData.status, outcome: null, reasons: [inputData.detail ?? inputData.status] };
      const d = councilDeps();
      const sidecar = loadSidecar(d.workdir, inputData.meetingId);
      const rec = sidecar ? recordCouncil(d, sidecar) : null;
      if (!sidecar || !rec) return { ...base, status: 'refused' as const, outcome: null, reasons: ['record_unavailable: the meeting has no closed session to record'] };
      // The M9/M10 renderer is the one source for the generic meeting view (turn log, objections, usage); the council record adds only
      // what the engine does not know: structured positions, verified evidence, call accounting.
      const dir = join(d.workdir, 'council', rec.meetingId);
      writeFileSync(join(dir, 'meeting-record.md'), renderMeetingRecord(JSON.parse(readFileSync(join(dir, 'meeting-record.json'), 'utf8')) as MeetingRecord));
      const synth = rec.synthesis?.synthesis as { decision?: string } | undefined;
      return {
        ...base, status: 'recorded' as const, outcome: rec.outcome, reasons: [rec.reason],
        panel: rec.panel.map((p) => ({ specialistId: p.specialistId, chair: p.chair, provider: p.provider, model: p.model })),
        proposedDecision: synth?.decision ?? null, disagreementRaised: rec.disagreements.raised,
        accounting: { turnsReserved: rec.accounting.turnsReserved, modelCalls: rec.accounting.modelCalls, reasks: rec.accounting.reasks, invalidReplies: rec.accounting.invalidReplies },
        recordDir: join(d.workdir, 'council', rec.meetingId), recordHash: rec.integrity.recordHash,
      };
    },
  });

  return createWorkflow({
    id: 'engineering-council-workflow',
    description: 'A three-specialist engineering council: independent proposals, a bounded critique round, and a chair synthesis, recorded durably. Read-only and advisory; a human adopts or rejects the proposed decision. SCRIPTED (offline) or LIVE (local Ollama, opt-in).',
    inputSchema: councilInputSchema,
    outputSchema: councilResultSchema,
    options: { validateInputs: true },
  })
    .then(prepare)
    .then(convene)
    .then(record)
    .commit();
}

function tryGet(mastra: unknown, key: string): unknown {
  try { return (mastra as { getAgent?: (key: string) => unknown } | undefined)?.getAgent?.(key); } catch { return undefined; }
}

const agentLookup = (mastra: unknown) => (key: string): unknown => tryGet(mastra, key);

export const engineeringCouncilWorkflow = createEngineeringCouncilWorkflow();

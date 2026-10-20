/**
 * SCRIPTED council mode: deterministic, offline, free. A Mastra Agent per seat whose language model is a script instead of a
 * network call. It exists so the whole council path (workflow, agents, read-only tools, traces, store, record) can be run and
 * tested without a model. It does NOT show what any model would say, and every record it produces is labelled SCRIPTED with the
 * provider `scripted`.
 *
 * The script is keyed on the phase and seat the prompt names (prompts.ts), not on call order, so a re-ask or a resumed meeting
 * gets the same answer. The scripted disagreement is a deliberate fixture: the Architect and the Security Reviewer disagree about
 * whether Mastra may re-ask a read-only specialist at all.
 */
import { Agent } from '@mastra/core/agent';
import type { PackRegistry } from '../../../runtime/knowledge/packs/loader.ts';
import { renderAgentInstructions } from '../../../runtime/knowledge/packs/agents.ts';
import { assertReadOnlyToolTable, SPECIALIST_TOOL_TABLE } from '../specialist-agents.ts';
import { COUNCIL_LIMITS } from '../../../runtime/council/contract.ts';

export const SCRIPTED_QUESTION = {
  id: 'specialist-retry-ownership',
  question: 'Should the Mastra specialist workflow be allowed to re-ask a read-only specialist once when its reply is malformed, or should every retry belong to the durable scheduler?',
  focusPaths: ['docs/engineering/adr-agent-model-role-boundaries.md', 'src/integrations/mastra/workflows/specialist-review-workflow.ts', 'src/runtime/collaboration/coordinator.ts'],
} as const;

const ADR = 'docs/engineering/adr-agent-model-role-boundaries.md';
const WORKFLOW = 'src/integrations/mastra/workflows/specialist-review-workflow.ts';
const AGENTS = 'src/integrations/mastra/specialist-agents.ts';
const COORD = 'src/runtime/collaboration/coordinator.ts';

type Phase = 'proposal' | 'critique' | 'synthesis';
interface Seen { phase: Phase; seat: string; hasToolResult: boolean; /** The members the prompt offers as targets (critique) or candidates (synthesis). */ members: string[] }

function read(prompt: unknown[]): Seen {
  const messages = prompt as { role: string; content: unknown }[];
  const flat = (m: { content: unknown }) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  const user = messages.filter((m) => m.role === 'user').map(flat).join('\n');
  const head = /COUNCIL \S+ \| PHASE: (proposal|critique|synthesis) \| SEAT: ([a-z-]+)/.exec(user);
  if (!head) throw new Error('scripted council model: the prompt does not name a phase and seat');
  // The prompt names the allowed members: `targetMember must be one of: a, b.` / `adoptedFrom must be one of: a, b, c)`.
  const offered = /(?:targetMember must be one of|adoptedFrom must be one of): ([a-z, -]+)[.)]/.exec(user);
  const members = offered ? offered[1]!.split(',').map((x) => x.trim()).filter(Boolean) : [];
  return { phase: head[1] as Phase, seat: head[2]!, hasToolResult: messages.some((m) => m.role === 'tool'), members };
}

const PROPOSAL: Record<string, { read: string; body: Record<string, unknown> }> = {
  architect: {
    read: ADR,
    body: {
      position: 'Keep ONE manifest-bounded re-ask for read-only specialists inside the Mastra workflow; everything that can mutate stays with the scheduler and the coding runner.',
      rationale: 'The specialist workflow re-asks only when the manifest declares retry-once, at most one extra call, and a specialist has no write tool. Moving that single re-ask into the scheduler would add a lease cycle for a side-effect-free call and create a second place that counts attempts.',
      risks: [{ risk: 'A second retry authority could drift from the scheduler\'s budget.', mitigation: 'Keep the bound in the manifest and test it; do not add Mastra step retries.' }],
      evidence: [ADR, WORKFLOW],
      unknowns: ['Whether the manifest bound should also be persisted across restarts.'],
    },
  },
  'security-reviewer': {
    read: AGENTS,
    body: {
      position: 'Allow no retry inside Mastra: a malformed reply fails the review, and the scheduler alone decides whether to ask again.',
      rationale: 'A retry loop outside the scheduler is control flow the scheduler cannot see or cancel. Even for read-only specialists, a re-ask re-sends repository-derived prompt text to the model, and an attempt budget that lives in two places is the kind of rule that exists only by convention.',
      risks: [{ risk: 'Prompt text is re-sent to the model on every re-ask.', mitigation: 'Count every re-ask against the same durable budget.' }],
      evidence: [AGENTS, WORKFLOW],
      unknowns: ['Whether re-sent prompts can leak anything beyond the first call.'],
    },
  },
  'reliability-reviewer': {
    read: COORD,
    body: {
      position: 'Allow the bounded re-ask only if its count is recorded durably, so a restart cannot grant a second budget.',
      rationale: 'The meeting coordinator already charges every reserved turn against a durable invocation budget and resumes after a crash; an in-process re-ask counter does not survive that restart, so the re-ask needs a durable record to stay bounded.',
      risks: [{ risk: 'After a crash an in-memory re-ask counter resets and the specialist is asked again.', mitigation: 'Write each model call to an append-only journal and count the budget from it.' }],
      evidence: [COORD, WORKFLOW],
      unknowns: ['Whether a persisted per-claim attempt budget is worth a schema migration now.'],
    },
  },
};

function critique(seat: string, members: string[]): Record<string, unknown> {
  const of = (who: string) => members.find((m) => m.includes(who)) ?? members[0]!;
  if (seat === 'architect') return {
    stance: 'object', targetMember: of('security'),
    critique: 'Forbidding the re-ask turns one malformed JSON reply into a failed review and pushes a side-effect-free call through a lease cycle. The workflow\'s loop is already capped by the manifest at two attempts, so the claim that it is control flow nobody can see overstates it.',
    evidence: [WORKFLOW], concessions: ['The re-ask does re-send prompt text; it should be counted.'],
  };
  if (seat === 'security-reviewer') return {
    stance: 'object', targetMember: of('architect'),
    critique: 'The bound lives in a manifest field and an in-process loop. Nothing in the workflow persists the count, so a restart can grant the specialist another attempt; "bounded" is only true within one process.',
    evidence: [WORKFLOW, AGENTS], concessions: [],
  };
  return {
    stance: 'support', targetMember: of('architect'),
    critique: 'Checked the workflow: the loop is capped at two attempts and a specialist has no write tool, so the re-ask cannot repeat a side effect. My remaining concern, a durable count, is compatible with this position.',
    evidence: [WORKFLOW], concessions: ['The in-process counter does not survive a restart; that is the open point.'],
  };
}

function synthesis(members: string[]): Record<string, unknown> {
  return {
    outcome: 'accept', adoptedFrom: members.find((m) => m.includes('architect')) ?? members[0]!,
    decision: 'Keep the single manifest-bounded re-ask for read-only specialists in the Mastra workflow, add no Mastra step retries, and record every model call in an append-only journal so the budget survives a restart.',
    rationale: 'It removes no safety property, because a specialist cannot mutate anything, and avoids a second lease cycle. The Security Reviewer\'s and the Reliability Reviewer\'s shared point is accepted: the count must not live only in memory.',
    disagreements: [
      { between: ['Architect', 'Security Reviewer'], issue: 'Whether Mastra may re-ask a read-only specialist at all', status: 'unresolved', note: 'The Security Reviewer\'s objection was not withdrawn; the proposal is adopted over it.' },
      { between: ['Security Reviewer', 'Reliability Reviewer'], issue: 'Whether a durable count is sufficient to make the re-ask acceptable', status: 'accepted-tradeoff' },
    ],
    uncertainties: ['Whether a persisted per-claim attempt budget is worth a schema migration.', 'Whether a re-sent prompt can expose anything the first call did not.'],
    actionItems: ['Decide whether to adopt this as an ADR amendment.', 'Decide whether the persisted attempt budget deserves its own migration.'],
  };
}

export function scriptedCouncilModel() {
  const json = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 }, warnings: [] });
  let calls = 0;
  const model = {
    specificationVersion: 'v2', provider: 'scripted', modelId: 'scripted-council-1', supportedUrls: {},
    async doGenerate(options: { prompt: unknown[]; abortSignal?: AbortSignal }) {
      calls += 1;
      if (options.abortSignal?.aborted) throw new Error('aborted');
      const seen = read(options.prompt);
      if (seen.phase === 'proposal') {
        const script = PROPOSAL[seen.seat];
        if (!script) throw new Error(`scripted council model has no script for seat ${seen.seat}`);
        // Read one real file first, so offline runs exercise the read-only tool path and its spans.
        if (!seen.hasToolResult) return { content: [{ type: 'tool-call', toolCallId: `read-${seen.seat}`, toolName: 'readFile', input: JSON.stringify({ path: script.read }) }], finishReason: 'tool-calls', usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, warnings: [] };
        return json(script.body);
      }
      if (seen.phase === 'critique') return json(critique(seen.seat, seen.members));
      return json(synthesis(seen.members));
    },
    async doStream() { throw new Error('streaming is not scripted'); },
  };
  return { model: model as never, calls: () => calls };
}

export const scriptedAgentKey = (specialistId: string): string => `council_scripted_${specialistId.replaceAll('-', '_')}`;

/** Same read-only tool table as the live specialists (a manifest names tools, it cannot create one); only the model differs. */
export function createScriptedCouncilAgents(registry: PackRegistry, ids: readonly string[]): Record<string, Agent> {
  assertReadOnlyToolTable();
  const agents: Record<string, Agent> = {};
  for (const id of ids) {
    const manifest = registry.agentById.get(id);
    if (!manifest) continue;
    const tools: Record<string, (typeof SPECIALIST_TOOL_TABLE)[keyof typeof SPECIALIST_TOOL_TABLE]> = {};
    for (const t of manifest.tools) {
      if (!Object.hasOwn(SPECIALIST_TOOL_TABLE, t)) throw new Error(`scripted council agent ${id} requests tool ${t} that is not in the read-only table`);
      tools[t] = SPECIALIST_TOOL_TABLE[t as keyof typeof SPECIALIST_TOOL_TABLE];
    }
    agents[scriptedAgentKey(id)] = new Agent({ id: `council-scripted-${id}`, name: `${manifest.name} (scripted)`, description: `SCRIPTED stand-in for ${manifest.id}; no model is called`, instructions: renderAgentInstructions(manifest), model: scriptedCouncilModel().model, tools, defaultOptions: { maxSteps: COUNCIL_LIMITS.maxSteps } });
  }
  return agents;
}

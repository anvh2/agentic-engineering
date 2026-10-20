import { registerApiRoute } from '@mastra/core/server';
import type { Agent } from '@mastra/core/agent';
import { DEFAULT_SEATS } from '../../../runtime/council/panel.ts';
import type { SpecialistRegistration } from '../specialist-agents.ts';
import { engineeringCouncilWorkflow } from './council-workflow.ts';
import { councilReadiness } from './readiness.ts';
import { createScriptedCouncilAgents } from './scripted.ts';

/**
 * What the Mastra instance registers for the council. One import in index.ts; everything else lives in this folder.
 * Registration makes no model call and touches no repository.
 */
export function councilRegistration(specialists: SpecialistRegistration): { agents: Record<string, Agent>; workflow: typeof engineeringCouncilWorkflow } {
  const agents = specialists.registry ? createScriptedCouncilAgents(specialists.registry, DEFAULT_SEATS.map((s) => s.specialistId)) : {};
  return { agents, workflow: engineeringCouncilWorkflow };
}

function liveText(live: { ready: boolean; reasons: readonly string[] }): string {
  if (live.ready) return 'ready';
  // At startup the model is deliberately not probed (no network): that alone is "pending", not "not ready".
  const blocking = live.reasons.filter((r) => !r.startsWith('model_not_checked'));
  return blocking.length ? `not ready (${blocking.join('; ')})` : 'enabled, model not probed at startup (npm run council -- status --probe)';
}

/** One line at server start: are the specialists registered, can a council convene, and why not. No network is contacted. */
export async function councilStartupLine(specialists: SpecialistRegistration, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const r = await councilReadiness({ specialists, env });
  const panel = r.panel.ok ? r.panel.seats.map((s) => s.specialistId + (s.chair ? '*' : '')).join(', ') : `REFUSED (${r.panel.reasons.join('; ')})`;
  return `[council] ${r.mastra.registered} specialist agents registered; panel ${panel}; scripted ${r.scripted.ready ? 'ready' : `NOT ready (${r.scripted.reasons.join('; ')})`}; live ${liveText(r.live)}`;
}

/** GET /council/v1/status[?probe=1]: the readiness report as JSON. Read-only; `probe` contacts a loopback Ollama only. */
export function createCouncilStatusRoute(specialists: SpecialistRegistration) {
  return registerApiRoute('/council/v1/status', {
    method: 'GET',
    requiresPermission: 'observability:read',
    handler: async (c) => {
      try {
        return c.json(await councilReadiness({ specialists, probe: c.req.query('probe') === '1' }), 200, { 'Cache-Control': 'no-store' });
      } catch {
        return c.json({ error: 'council status unavailable' }, 500);
      }
    },
  });
}

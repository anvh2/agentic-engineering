import { z } from 'zod';

// PRESENTATION DTO of the Gateway's /agents (src/integrations/control-center/agents-adapter.ts): the agents this Mastra process
// registered, read from the registration objects, with the resolver's model binding.
const status = z.enum(['registered', 'refused', 'unavailable']);
export const rosterSchema = z.object({
  source: z.enum(['mastra-registration', 'unavailable']),
  agents: z.array(z.object({
    registryKey: z.string().nullable(), agentId: z.string(), name: z.string(),
    kind: z.enum(['coding-worker', 'specialist', 'council-scripted']), status,
    model: z.string().nullable(), modelPinned: z.boolean().nullable(), reason: z.string().nullable(), tools: z.array(z.string()),
  })),
  counts: z.object({ registered: z.number(), refused: z.number(), unavailable: z.number() }),
  error: z.string().nullable(),
});
export type Roster = z.infer<typeof rosterSchema>;

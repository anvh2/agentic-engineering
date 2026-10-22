import { registerApiRoute } from '@mastra/core/server';
import { join, resolve } from 'node:path';
import { findProjectRoot } from '../../core/paths.ts';
import { resolveSchedulerDbPath } from '../../observability/scheduler-state.ts';
import { createReader } from './adapter.ts';
import { createCollaborationReader } from './collaboration-adapter.ts';
import { createControlCenterApp } from './http-app.ts';
import { agentRoster, type RosterInput } from './agents-adapter.ts';
import { createCouncilReader } from './council-adapter.ts';

/** Opt-in same-origin serving on the existing Mastra server, never a second listener. */
export function createControlCenterRoutes(registration?: RosterInput) {
  if (process.env.CONTROL_CENTER_ENABLED !== '1') return [];
  const dbPath = resolveSchedulerDbPath();
  const studioOrigin = process.env.CONTROL_CENTER_STUDIO_ORIGIN ?? 'http://localhost:4111';
  // Where the council workflow writes (council-workflow.ts: <project root>/.workdir), unless pointed at another checkout's records.
  const root = findProjectRoot(process.cwd()) ?? findProjectRoot(import.meta.dirname);
  const councilWorkdir = process.env.CONTROL_CENTER_COUNCIL_WORKDIR ?? (root ? join(root, '.workdir') : undefined);
  const app = createControlCenterApp({
    embedded: true,
    assetsDir: resolve(process.env.CONTROL_CENTER_ASSETS_DIR ?? 'apps/control-center/dist'),
    reader: createReader({ dbPath, capacityDbPath: process.env.CONTROL_CENTER_CAPACITY_DB, studioOrigin }),
    // Core B's collab_events live in the same scheduler database; read only, never a second store.
    collaboration: createCollaborationReader({ dbPath, schedulerOfRecord: true }),
    // The council's meetings are Core B meetings in their own database: read with the same verified reader, never merged.
    ...(councilWorkdir ? { council: createCouncilReader({ workdir: resolve(councilWorkdir), studioOrigin }) } : {}),
    ...(registration ? { agents: () => agentRoster(registration) } : {}),
  });
  return ['/control-center/v1/*', '/organization-app/*'].map(path => registerApiRoute(path, {
    method: 'ALL',
    requiresPermission: 'observability:read',
    cors: { origin: () => undefined, allowMethods: ['GET'] },
    // Keep Mastra's normal authentication middleware; this route never bypasses it.
    handler: c => app.fetch(c.req.raw),
  }));
}

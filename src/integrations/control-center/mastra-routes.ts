import { registerApiRoute } from '@mastra/core/server';
import { resolve } from 'node:path';
import { resolveSchedulerDbPath } from '../../observability/scheduler-state.ts';
import { createReader } from './adapter.ts';
import { createControlCenterApp } from './http-app.ts';

/** Opt-in same-origin serving on the existing Mastra server, never a second listener. */
export function createControlCenterRoutes() {
  if (process.env.CONTROL_CENTER_ENABLED !== '1') return [];
  const app = createControlCenterApp({
    embedded: true,
    assetsDir: resolve(process.env.CONTROL_CENTER_ASSETS_DIR ?? 'apps/control-center/dist'),
    reader: createReader({ dbPath: resolveSchedulerDbPath(), capacityDbPath: process.env.CONTROL_CENTER_CAPACITY_DB,
      studioOrigin: process.env.CONTROL_CENTER_STUDIO_ORIGIN ?? 'http://localhost:4111' }),
  });
  return ['/control-center/v1/*', '/organization-app/*'].map(path => registerApiRoute(path, {
    method: 'ALL',
    requiresPermission: 'observability:read',
    cors: { origin: () => undefined, allowMethods: ['GET'] },
    // Keep Mastra's normal authentication middleware; this route never bypasses it.
    handler: c => app.fetch(c.req.raw),
  }));
}

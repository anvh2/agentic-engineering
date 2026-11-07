import { fileURLToPath } from 'node:url';
import { resolveSchedulerDbPath } from '../../observability/scheduler-state.ts';
import { createReader } from './adapter.ts';
import { createCollaborationReader } from './collaboration-adapter.ts';
import { createSuggestionReader } from './suggestions-adapter.ts';
import { createGateway } from './server.ts';

const port = Number(process.env.CONTROL_CENTER_PORT ?? '4310');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('CONTROL_CENTER_PORT must be an integer between 1024 and 65535');
const dbPath = resolveSchedulerDbPath();
const reader = createReader({
  dbPath,
  capacityDbPath: process.env.CONTROL_CENTER_CAPACITY_DB,
  studioOrigin: process.env.CONTROL_CENTER_STUDIO_ORIGIN ?? 'http://localhost:4111',
});
const gateway = createGateway({ reader, collaboration: createCollaborationReader({ dbPath, schedulerOfRecord: true }), suggestions: createSuggestionReader({ dbPath }), assetsDir: fileURLToPath(new URL('../../../apps/control-center/dist/', import.meta.url)) });
gateway.server.listen(port, '127.0.0.1', () => console.log(`Read-only Control Center: http://127.0.0.1:${port}`));
gateway.server.on('error', () => {
  console.error('Control Center could not listen on its local port.');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    gateway.closeStreams();
    gateway.server.close();
  });

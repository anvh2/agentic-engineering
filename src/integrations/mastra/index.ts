import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { createControlCenterRoutes } from '../control-center/mastra-routes.ts';
import { createMetricsRoute } from './metrics-route';
import { codingWorkerGo, codingWorkerJs } from '../../workers/coding-worker';
import { registerSpecialists } from './specialist-agents.ts';
import { specialistReviewWorkflow } from './workflows/specialist-review-workflow.ts';
import { codingTaskWorkflow } from './workflows/coding-task-workflow';

// Registration only constructs agents; it makes no model call and touches no repository. A pack that cannot load registers no
// specialists and records why, instead of preventing the coding workers from registering.
export const specialists = registerSpecialists();
if (specialists.error) console.warn(`[specialists] not registered: ${specialists.error}`);

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  server: { apiRoutes: [createMetricsRoute(), ...createControlCenterRoutes()] },
  agents: { codingWorkerGo, codingWorkerJs, ...specialists.agents },
  workflows: { codingTaskWorkflow, specialistReviewWorkflow },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: process.env.TURSO_DATABASE_URL || 'file:./mastra.db',
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});

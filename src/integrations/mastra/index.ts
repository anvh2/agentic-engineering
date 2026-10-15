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
import { mastraSpecialistAgents } from './specialist-agents.ts';
import { codingTaskWorkflow } from './workflows/coding-task-workflow';

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  server: { apiRoutes: [createMetricsRoute(), ...createControlCenterRoutes()] },
  agents: { codingWorkerGo, codingWorkerJs, ...mastraSpecialistAgents },
  workflows: { codingTaskWorkflow },
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

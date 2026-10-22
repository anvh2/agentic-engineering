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
import { createEngineeringStatusRoute } from './engineering-status-route.ts';
import { codingWorkerGo, codingWorkerJs } from '../../workers/coding-worker';
import { registerSpecialists } from './specialist-agents.ts';
import { specialistReviewWorkflow } from './workflows/specialist-review-workflow.ts';
import { codingTaskWorkflow } from './workflows/coding-task-workflow';
import { councilRegistration, councilStartupLine, createCouncilStatusRoute } from './council/register.ts';

// Registration only constructs agents; it makes no model call and touches no repository. A pack that cannot load registers no
// specialists and records why, instead of preventing the coding workers from registering.
export const specialists = registerSpecialists();
if (specialists.error) console.warn(`[specialists] not registered: ${specialists.error}`);
for (const r of specialists.refused) console.warn(`[specialists] ${r.id} not registered: ${r.reason}`);

// Engineering council (M11.x): scripted stand-in agents + the workflow. No model call and no network at registration.
const council = councilRegistration(specialists);
console.info(await councilStartupLine(specialists));

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  server: { apiRoutes: [createMetricsRoute(), createEngineeringStatusRoute(), createCouncilStatusRoute(specialists), ...createControlCenterRoutes({ specialists, codingWorkers: { codingWorkerGo, codingWorkerJs }, councilAgents: council.agents })] },
  agents: { codingWorkerGo, codingWorkerJs, ...specialists.agents, ...council.agents },
  workflows: { codingTaskWorkflow, specialistReviewWorkflow, engineeringCouncilWorkflow: council.workflow },
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

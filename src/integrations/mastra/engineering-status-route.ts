import { registerApiRoute } from '@mastra/core/server';
import { findProjectRoot } from '../../core/paths.ts';
import { join } from 'node:path';
import { buildEngineeringReport, readActiveKnowledge, type EngineeringReport } from '../../runtime/knowledge/engineering-control.ts';
import { loadPackRegistry, type PackRegistry } from '../../runtime/knowledge/packs/loader.ts';

export interface EngineeringStatusSources {
  root?: string | null;
  dbPath?: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

/** Builds the report from disk each call, so Studio always shows the current pack and promotion state. Read-only. */
export function readEngineeringStatus(sources: EngineeringStatusSources = {}): EngineeringReport {
  const root = sources.root === undefined ? (findProjectRoot(process.cwd()) ?? findProjectRoot(import.meta.dirname)) : sources.root;
  let registry: PackRegistry | undefined;
  let registryError: string | undefined;
  if (!root) registryError = 'project root not found';
  else { try { registry = loadPackRegistry(root); } catch (e) { registryError = (e as Error).message; } }
  const dbPath = sources.dbPath ?? (root ? join(root, '.workdir', 'engineering', 'knowledge.db') : '');
  return buildEngineeringReport({ registry, registryError, activeEntries: dbPath ? readActiveKnowledge(dbPath) : [], env: sources.env, now: (sources.now ?? Date.now)() });
}

/**
 * GET /engineering/v1/status on the existing Mastra server: pack, agents, promoted-skill drift, health and provider readiness
 * as JSON for operators and dashboards. Read-only; uses Mastra's normal authentication and the observability:read permission.
 */
export function createEngineeringStatusRoute(sources: EngineeringStatusSources = {}) {
  return registerApiRoute('/engineering/v1/status', {
    method: 'GET',
    requiresPermission: 'observability:read',
    handler: async (c) => {
      try {
        return c.json(readEngineeringStatus(sources), 200, { 'Cache-Control': 'no-store' });
      } catch {
        return c.json({ error: 'engineering status unavailable' }, 500);
      }
    },
  });
}

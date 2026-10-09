import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { createNodeServer } from '@mastra/deployer/server';
import { createCodingTaskWorkflow } from '../../src/integrations/mastra/workflows/coding-task-workflow.ts';
import { codexEntry, type CodexConfig } from '../../src/workers/providers/codex.ts';
import { geminiEntry, type GeminiConfig } from '../../src/workers/providers/gemini.ts';
import { ProviderRegistry } from '../../src/workers/providers/registry.ts';
import type { WorkerProvider } from '../../src/workers/providers/provider.ts';

/**
 * A dedicated, disposable Mastra HTTP server for the provider smoke test. It is NOT a second execution architecture: it
 * registers the same `createCodingTaskWorkflow()` the production server registers, and Mastra's own HTTP layer
 * (`createNodeServer`) serves it, so the scheduler reaches it through the same `/api/workflows/coding-task-workflow/*`
 * routes with the same client. What differs from `npm run dev` is only what a smoke needs:
 *
 *  - its own port and storage, so the operator's long-running `mastra dev` server (and its `.mastra/output` build) is never
 *    touched, and it always loads the CURRENT sources (no stale bundle);
 *  - an environment built by the harness: the operator allow-list (AGENTIC_ALLOW_PROVIDERS) arrives here as an env var and is
 *    enforced by the workflow in THIS process, exactly as in production;
 *  - an append-only ledger of the provider processes this server starts, so the harness (another process) can account for
 *    them, and a hard cap on provider invocations that sits outside the runner's own retry logic.
 *
 * Run: node tests/provider-smoke/smoke-server.ts   (config: JSON file named by AGENTIC_SMOKE_SERVER_CONFIG; port: PORT)
 */

export interface SmokeServerConfig {
  /** The one cloud provider this server registers (default `codex`). */
  provider?: 'codex' | 'gemini';
  codex?: Pick<CodexConfig, 'command' | 'model' | 'passEnv' | 'env' | 'termGraceMs'>;
  gemini?: Pick<GeminiConfig, 'command' | 'model' | 'passEnv' | 'env' | 'termGraceMs' | 'maxTurns' | 'maxOutputTokens' | 'apiBaseUrl'>;
  artifactRoot: string;
  /** libsql url for Mastra's workflow snapshots (a file inside the smoke directory). */
  storageUrl: string;
  /** Append-only JSON lines: one `invocation` per provider call, one `spawn` per process started. */
  ledgerPath: string;
  /** No more provider invocations than this are allowed through, whatever the runner would like to retry. */
  maxInvocations: number;
  modelTimeoutMs: number;
  runtimeRetryDelayMs?: number;
}

export function limitInvocations(provider: WorkerProvider, max: number, note: (event: Record<string, unknown>) => void): WorkerProvider {
  let calls = 0;
  return {
    get provider() {
      return provider.provider;
    },
    probe: () => provider.probe(),
    generate: (async (...args: Parameters<WorkerProvider['generate']>) => {
      calls += 1;
      note({ event: 'invocation', n: calls, max, allowed: calls <= max });
      if (calls > max) throw new Error(`smoke invocation bound reached: refusing provider call ${calls} (max ${max})`);
      return provider.generate(...args);
    }) as WorkerProvider['generate'],
  } as WorkerProvider;
}

export async function buildSmokeMastra(config: SmokeServerConfig): Promise<Mastra> {
  mkdirSync(dirname(config.ledgerPath), { recursive: true });
  const note = (event: Record<string, unknown>) => appendFileSync(config.ledgerPath, `${JSON.stringify({ ...event, at: new Date().toISOString(), serverPid: process.pid })}\n`);
  const onProcess = ({ pid }: { pid: number }) => note({ event: 'spawn', pid });
  const base = config.provider === 'gemini' ? geminiEntry({ ...config.gemini, onProcess }) : codexEntry({ ...config.codex, onProcess });
  const providers = new ProviderRegistry().register({ ...base, create: (ctx) => limitInvocations(base.create(ctx) as WorkerProvider, config.maxInvocations, note) });
  const workflow = createCodingTaskWorkflow({
    providers,
    // allowProviders is deliberately left unset: the workflow reads AGENTIC_ALLOW_PROVIDERS from THIS process's environment.
    artifactRoot: config.artifactRoot,
    runOptions: { modelTimeoutMs: config.modelTimeoutMs, runtimeRetryDelayMs: config.runtimeRetryDelayMs ?? 0 },
  });
  return new Mastra({
    workflows: { codingTaskWorkflow: workflow },
    storage: new LibSQLStore({ id: 'smoke-storage', url: config.storageUrl }),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.env.AGENTIC_SMOKE_SERVER_CONFIG;
  if (!file) throw new Error('AGENTIC_SMOKE_SERVER_CONFIG is required');
  const config = JSON.parse(readFileSync(file, 'utf8')) as SmokeServerConfig;
  const mastra = await buildSmokeMastra(config);
  await createNodeServer(mastra, { studio: false, isDev: false, tools: {} });
}

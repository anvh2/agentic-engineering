import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  codex?: Pick<CodexConfig, 'command' | 'model' | 'passEnv' | 'env' | 'termGraceMs' | 'denyReadPaths'>;
  gemini?: Pick<GeminiConfig, 'command' | 'model' | 'passEnv' | 'env' | 'termGraceMs' | 'maxTurns' | 'maxOutputTokens' | 'apiBaseUrl'>;
  artifactRoot: string;
  /** libsql url for Mastra's workflow snapshots (a file inside the smoke directory). */
  storageUrl: string;
  /** Append-only JSON lines: one `invocation` per provider call, one `spawn` per process started. */
  ledgerPath: string;
  /** No more provider invocations than this are allowed through, whatever the runner would like to retry. */
  maxInvocations: number;
  /**
   * Optional, stricter budget shared by EVERY provider instance in this server process (the default cap above is per instance): at most
   * `total` invocations for the whole server and at most `perWorkdir` per task worktree. Counted before a CLI starts, outside the runner's
   * retry logic, so a second coding attempt of the same task is refused as surely as a third task.
   */
  invocationBudget?: { total: number; perWorkdir: number };
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

/**
 * Server-wide budget for `invocationBudget`. It is NOT memory: every slot is a file created with `wx` (atomic, exclusive) next to the
 * ledger, so the budget survives a server crash or restart and holds even if an old and a new server briefly overlap. A server that
 * comes back after a crash therefore cannot spend what the first one already spent.
 */
export class SharedInvocationBudget {
  private readonly budget: { total: number; perWorkdir: number };
  private readonly note: (event: Record<string, unknown>) => void;
  private readonly dir: string;
  constructor(budget: { total: number; perWorkdir: number }, note: (event: Record<string, unknown>) => void, dir: string) {
    this.budget = budget;
    this.note = note;
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private claim(name: string): boolean {
    try {
      writeFileSync(join(this.dir, name), `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  }

  /** Takes one invocation slot for `workdir`, or refuses (and records the refusal). A refused call consumes nothing. */
  take(workdir: string): boolean {
    const key = createHash('sha256').update(workdir).digest('hex').slice(0, 16);
    let workdirSlot: string | undefined;
    for (let i = 1; i <= this.budget.perWorkdir && !workdirSlot; i += 1) if (this.claim(`wd-${key}-${i}`)) workdirSlot = `wd-${key}-${i}`;
    let totalSlot: number | undefined;
    if (workdirSlot) for (let i = 1; i <= this.budget.total && totalSlot === undefined; i += 1) if (this.claim(`total-${i}`)) totalSlot = i;
    if (workdirSlot && totalSlot === undefined) rmSync(join(this.dir, workdirSlot), { force: true }); // the total is spent: give the task slot back
    const allowed = workdirSlot !== undefined && totalSlot !== undefined;
    this.note({ event: 'invocation', n: totalSlot ?? this.budget.total, max: this.budget.total, perWorkdirMax: this.budget.perWorkdir, workdir, allowed });
    return allowed;
  }

  wrap(provider: WorkerProvider): WorkerProvider {
    return {
      get provider() {
        return provider.provider;
      },
      probe: () => provider.probe(),
      generate: (async (...args: Parameters<WorkerProvider['generate']>) => {
        const workdir = String((args[1] as { providerRequest?: { workdir?: string } } | undefined)?.providerRequest?.workdir ?? 'unknown');
        if (!this.take(workdir)) throw new Error(`invocation budget reached: refusing provider call for ${workdir} (total ${this.budget.total}, per task ${this.budget.perWorkdir})`);
        return provider.generate(...args);
      }) as WorkerProvider['generate'],
    } as WorkerProvider;
  }
}

export async function buildSmokeMastra(config: SmokeServerConfig): Promise<Mastra> {
  mkdirSync(dirname(config.ledgerPath), { recursive: true });
  const note = (event: Record<string, unknown>) => appendFileSync(config.ledgerPath, `${JSON.stringify({ ...event, at: new Date().toISOString(), serverPid: process.pid })}\n`);
  const onProcess = ({ pid }: { pid: number }) => note({ event: 'spawn', pid });
  const base = config.provider === 'gemini' ? geminiEntry({ ...config.gemini, onProcess }) : codexEntry({ ...config.codex, onProcess });
  const shared = config.invocationBudget ? new SharedInvocationBudget(config.invocationBudget, note, join(dirname(config.ledgerPath), 'invocation-budget')) : undefined;
  const providers = new ProviderRegistry().register({ ...base, create: (ctx) => (shared ? shared.wrap(base.create(ctx) as WorkerProvider) : limitInvocations(base.create(ctx) as WorkerProvider, config.maxInvocations, note)) });
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

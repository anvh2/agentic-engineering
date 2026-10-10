import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMastraExecutor } from '../../src/integrations/mastra/executor.ts';
import type { Executor } from '../../src/runtime/scheduler/scheduler.ts';
import type { CodexConfig } from '../../src/workers/providers/codex.ts';
import type { GeminiConfig } from '../../src/workers/providers/gemini.ts';
import { BASE_ENV_ALLOWLIST } from '../../src/workers/providers/process.ts';
import type { SmokeServerConfig } from './smoke-server.ts';

/**
 * The HTTP side of the provider smoke: starts a dedicated Mastra server as a child process (its own port, storage and process
 * group; see smoke-server.ts), hands the scheduler the production `createMastraExecutor` pointed at it, and accounts for the
 * provider processes that server starts through its ledger. Nothing here talks to, signals or reuses any other Mastra server.
 */

const SERVER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'smoke-server.ts');

/** What a backend gives the shared smoke core: an executor, and the facts needed to account for provider processes. */
export interface SmokeBackend {
  executor: Executor;
  /** Provider process groups (pid = group id) this smoke started. Nothing else is ever signalled or reported on. */
  ownedPids(): number[];
  stillAlive(): number[];
  /** Best-effort SIGKILL of the owned groups that are still alive (the second-signal path). Returns who was signalled, unconfirmed. */
  killOwned(): { sentSigkillTo: number[]; server?: { pid: number; sigtermSent: boolean } };
  /** Stops anything the backend started (the HTTP server) and reports it. Called after the scheduler has finished. */
  shutdown(): Promise<Record<string, unknown>>;
  /** Backend-specific facts for the report. */
  describe(): Record<string, unknown>;
}

export const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Environment variable names forwarded to the server: enough for `go test` and a signed-in Codex CLI, and no Mastra platform token or other secret. */
const FORWARDED_ENV = [...BASE_ENV_ALLOWLIST, 'GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOROOT', 'GOFLAGS', 'GOPROXY', 'CODEX_HOME'];

export function serverEnvironment(options: { port: number; configPath: string; allowProviders: readonly string[]; capacityDb?: string; passEnv?: readonly string[]; parentEnv?: NodeJS.ProcessEnv; sandboxDenyRead?: readonly string[] }): NodeJS.ProcessEnv {
  const parent = options.parentEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  // The adapter builds the CLI's environment from ITS process's: everything it would forward (its base list and the configured passEnv) must reach the server.
  for (const name of [...FORWARDED_ENV, ...(options.passEnv ?? [])]) if (parent[name] !== undefined) env[name] = parent[name];
  Object.assign(env, {
    PORT: String(options.port),
    MASTRA_HOST: '127.0.0.1',
    MASTRA_TELEMETRY_DISABLED: '1',
    AGENTIC_SMOKE_SERVER_CONFIG: options.configPath,
    // The operator's allow-list, as THIS process (the one that would spawn the CLI) must see it. Empty string: nothing allowed.
    AGENTIC_ALLOW_PROVIDERS: options.allowProviders.join(','),
    ...(options.capacityDb ? { AGENTIC_MODEL_LOCK_DB: options.capacityDb } : {}),
    // Paths the verifier sandbox (which runs worker-written code inside this server) must not read; see runtime/sandbox.
    ...(options.sandboxDenyRead?.length ? { AGENTIC_SANDBOX_DENY_READ: options.sandboxDenyRead.join(delimiter) } : {}),
  });
  return env;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

export interface HttpBackendOptions {
  outDir: string;
  provider?: 'codex' | 'gemini';
  codex?: Pick<CodexConfig, 'command' | 'model' | 'passEnv' | 'env' | 'termGraceMs' | 'denyReadPaths' | 'readAllowPaths'>;
  gemini?: Pick<GeminiConfig, 'command' | 'model' | 'passEnv' | 'env' | 'termGraceMs' | 'maxTurns' | 'maxOutputTokens' | 'apiBaseUrl'>;
  /** AGENTIC_ALLOW_PROVIDERS of the Mastra server process (the scheduler's own allow-list is separate). */
  serverAllowProviders: readonly string[];
  maxInvocations: number;
  /** Stricter server-wide budget (total and per task worktree); see SmokeServerConfig.invocationBudget. */
  invocationBudget?: { total: number; perWorkdir: number };
  modelTimeoutMs: number;
  capacityDb?: string;
  /** Use an already-running server (a stub, or an address nothing listens on) instead of starting one. */
  existingServer?: string;
  executor: { pollMs?: number; taskTimeoutMs: number; cancelGraceMs?: number };
  startTimeoutMs?: number;
  /** Make the server validate Codex read isolation against the real binary before it accepts work (smoke-server.ts). */
  requireIsolationCanary?: boolean;
  /** Paths the server's verifier sandbox must not let worker-written code read (AGENTIC_SANDBOX_DENY_READ). */
  sandboxDenyRead?: readonly string[];
  /** Restart of a server that crashed or was stopped: keep its ledger instead of starting a new one. */
  resume?: boolean;
  /** Listen on this port instead of a free one (a restart on the address the scheduler is already polling). */
  port?: number;
  log: (line: string) => void;
}

export async function createHttpBackend(options: HttpBackendOptions): Promise<SmokeBackend> {
  const serverDir = join(options.outDir, 'server');
  mkdirSync(serverDir, { recursive: true });
  const ledgerPath = join(serverDir, 'provider-ledger.jsonl');
  const logPath = join(serverDir, 'server.log');
  const configPath = join(serverDir, 'server-config.json');
  if (!options.resume) writeFileSync(ledgerPath, ''); // a restarted server keeps the ledger (and the durable invocation budget beside it)

  let child: ChildProcess | undefined;
  let url = options.existingServer?.replace(/\/$/, '');
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let serverStop: Record<string, unknown> | undefined;

  if (!url) {
    const config: SmokeServerConfig = {
      provider: options.provider,
      codex: options.codex,
      gemini: options.gemini,
      artifactRoot: join(options.outDir, 'artifacts'),
      storageUrl: `file:${join(serverDir, 'mastra.db')}`,
      ledgerPath,
      maxInvocations: options.maxInvocations,
      ...(options.invocationBudget ? { invocationBudget: options.invocationBudget } : {}),
      modelTimeoutMs: options.modelTimeoutMs,
      ...(options.requireIsolationCanary ? { requireIsolationCanary: true } : {}),
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const port = options.port ?? (await freePort());
    const out = openSync(logPath, 'a');
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER_ENTRY], {
      cwd: serverDir,
      env: serverEnvironment({ port, configPath, allowProviders: options.serverAllowProviders, capacityDb: options.capacityDb, passEnv: (options.provider === 'gemini' ? options.gemini : options.codex)?.passEnv, sandboxDenyRead: options.sandboxDenyRead }),
      detached: true, // own process group: a terminal Ctrl-C reaches the harness only, which stops things in a controlled order
      stdio: ['ignore', out, out],
    });
    closeSync(out);
    child.once('exit', (code, signal) => (exitInfo = { code, signal }));
    url = `http://127.0.0.1:${port}`;
    options.log(`smoke Mastra server pid ${child.pid} on ${url} (log: ${logPath}); allow-list in its environment: ${options.serverAllowProviders.join(',') || '(empty)'}`);
    const deadline = Date.now() + (options.startTimeoutMs ?? (options.requireIsolationCanary ? 240_000 : 90_000));
    for (;;) {
      if (exitInfo) throw new Error(`the smoke Mastra server exited during startup (code ${exitInfo.code}, signal ${exitInfo.signal}); see ${logPath}`);
      try {
        const res = await fetch(`${url}/api/workflows`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok && 'codingTaskWorkflow' in ((await res.json()) as object)) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) {
        await stopServer();
        throw new Error(`the smoke Mastra server did not become ready within ${options.startTimeoutMs ?? 90_000}ms; see ${logPath}`);
      }
      await sleep(200);
    }
  }

  async function stopServer(): Promise<Record<string, unknown>> {
    if (!child?.pid) return { started: false };
    const pid = child.pid;
    if (!exitInfo) {
      child.kill('SIGTERM'); // the Mastra server's own graceful shutdown (bounded at 5 s by Mastra)
      for (let i = 0; i < 100 && !exitInfo; i += 1) await sleep(100);
      if (!exitInfo) {
        child.kill('SIGKILL');
        for (let i = 0; i < 50 && !exitInfo; i += 1) await sleep(100);
      }
    }
    return (serverStop = { started: true, pid, exited: Boolean(exitInfo) && !pidAlive(pid), exit: exitInfo ?? null });
  }

  const ledger = () =>
    readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; pid?: number; allowed?: boolean; n?: number });
  const ownedPids = () => [...new Set(ledger().filter((e) => e.event === 'spawn' && typeof e.pid === 'number').map((e) => e.pid as number))];

  return {
    executor: createMastraExecutor({ server: url, pollMs: options.executor.pollMs ?? 250, taskTimeoutMs: options.executor.taskTimeoutMs, cancelGraceMs: options.executor.cancelGraceMs }),
    ownedPids,
    stillAlive: () => ownedPids().filter(groupAlive),
    killOwned() {
      const live = ownedPids().filter(groupAlive);
      for (const pid of live) {
        try {
          process.kill(-pid, 'SIGKILL'); // a provider group this smoke's server started; best effort, not confirmed here
        } catch {
          /* already gone */
        }
      }
      let server: { pid: number; sigtermSent: boolean } | undefined;
      if (child?.pid && !exitInfo) {
        try {
          child.kill('SIGTERM');
          server = { pid: child.pid, sigtermSent: true };
        } catch {
          server = { pid: child.pid, sigtermSent: false };
        }
      }
      return { sentSigkillTo: live, ...(server ? { server } : {}) };
    },
    shutdown: stopServer,
    describe() {
      const events = existsSync(ledgerPath) ? ledger() : [];
      return {
        transport: 'http',
        serverUrl: url,
        serverStartedByHarness: Boolean(child),
        serverPid: child?.pid ?? null,
        serverStop: serverStop ?? null,
        serverLog: child ? logPath : null,
        serverAllowProviders: [...options.serverAllowProviders],
        maxInvocations: options.maxInvocations,
        invocationBudget: options.invocationBudget ?? null,
        providerInvocations: events.filter((e) => e.event === 'invocation' && e.allowed).length,
        providerInvocationsRefused: events.filter((e) => e.event === 'invocation' && !e.allowed).length,
        providerProcessesSpawned: events.filter((e) => e.event === 'spawn').length,
        ledger: ledgerPath,
      };
    },
  };
}

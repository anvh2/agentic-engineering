import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from '../../src/core/paths.ts';
import { runObjectiveLifecycle, cancelObjective, type LifecycleOutcome } from '../../src/lead/lifecycle/driver.ts';
import { sandboxRunner, sha256 } from '../../src/lead/lifecycle/exec.ts';
import { pinOracle } from '../../src/lead/lifecycle/oracle.ts';
import { LifecycleStore } from '../../src/lead/lifecycle/store.ts';
import { capacityFor } from '../../src/runtime/capacity/model-capacity.ts';
import { parseAllowList } from '../../src/runtime/execution/worker-provider.ts';
import { Scheduler } from '../../src/runtime/scheduler/scheduler.ts';
import { SchedulerStore } from '../../src/runtime/scheduler/store.ts';
import { runSandboxedCommand } from '../../src/runtime/sandbox/sandbox.ts';
import { WorktreeManager } from '../../src/runtime/worktree/worktree.ts';
import type { CodexConfig } from '../../src/workers/providers/codex.ts';
import { createHttpBackend, groupAlive, type SmokeBackend } from './http-backend.ts';
import { credentialDenyPaths, discoverToolchainReadPaths } from '../../src/workers/providers/codex-isolation.ts';
import { readIsolationProblems, verifierSandboxProblems } from './read-isolation-canary.ts';

/**
 * M8.5, the first REAL autonomous objective: one deterministic Go objective with two dependent coding tasks, run through
 *
 *   pinned objective -> Scheduler -> Mastra HTTP (a dedicated server this command starts and stops) -> coding-task-workflow
 *   -> Codex CLI adapter -> isolated worktree -> runtime verifier -> verified review -> integrateBatch (dependency order)
 *   -> the pinned independent oracle (candidate must pass, base must fail) -> an audited verdict.
 *
 * Nothing here plans (no Claude call): the plan is the constant below. Every bound of the authorization is enforced by code:
 *
 *   Codex invocations         <= 2 in the whole experiment and <= 1 per task worktree   server-wide budget, counted before the CLI starts
 *   claims                    <= 1 per task                                             task `maxClaims`
 *   per invocation            <= 300 s                                                  the call's deadline terminates the CLI's process group
 *   active execution per task <= 420 s                                                  scheduler `taskTimeoutMs`
 *   retries / fallback        none                                                      Codex descriptor `maxRuntimeRetries: 0`; one allow-listed provider
 *   repair                    never granted                                             no `lifecycle authorize`; a paid repair stops at AWAITING_OPERATOR
 */

export const M85_OPT_IN_ENV = 'AGENTIC_REAL_PROVIDER_SMOKE';
export const M85_OPT_IN_VALUE = 'codex-objective';
export const OBJECTIVE_ID = 'm85-wordstat';
export const TASK_A = 'm85-normalize';
export const TASK_B = 'm85-wordfreq';

export const M85_LIMITS: Record<'maxInvocationsTotal' | 'maxInvocationsPerTask' | 'maxClaimsPerTask' | 'perInvocationTimeoutMs' | 'taskActiveTimeoutMs' | 'cancelConfirmationMs' | 'maxRounds', number> = {
  maxInvocationsTotal: 2,
  maxInvocationsPerTask: 1,
  maxClaimsPerTask: 1,
  perInvocationTimeoutMs: 300_000,
  taskActiveTimeoutMs: 420_000,
  cancelConfirmationMs: 45_000,
  maxRounds: 8,
};

// ---------------------------------------------------------------------------------------------------------------- the objective

export const STUBS: Record<string, string> = {
  'go.mod': 'module example.com/wordstat\n\ngo 1.22\n',
  'normalize.go':
    '// Package wordstat counts words in free-form text.\npackage wordstat\n\n// Normalize trims s, collapses every run of Unicode whitespace (spaces, tabs, newlines, ...) into one ASCII space\n// and lower-cases all letters.\nfunc Normalize(s string) string {\n\treturn "" // TODO\n}\n',
  'wordfreq.go':
    'package wordstat\n\n// Frequencies returns how many times each word occurs in text. The words are the space-separated fields of Normalize(text).\n// The result is never nil: it is empty when text has no words.\nfunc Frequencies(text string) map[string]int {\n\treturn nil // TODO\n}\n',
  'README.md': '# wordstat\n',
};

/** Runtime-owned task tests: never shown to the worker, ASCII-space only, so they do NOT cover what the oracle covers. */
export const TASK_TESTS = {
  [TASK_A]: {
    path: 'normalize_task_test.go',
    content:
      'package wordstat\n\nimport "testing"\n\nfunc TestNormalizeTask(t *testing.T) {\n\tcases := map[string]string{"  Hello   World ": "hello world", "ABC": "abc", "": ""}\n\tfor in, want := range cases {\n\t\tif got := Normalize(in); got != want {\n\t\t\tt.Fatalf("Normalize(%q) = %q, want %q", in, got, want)\n\t\t}\n\t}\n}\n',
  },
  // Task B's verifier calls Normalize itself: with task A not integrated the stub returns "" and B cannot pass.
  [TASK_B]: {
    path: 'wordfreq_task_test.go',
    content:
      'package wordstat\n\nimport "testing"\n\nfunc TestFrequenciesTask(t *testing.T) {\n\tif got := Normalize(" Go  Go "); got != "go go" {\n\t\tt.Fatalf("dependency check: Normalize(\\" Go  Go \\") = %q, want \\"go go\\" (is the previous task integrated?)", got)\n\t}\n\tgot := Frequencies("the The  THE cat")\n\tif got == nil || len(got) != 2 || got["the"] != 3 || got["cat"] != 1 {\n\t\tt.Fatalf("Frequencies = %v", got)\n\t}\n\tif e := Frequencies(""); e == nil || len(e) != 0 {\n\t\tt.Fatalf("Frequencies(\\"\\") = %#v, want a non-nil empty map", e)\n\t}\n}\n',
  },
} as const;

/**
 * The independent objective oracle. It tests what the task verifiers do not: tabs, newlines, non-breaking and em spaces, non-ASCII
 * case folding, whitespace-only input, and the two functions working together on the integrated tree.
 */
export const ORACLE_FILE = 'acceptance_test.go';
export const ORACLE_SOURCE = `package wordstat

import "testing"

func TestObjectiveAcceptance(t *testing.T) {
	if got, want := Normalize("A\\t\\tB\\n"), "a b"; got != want {
		t.Fatalf("Normalize tabs/newlines: got %q want %q", got, want)
	}
	if got, want := Normalize("\\u00a0 \\u00c9CLAIR\\u2003Cake \\n"), "\\u00e9clair cake"; got != want {
		t.Fatalf("Normalize unicode: got %q want %q", got, want)
	}
	got := Frequencies("\\u00c9clair\\t\\u00e9CLAIR\\ncake  \\u00a0CAKE\\u2003Cake")
	if len(got) != 2 || got["\\u00e9clair"] != 2 || got["cake"] != 3 {
		t.Fatalf("Frequencies unicode/whitespace: got %v", got)
	}
	if e := Frequencies(" \\t\\n "); e == nil || len(e) != 0 {
		t.Fatalf("Frequencies of whitespace only: got %#v, want a non-nil empty map", e)
	}
	if n := Frequencies("a b a")["a"]; n != 2 {
		t.Fatalf("Frequencies(a b a)[a] = %d", n)
	}
}
`;

export const ACCEPTANCE_CRITERIA = [
  'Objective m85-wordstat (Go module example.com/wordstat), two dependent tasks:',
  '  A  m85-normalize  normalize.go  Normalize(s): trim, collapse every run of Unicode whitespace to one space, lower-case.',
  '  B  m85-wordfreq   wordfreq.go   Frequencies(text): word counts of Normalize(text); never nil. B requires A integrated.',
  'Accepted only if ALL hold:',
  '  1. both tasks reach DONE through verified review and integrateBatch, A before B, on lead-integration/m85-wordstat;',
  '  2. the pinned oracle (acceptance_test.go; go vet ./... ; go test -count=1 ./...) PASSES on the integration tip;',
  '  3. the same oracle FAILS (real exit code) on the batch base (negative control);',
  '  4. oracle files hash exactly as pinned, pinned before the first claim; tip and base identities match the repository;',
  '  5. <= 2 Codex invocations (<= 1 per task), 1 claim per task, no repair, no push, main untouched.',
].join('\n');

export const PLAN_TASKS = (provider: string) =>
  [
    {
      id: TASK_A,
      title: 'Implement Normalize',
      priority: 60,
      executor: 'worker',
      maxClaims: M85_LIMITS.maxClaimsPerTask,
      dependsOn: [],
      request: {
        contract: {
          taskId: TASK_A,
          objective:
            'Implement Normalize in normalize.go. It returns s with leading and trailing whitespace removed, every run of Unicode whitespace (spaces, tabs, newlines, non-breaking and other Unicode spaces) collapsed into a single ASCII space, and all letters lower-cased using Unicode rules. Keep the package comment and the doc comment.',
          allowedFiles: ['normalize.go'],
          contextFiles: [],
          acceptanceCriteria: ['Normalize("  Hello   World ") == "hello world"', 'Normalize("") == ""', 'tabs, newlines and Unicode spaces count as whitespace; non-ASCII letters are lower-cased'],
          verificationCommands: [['go', 'test', '-count=1', './...']],
          constraints: ['tests are immutable', 'standard library only', 'do not modify any other file'],
          hiddenFiles: { [TASK_TESTS[TASK_A].path]: TASK_TESTS[TASK_A].content },
        },
        assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one pure function with a precise specification' },
        provider,
      },
    },
    {
      id: TASK_B,
      title: 'Implement Frequencies',
      priority: 50,
      executor: 'worker',
      maxClaims: M85_LIMITS.maxClaimsPerTask,
      dependsOn: [TASK_A],
      request: {
        contract: {
          taskId: TASK_B,
          objective:
            'Implement Frequencies in wordfreq.go. It returns how many times each word occurs in text, where the words are the space-separated fields of Normalize(text). Normalize is implemented in normalize.go by the previous task and is already in your worktree: call it, do not re-implement normalization. The result is never nil: return an empty map when text has no words. Keep the doc comment.',
          allowedFiles: ['wordfreq.go'],
          contextFiles: ['normalize.go'],
          acceptanceCriteria: ['Frequencies("the The  THE cat") == {the: 3, cat: 1}', 'Frequencies("") is a non-nil empty map', 'uses Normalize from normalize.go'],
          verificationCommands: [['go', 'test', '-count=1', './...']],
          constraints: ['tests are immutable', 'standard library only', 'do not modify any other file, in particular not normalize.go'],
          hiddenFiles: { [TASK_TESTS[TASK_B].path]: TASK_TESTS[TASK_B].content },
        },
        assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'a small function over the previous task output' },
        provider,
      },
    },
  ] as never[];

// ---------------------------------------------------------------------------------------------------------------- the gate

export type M85Authorization = { ok: true; allowProviders: string[] } | { ok: false; reason: string };

/** Disabled unless the operator opts in; takes no arguments; the operator's allow-list is narrowed to exactly these two tasks. */
export function checkM85Authorization(env: NodeJS.ProcessEnv, argv: readonly string[] = []): M85Authorization {
  if (env[M85_OPT_IN_ENV] !== M85_OPT_IN_VALUE) return { ok: false, reason: `the real M8.5 objective is disabled by default; it calls a cloud model and spends the operator's Codex quota. Opt in with ${M85_OPT_IN_ENV}=${M85_OPT_IN_VALUE}` };
  if (argv.length > 0) return { ok: false, reason: `this command takes no arguments (${argv.join(' ')}): it runs one fixed disposable objective` };
  const allow = parseAllowList(env.AGENTIC_ALLOW_PROVIDERS);
  const entries = [`codex:${TASK_A}`, `codex:${TASK_B}`];
  if (!allow.includes('codex') && !entries.every((e) => allow.includes(e))) return { ok: false, reason: `no operator authorization: set AGENTIC_ALLOW_PROVIDERS=${entries.join(',')} (entries seen: ${allow.join(', ') || 'none'})` };
  return { ok: true, allowProviders: entries };
}

// ---------------------------------------------------------------------------------------------------------------- the run

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'm85', GIT_AUTHOR_EMAIL: 'm85@example.invalid', GIT_COMMITTER_NAME: 'm85', GIT_COMMITTER_EMAIL: 'm85@example.invalid' };
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
const tryGit = (cwd: string, ...args: string[]) => {
  try {
    return sh(cwd, ...args);
  } catch {
    return null;
  }
};

/** A path as the sandbox will see it: symlinks resolved through the deepest existing ancestor (the file itself may not exist yet). */
export function sandboxPath(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return [realpathSync(cur), ...tail.reverse()].join('/').replace(/\/+/g, '/');
    } catch {
      tail.push(basename(cur));
      const parent = dirname(cur);
      if (parent === cur) return p;
      cur = parent;
    }
  }
}

export class M85Cancelled extends Error {}

export interface M85Options {
  codex?: CodexConfig;
  allowProviders: string[];
  /** Capacity database shared by the scheduler and the server (default: a file inside outDir, so no machine-wide permit is touched). */
  capacityDb?: string;
  outDir?: string;
  limits?: Partial<typeof M85_LIMITS>;
  signalSource?: { on(event: string, l: (...a: unknown[]) => void): unknown; off(event: string, l: (...a: unknown[]) => void): unknown };
  exit?: (code: number) => void;
  log?: (line: string) => void;
  pollMs?: number;
  /**
   * Read isolation (default ON, allow-list mode: the model's commands can read only the system minimum, the Go toolchain and the worktree;
   * credentials, the whole home directory and everything else are unreadable; tool surface and environment are pinned, see
   * codex-isolation.ts) and in addition the oracle, runtime state holding hidden tests, this harness's source (which embeds the fixture oracle),
   * the enclosing checkout's `.git` and the legacy M8.5 evidence are unreadable to the Codex worker AND to worker-written code run by
   * the verifier. `false` reproduces the M8.5 behavior (oracle in `<outDir>/oracle`, nothing denied); only tests use it.
   */
  isolation?: false | { extraDenyRead?: string[]; extraReadAllow?: string[] };
  /** Make the Mastra server validate Codex read isolation against the real binary before it accepts work, and refuse to start otherwise. Real runs set it. */
  requireIsolationCanary?: boolean;
  /** Fault injection (tests only): crash the Mastra server with SIGKILL as soon as the first provider process exists; optionally restart it on the same port with the same storage and ledger. */
  chaos?: { crashServerAfterSpawn: { restartAfterMs?: number } };
}

export interface M85Result {
  outDir: string;
  report: Record<string, any>;
  outcome: LifecycleOutcome | null;
}

export async function runM85Objective(options: M85Options): Promise<M85Result> {
  const limits = { ...M85_LIMITS, ...options.limits };
  const log = options.log ?? ((l: string) => console.error(l));
  const projectRoot = findProjectRoot() ?? process.cwd();
  const isolated = options.isolation !== false;
  const outDir = options.outDir ?? join(projectRoot, '.workdir', isolated ? 'm8.6-real' : 'm8.5-real', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outDir, { recursive: true });
  const realOut = sandboxPath(outDir);
  // The oracle lives beside the run directory (not in it) when isolated, so the worker's worktree area never contains or sits under it.
  const oracleDir = isolated ? `${realOut}.oracle` : join(outDir, 'oracle');
  const denyRead = isolated
    ? [oracleDir, ...['scheduler.db', 'scheduler.db-wal', 'scheduler.db-shm'].map((f) => join(realOut, f)), sandboxPath(fileURLToPath(import.meta.url)), sandboxPath(join(projectRoot, '.git')), sandboxPath(join(projectRoot, '.workdir', 'm8.5-real')), ...(options.isolation ? (options.isolation.extraDenyRead ?? []) : []).map(sandboxPath)]
    : [];
  const capacityDb = options.capacityDb ?? join(outDir, 'capacity.db');

  // ---- the disposable repository (its own git repo inside outDir; the enclosing repository is never touched)
  const repo = join(outDir, 'repo');
  for (const [path, content] of Object.entries(STUBS)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'fixture: wordstat stubs');
  const refs = () => sh(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
  const before = { head: sh(repo, 'rev-parse', 'HEAD'), refs: refs() };

  // ---- the pinned acceptance material, hashed BEFORE any worker claim (and recorded on disk before the backend starts)
  mkdirSync(oracleDir, { recursive: true });
  writeFileSync(join(oracleDir, ORACLE_FILE), ORACLE_SOURCE);
  const pinnedDir = join(outDir, 'pinned');
  mkdirSync(pinnedDir, { recursive: true });
  writeFileSync(join(pinnedDir, 'acceptance-criteria.txt'), `${ACCEPTANCE_CRITERIA}\n`);
  const pinnedRecord = {
    pinnedAt: new Date().toISOString(),
    objectiveId: OBJECTIVE_ID,
    baseCommit: before.head,
    criteriaSha256: sha256(`${ACCEPTANCE_CRITERIA}\n`),
    oracleFiles: { [ORACLE_FILE]: sha256(ORACLE_SOURCE) },
    oracleCommands: [['go', 'vet', './...'], ['go', 'test', '-count=1', './...']],
    taskTestSha256: Object.fromEntries(Object.entries(TASK_TESTS).map(([id, t]) => [id, sha256(t.content)])),
    limits,
  };
  writeFileSync(join(pinnedDir, 'pinned-objective.json'), `${JSON.stringify(pinnedRecord, null, 2)}\n`);

  // ---- the dedicated Mastra server (own port, storage, env; started and stopped here) with the server-wide invocation budget
  const providerId = 'codex';
  // Worker-written code also runs in the verifier / review / integration / acceptance sandbox. That sandbox is a deny-list (it reads everything
  // but credentials), so it gets the same credential list as the Codex profile on top of the oracle and runtime state. Anything nobody listed
  // under the home directory stays readable to that code: see docs/reports/m8.7a-credential-isolation.md.
  const verifierDenyRead = isolated ? [...new Set([...denyRead, ...credentialDenyPaths(process.env)])].sort() : [];
  const readAllow = isolated ? [...new Set([...discoverToolchainReadPaths(), ...(options.isolation ? (options.isolation.extraReadAllow ?? []) : [])])].sort() : undefined;
  const codexConfig = { ...options.codex, ...(isolated ? { denyReadPaths: denyRead, readAllowPaths: readAllow } : {}) };
  const backendOptions = {
    outDir,
    provider: providerId,
    codex: codexConfig,
    serverAllowProviders: options.allowProviders,
    maxInvocations: limits.maxInvocationsTotal,
    invocationBudget: { total: limits.maxInvocationsTotal, perWorkdir: limits.maxInvocationsPerTask },
    modelTimeoutMs: limits.perInvocationTimeoutMs,
    capacityDb,
    sandboxDenyRead: verifierDenyRead,
    ...(options.requireIsolationCanary ? { requireIsolationCanary: true } : {}),
    executor: { pollMs: options.pollMs, taskTimeoutMs: limits.taskActiveTimeoutMs + 60_000 },
    log,
  } as const;
  const backend = await createHttpBackend(backendOptions);
  let restarted: SmokeBackend | undefined;
  let chaosLog: Record<string, unknown> | undefined;
  const chaosTimer = options.chaos
    ? setInterval(() => {
        if (chaosLog || backend.ownedPids().length === 0) return;
        const serverPid = backend.describe().serverPid as number;
        chaosLog = { crashedServerPid: serverPid, at: new Date().toISOString(), providerGroupsAtCrash: backend.ownedPids() };
        process.kill(serverPid, 'SIGKILL');
        log(`chaos: SIGKILL sent to the Mastra server ${serverPid} while a provider process runs`);
        const restartAfter = options.chaos?.crashServerAfterSpawn.restartAfterMs;
        if (restartAfter !== undefined) {
          setTimeout(() => {
            const port = Number(new URL(String(backend.describe().serverUrl)).port);
            createHttpBackend({ ...backendOptions, resume: true, port }).then((b) => {
              restarted = b;
              chaosLog = { ...chaosLog, restartedServerPid: b.describe().serverPid };
            }, (e) => (chaosLog = { ...chaosLog, restartFailed: String(e) }));
          }, restartAfter);
        }
      }, 50)
    : undefined;

  const store = new SchedulerStore(join(outDir, 'scheduler.db'));
  const worktrees = new WorktreeManager(join(outDir, 'worktrees'));
  const lifecycle = new LifecycleStore(store);
  store.createBatch({ batchId: OBJECTIVE_ID, project: 'wordstat', repository: repo, description: 'M8.5 real objective', integrationCommands: [['go', 'vet', './...']], tasks: PLAN_TASKS(providerId) } as never);
  store.promote();
  const artifactRoot = join(outDir, 'artifacts');
  const pinned = await pinOracle(
    { store, lifecycle, worktrees, forbiddenRoots: [artifactRoot] },
    { objectiveId: OBJECTIVE_ID, batchId: OBJECTIVE_ID, spec: { dir: oracleDir, files: [ORACLE_FILE], commands: pinnedRecord.oracleCommands, negativeControl: { mode: 'required' } }, actor: 'operator' },
  );
  log(`oracle ${pinned.oracle.specHash.slice(0, 12)} pinned before any claim; base ${pinned.baseCommit.slice(0, 10)}`);

  const capacity = capacityFor(undefined, capacityDb);
  const config = { maxConcurrentWorkers: 1, pollMs: 500, workerLeaseTimeoutMs: 60_000, taskTimeoutMs: limits.taskActiveTimeoutMs, maxCapacityWaitMs: 60_000, maxTasksPerBatch: 5, maxReviewCorrections: 2 };
  const scheduler = new Scheduler({ store, executor: backend.executor, workspace: worktrees, config, capacity, allowProviders: options.allowProviders, log: (l) => log(`  ${l}`) });

  // ---- signals: first = cancel the objective and confirm, second = SIGKILL what this run owns and exit
  const source = options.signalSource ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let signals = 0;
  let cancelled: Promise<unknown> | undefined;
  const onSignal = (name: string) => {
    signals += 1;
    if (signals === 1) {
      log(`${name}: cancelling the objective (no new claim; the Codex run is cancelled and confirmed). Send ${name} again to exit immediately.`);
      cancelled = cancelObjective({ store, lifecycle, scheduler, executor: backend.executor, capacity, log }, OBJECTIVE_ID, { actor: 'operator', reason: `${name} received` }).catch((e) => log(`cancel failed: ${e}`));
      return;
    }
    const killed = backend.killOwned();
    log(`${name} again: exiting. SIGKILL sent to Codex groups ${killed.sentSigkillTo.join(', ') || 'none'} (NOT confirmed); server ${killed.server?.pid ?? 'n/a'} sent SIGTERM (NOT confirmed).`);
    exit(130);
  };
  const handlers: [string, () => void][] = [['SIGINT', () => onSignal('SIGINT')], ['SIGTERM', () => onSignal('SIGTERM')]];
  for (const [name, h] of handlers) source.on(name, h);

  // ---- the run
  const started = Date.now();
  let outcome: LifecycleOutcome | null = null;
  let runError: string | null = null;
  try {
    outcome = await runObjectiveLifecycle(
      { store, worktrees, lifecycle, scheduler, executor: backend.executor, capacity, run: sandboxRunner(600_000, { denyRead: verifierDenyRead }), config, evidenceDir: join(outDir, 'objective'), maxRounds: limits.maxRounds, log: (l) => log(`  ${l}`) },
      OBJECTIVE_ID,
      { actor: 'operator' },
    );
  } catch (err) {
    runError = (err as Error).stack ?? String(err);
    log(`the lifecycle driver threw: ${runError}`);
  } finally {
    for (const [name, h] of handlers) source.off(name, h);
  }
  if (cancelled) await cancelled;
  const elapsedMs = Date.now() - started;

  // ---- cleanup: the server is stopped last, and only if no provider process is left
  if (chaosTimer) clearInterval(chaosTimer);
  const crashed = chaosLog !== undefined;
  let orphansKilled: number[] = [];
  if (crashed) {
    // The server that supervised the provider processes is gone, so nothing else will end them: they are this run's own, tracked in its ledger.
    await new Promise((r) => setTimeout(r, 1_000));
    orphansKilled = backend.killOwned().sentSigkillTo;
  }
  const deadline = Date.now() + limits.cancelConfirmationMs;
  while (backend.stillAlive().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const leftRunning = backend.stillAlive();
  const serverShutdown = leftRunning.length > 0 ? { skipped: 'a provider process is not confirmed gone: the server was left running so its runner keeps supervising it' } : await (restarted ?? backend).shutdown();
  const crashedServerGone = crashed ? !pidAlive(Number((chaosLog as Record<string, unknown>).crashedServerPid)) : null;

  // A holder that crashed (the server) leaves its lease row until the next admission reaps it, so "no lease row" is not proof the permit is
  // free. Prove it: take the Codex permit ourselves and give it back. The rows are re-read after this.
  const probeLease = capacityFor({ resource: 'codex', defaultPermits: 1 }, capacityDb).tryAcquire('m86-permit-probe');
  const permitProbe = { acquiredAfterRun: probeLease !== undefined };
  probeLease?.release();

  // ---- evidence
  const lc = lifecycle.require(OBJECTIVE_ID);
  const tasks = store.listTasks({ batchId: OBJECTIVE_ID });
  const integrationRef = `lead-integration/${OBJECTIVE_ID}`;
  const tip = tryGit(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${integrationRef}`);
  const baseRef = tryGit(repo, 'rev-parse', '--verify', '--quiet', `refs/lead/base/${OBJECTIVE_ID}`);
  const taskReports = tasks.map((t) => {
    const events = store.events(t.id);
    const at = (state: string) => events.find((e) => e.to === state)?.at ?? null;
    const artifactDir = typeof t.artifacts.artifactDir === 'string' ? t.artifacts.artifactDir : undefined;
    const attempts = artifactDir && existsSync(join(artifactDir, 'attempts.json')) ? (JSON.parse(readFileSync(join(artifactDir, 'attempts.json'), 'utf8')) as Record<string, any>[]) : [];
    const claimedAt = at('CLAIMED');
    const reviewAt = at('REVIEW_PENDING');
    return {
      id: t.id,
      state: t.state,
      stateReason: t.stateReason,
      failureCategory: t.failureCategory,
      claims: t.claims,
      claimEpoch: t.claimEpoch,
      runIds: t.runIds,
      codingAttempts: attempts.length,
      runtimeRetries: attempts.reduce((n, a) => n + (a.runtimeRetries ?? 0), 0),
      claimedAt,
      reviewPendingAt: reviewAt,
      activeMs: claimedAt !== null && reviewAt !== null ? reviewAt - claimedAt : null,
      codingMs: t.codingMs,
      verifyMs: t.verifyMs,
      telemetry: attempts.map((a) => a.telemetry ?? null),
      workerVerifier: attempts.map((a) => a.verification && { command: a.verification.command, exitCode: a.verification.exitCode }),
      filesMutated: attempts.map((a) => a.filesMutated),
      forbiddenFiles: attempts.map((a) => a.forbiddenFiles),
      headCommit: t.headCommit,
      baseCommit: t.baseCommit,
      integratedCommit: (t.artifacts.integration as { integratedCommit?: string } | undefined)?.integratedCommit ?? null,
      verifiedReviews: ((t.artifacts.verifiedReviews as Record<string, any>[] | undefined) ?? []).map((v) => ({ reviewId: v.reviewId, verdict: v.verdict, reasons: v.reasons, verdictHash: v.verdictHash, checks: (v.checks ?? []).map((c: Record<string, any>) => ({ name: c.name, ok: c.ok, class: c.class, detail: typeof c.detail === 'string' ? c.detail.slice(0, 240) : c.detail })) })),
      leasesStillHeld: capacity.engagedBy(t.id),
      events: events.map((e) => ({ at: new Date(e.at).toISOString(), from: e.from, to: e.to, actor: e.actor, reason: e.reason })),
    };
  });
  const ledger = existsSync(backend.describe().ledger as string)
    ? readFileSync(backend.describe().ledger as string, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, any>)
    : [];
  const invocations = ledger.filter((e) => e.event === 'invocation');
  const allowed = invocations.filter((e) => e.allowed);
  const perWorkdir = new Map<string, number>();
  for (const e of allowed) perWorkdir.set(e.workdir, (perWorkdir.get(e.workdir) ?? 0) + 1);
  const acceptance = outcome?.acceptance ?? null;
  const oracleNow = Object.fromEntries(Object.keys(pinned.oracle.files).map((f) => [f, existsSync(join(oracleDir, f)) ? sha256(readFileSync(join(oracleDir, f))) : '(missing)']));
  const afterRefs = refs().split('\n');
  const beforeRefs = before.refs.split('\n');
  const newRefs = afterRefs.filter((l) => !beforeRefs.includes(l)).map((l) => l.split(' ')[0]);
  const neg = acceptance?.negativeControl && 'commands' in acceptance.negativeControl ? acceptance.negativeControl : null;
  const checks = {
    lifecyclePhase: lc.phase,
    codexInvocationsAllowed: allowed.length,
    codexInvocationsRefused: invocations.length - allowed.length,
    codexInvocationsWithinTotal: allowed.length <= limits.maxInvocationsTotal,
    codexInvocationsPerTaskWorktree: Object.fromEntries(perWorkdir),
    codexInvocationsWithinPerTask: [...perWorkdir.values()].every((n) => n <= limits.maxInvocationsPerTask),
    claimsWithinBound: taskReports.every((t) => t.claims <= limits.maxClaimsPerTask),
    noCorrectionTasks: tasks.every((t) => t.correctionOf === null),
    noRuntimeRetries: taskReports.every((t) => t.runtimeRetries === 0),
    oracleHashUnchangedOnDisk: JSON.stringify(oracleNow) === JSON.stringify(pinned.oracle.files),
    oracleHashInAcceptance: acceptance ? acceptance.oracle.unchanged && acceptance.oracle.specHash === pinned.oracle.specHash : null,
    oraclePinnedBeforeFirstClaim: acceptance ? acceptance.oracle.pinnedBeforeFirstClaim : null,
    tipMatchesRepository: acceptance && tip ? acceptance.integration.tip === tip && acceptance.candidate?.commit === tip : null,
    negativeControlOnPinnedBase: acceptance && baseRef ? acceptance.integration.baseCommit === baseRef && baseRef === before.head && neg?.commit === baseRef : null,
    negativeControlExitCodes: neg ? neg.commands.map((c) => c.exitCode) : null,
    candidateExitCodes: acceptance?.candidate ? acceptance.candidate.commands.map((c) => c.exitCode) : null,
    mainUntouched: sh(repo, 'rev-parse', 'refs/heads/main') === before.head && sh(repo, 'rev-parse', 'HEAD') === before.head,
    existingRefsUnchanged: beforeRefs.every((l) => afterRefs.includes(l)),
    unexpectedNewRefs: newRefs.filter((r) => !r.startsWith('refs/heads/lead-task/') && !r.startsWith('refs/heads/lead-integration/') && !r.startsWith('refs/lead/base/')),
    fsckOk: tryGit(repo, 'fsck', '--no-dangling') !== null,
    ownedProviderGroupsGone: backend.ownedPids().every((pid) => !groupAlive(pid)),
    serverStopped: (serverShutdown as { exited?: boolean }).exited === true,
    modelPermitsHeld: taskReports.flatMap((t) => t.leasesStillHeld),
    modelPermitFree: permitProbe.acquiredAfterRun,
  };
  const report = {
    at: new Date().toISOString(),
    objective: OBJECTIVE_ID,
    limits,
    elapsedMs,
    runError,
    lifecycle: { phase: lc.phase, result: lc.result, verdict: outcome?.verdict ?? null, reason: outcome?.reason ?? null, rounds: outcome?.rounds ?? null, stops: outcome?.stops ?? [], exitHint: outcome?.verdict ?? null },
    pinned: { ...pinnedRecord, specHash: pinned.oracle.specHash, pinnedAt: new Date(pinned.oracle.pinnedAt).toISOString() },
    tasks: taskReports,
    dag: { order: [TASK_A, TASK_B], integrationBranch: integrationRef, integrationTip: tip, base: baseRef, firstParentLog: tip ? tryGit(repo, 'log', '--first-parent', '--format=%H %s', `${baseRef ?? before.head}..${tip}`) : null },
    acceptance,
    backend: { ...backend.describe(), shutdown: serverShutdown },
    ledger,
    checks: { ...checks, ...(crashed ? { orphanProviderGroupsKilled: orphansKilled, crashedServerGone } : {}) },
    telemetry: summarizeTelemetry(taskReports),
    isolation: { enabled: isolated, mode: isolated ? 'allowlist' : 'none', denyRead, readAllow: readAllow ?? [], verifierDenyRead },
    chaos: chaosLog ? { ...chaosLog, orphansKilled, restartedBackend: restarted ? restarted.describe() : null } : null,
    audit: lifecycle.events(OBJECTIVE_ID),
    paths: { outDir, repo, oracleDir, pinned: join(pinnedDir, 'pinned-objective.json') },
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  return { outDir, report, outcome };
}

/**
 * What each model call is known to have cost, exactly as far as the CLI reported it: model identity, tokens, inference latency and
 * cost. A value nobody reported is the string `UNKNOWN`, never 0 and never an estimate. The Codex CLI reports token counts but neither
 * the model it chose (unless the operator pinned one with AGENTIC_CODEX_MODEL) nor a cost.
 */
export interface TelemetrySummary {
  perTask: { id: string; provider: string; model: string; inputTokens: number | 'UNKNOWN'; outputTokens: number | 'UNKNOWN'; inferenceMs: number | 'UNKNOWN'; activeMs: number | 'UNKNOWN'; costUsd: number | 'UNKNOWN' }[];
  totals: { inputTokens: number | 'UNKNOWN'; outputTokens: number | 'UNKNOWN'; inferenceMs: number | 'UNKNOWN'; costUsd: number | 'UNKNOWN'; models: string[] };
}
const known = (v: unknown): number | 'UNKNOWN' => (typeof v === 'number' && Number.isFinite(v) ? v : 'UNKNOWN');
const sumKnown = (vals: (number | 'UNKNOWN')[]): number | 'UNKNOWN' => (vals.length > 0 && vals.every((v) => typeof v === 'number') ? (vals as number[]).reduce((a, b) => a + b, 0) : 'UNKNOWN');
export function summarizeTelemetry(tasks: { id: string; activeMs: number | null; telemetry: (Record<string, any> | null)[] }[]): TelemetrySummary {
  const perTask: TelemetrySummary['perTask'] = tasks
    .filter((t) => t.telemetry.length > 0)
    .map((t) => {
      const calls = t.telemetry.map((x) => x ?? {});
      return {
        id: t.id,
        provider: String(calls[0].provider ?? 'UNKNOWN'),
        model: String(calls[0].model ?? 'UNKNOWN'),
        inputTokens: sumKnown(calls.map((c) => known(c.usage?.inputTokens))),
        outputTokens: sumKnown(calls.map((c) => known(c.usage?.outputTokens))),
        inferenceMs: sumKnown(calls.map((c) => known(c.inferenceMs))),
        activeMs: t.activeMs ?? 'UNKNOWN',
        costUsd: sumKnown(calls.map((c) => known(c.usage?.costUsd))),
      };
    });
  return {
    perTask,
    totals: {
      inputTokens: sumKnown(perTask.map((t) => t.inputTokens)),
      outputTokens: sumKnown(perTask.map((t) => t.outputTokens)),
      inferenceMs: sumKnown(perTask.map((t) => t.inferenceMs)),
      costUsd: sumKnown(perTask.map((t) => t.costUsd)),
      models: [...new Set(perTask.map((t) => t.model))],
    },
  };
}

/** Free, local, no model call: everything that must hold before the first Codex invocation. Returns the problems found (empty = go). */
export async function preflightProblems(options: { codex?: CodexConfig; isolation?: boolean }): Promise<string[]> {
  const problems: string[] = [];
  const { codexEntry } = await import('../../src/workers/providers/codex.ts');
  const availability = await codexEntry(options.codex ?? {}).probe();
  if (availability.state !== 'available') problems.push(`Codex is ${availability.state}: ${availability.detail}`);
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
  } catch {
    problems.push('`go` is not on PATH; the runtime verifier needs it');
  }
  const probeDir = join(findProjectRoot() ?? process.cwd(), '.workdir');
  mkdirSync(probeDir, { recursive: true });
  const sandboxed = await runSandboxedCommand('go', ['version'], { cwd: probeDir, root: probeDir, timeoutMs: 60_000 });
  problems.push(...(await verifierSandboxProblems()));
  if (options.isolation !== false) problems.push(...(await readIsolationProblems({ command: options.codex?.command })));
  if (sandboxed.exitCode !== 0) problems.push(`the OS sandbox cannot run the Go toolchain (exit ${sandboxed.exitCode}): ${sandboxed.stderr.slice(0, 200)}; verification would fail closed`);
  return problems;
}

/** The report's own judgement, so the verdict never rests on how a run felt: every condition of the acceptance, each from evidence. */
export function judge(report: Record<string, any>): { verdict: 'M8_5_REAL_OBJECTIVE_ACCEPTED' | 'M8_5_REAL_OBJECTIVE_FAILED' | 'M8_5_REAL_OBJECTIVE_INCONCLUSIVE'; why: string[] } {
  const c = report.checks;
  const accepted = report.lifecycle.phase === 'ACCEPTED';
  const hard: [boolean, string][] = [
    [c.codexInvocationsWithinTotal, 'Codex invocations within the total bound'],
    [c.codexInvocationsWithinPerTask, 'Codex invocations within the per-task bound'],
    [c.claimsWithinBound, 'claims within bound'],
    [c.noCorrectionTasks, 'no repair task was created'],
    [c.noRuntimeRetries, 'no runtime retry'],
    [c.oracleHashUnchangedOnDisk, 'oracle files unchanged on disk'],
    [c.mainUntouched, 'main and the checkout untouched'],
    [c.existingRefsUnchanged, 'pre-existing refs unchanged'],
    [c.unexpectedNewRefs.length === 0, 'no unexpected new refs'],
    [c.fsckOk, 'git fsck clean'],
    [c.ownedProviderGroupsGone, 'every Codex process group is gone'],
    [c.serverStopped, 'the dedicated Mastra server exited'],
    [c.modelPermitsHeld.length === 0 && c.modelPermitFree === true, 'no model permit is held (and the Codex permit can be taken)'],
  ];
  const broken = hard.filter(([ok]) => !ok).map(([, what]) => `VIOLATED: ${what}`);
  if (accepted) {
    const acceptance: [boolean | null, string][] = [
      [c.oracleHashInAcceptance, 'oracle hash verified by acceptance'],
      [c.oraclePinnedBeforeFirstClaim, 'oracle pinned before the first claim'],
      [c.tipMatchesRepository, 'candidate commit is the integration tip'],
      [c.negativeControlOnPinnedBase, 'negative control ran on the pinned base'],
      [Array.isArray(c.candidateExitCodes) && c.candidateExitCodes.every((x: unknown) => x === 0), 'candidate exit codes all 0'],
      [Array.isArray(c.negativeControlExitCodes) && c.negativeControlExitCodes.some((x: unknown) => typeof x === 'number' && x !== 0), 'negative control failed with a real exit code'],
    ];
    broken.push(...acceptance.filter(([ok]) => ok !== true).map(([, what]) => `NOT VERIFIED: ${what}`));
    return broken.length === 0 ? { verdict: 'M8_5_REAL_OBJECTIVE_ACCEPTED', why: ['lifecycle ACCEPTED and every evidence check holds'] } : { verdict: 'M8_5_REAL_OBJECTIVE_INCONCLUSIVE', why: broken };
  }
  if (report.lifecycle.phase === 'NOT_ACCEPTED' && broken.length === 0) return { verdict: 'M8_5_REAL_OBJECTIVE_FAILED', why: [`the pinned oracle decided NOT_ACCEPTED (${report.lifecycle.reason})`] };
  return { verdict: 'M8_5_REAL_OBJECTIVE_INCONCLUSIVE', why: [`lifecycle ended ${report.lifecycle.phase}${report.lifecycle.reason ? ` (${report.lifecycle.reason})` : ''}`, ...(report.lifecycle.stops ?? []), ...broken] };
}

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findProjectRoot } from '../../src/core/paths.ts';
import { createInProcessExecutor } from '../../src/integrations/mastra/__testing__/in-process-executor.ts';
import { createCodingTaskWorkflow } from '../../src/integrations/mastra/workflows/coding-task-workflow.ts';
import { capacityFor } from '../../src/runtime/capacity/model-capacity.ts';
import { Scheduler } from '../../src/runtime/scheduler/scheduler.ts';
import { SchedulerStore } from '../../src/runtime/scheduler/store.ts';
import { WorktreeManager } from '../../src/runtime/worktree/worktree.ts';
import { codexEntry, type CodexConfig } from '../../src/workers/providers/codex.ts';
import { ProviderRegistry } from '../../src/workers/providers/registry.ts';

/**
 * One task through the real scheduler on a disposable Go repository:
 *
 *   task request (provider: codex) -> Scheduler (operator allow-list) -> workflow -> Codex adapter -> isolated worktree
 *   -> runtime verifier (sandboxed `go test`) -> REVIEW_PENDING
 *
 * The same code runs against the mock CLI in CI (tests) and against the real Codex CLI in the opt-in smoke. The in-process
 * executor stands in for the HTTP hop to a Mastra server (covered by client tests); everything else is the production path.
 */

export const TASK_ID = 'smoke-double';
const STUB = '// Package smoke holds the disposable smoke-test fixture.\npackage smoke\n\n// Double returns n multiplied by two.\nfunc Double(n int) int {\n\treturn 0\n}\n';
const TEST_SRC = 'package smoke\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tfor in, want := range map[int]int{0: 0, 3: 6, -4: -8} {\n\t\tif got := Double(in); got != want {\n\t\t\tt.Fatalf("Double(%d) = %d, want %d", in, got, want)\n\t\t}\n\t}\n}\n';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 's@s' } }).trim();

export interface SmokeOptions {
  codex: CodexConfig;
  /** Directory for the fixture, state and report. Default: .workdir/m8.2-smoke/<timestamp>. */
  outDir?: string;
  modelTimeoutMs?: number;
}

export async function runSchedulerSmoke(options: SmokeOptions) {
  const outDir = options.outDir ?? join(findProjectRoot() ?? process.cwd(), '.workdir', 'm8.2-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outDir, { recursive: true });
  const repo = mkdtempSync(join(outDir, 'repo-'));
  for (const [path, content] of Object.entries({ 'go.mod': 'module example.com/smoke\n\ngo 1.22\n', 'smoke/double.go': STUB, 'smoke/double_test.go': TEST_SRC, 'README.md': '# smoke fixture\n' })) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'fixture');
  const refs = () => sh(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
  const before = { head: sh(repo, 'rev-parse', 'HEAD'), refs: refs() };

  const modelTimeoutMs = options.modelTimeoutMs ?? 300_000;
  const providers = new ProviderRegistry().register(codexEntry(options.codex));
  const workflow = createCodingTaskWorkflow({ providers, allowProviders: () => [`codex:${TASK_ID}`], artifactRoot: join(outDir, 'artifacts'), runOptions: { modelTimeoutMs, runtimeRetryDelayMs: 0 } });
  const executor = createInProcessExecutor(workflow);
  const store = new SchedulerStore(join(outDir, 'scheduler.db'));
  store.createBatch({
    batchId: 'smoke',
    project: 'smoke',
    repository: repo,
    description: 'Codex scheduler smoke',
    integrationCommands: [],
    tasks: [
      {
        id: TASK_ID,
        title: 'Implement Double',
        priority: 50,
        executor: 'worker',
        maxClaims: 1,
        request: {
          contract: {
            taskId: TASK_ID,
            objective: 'Implement Double in smoke/double.go so that Double(n) returns n * 2. Keep the existing comments.',
            allowedFiles: ['smoke/double.go'],
            contextFiles: ['smoke/double_test.go'],
            acceptanceCriteria: ['TestDouble passes'],
            verificationCommands: [['go', 'test', '-count=1', './...']],
            constraints: ['tests are immutable'],
          },
          assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one function with an existing test' },
          provider: 'codex',
        },
      },
    ],
  } as never);
  store.promote();

  const scheduler = new Scheduler({
    store,
    executor,
    workspace: new WorktreeManager(join(outDir, 'worktrees')),
    capacity: capacityFor(),
    allowProviders: [`codex:${TASK_ID}`],
    config: { maxConcurrentWorkers: 1, pollMs: 500, workerLeaseTimeoutMs: 60_000, taskTimeoutMs: modelTimeoutMs + 120_000, maxCapacityWaitMs: 60_000 },
    log: (l) => console.log(`  ${l}`),
  });
  const started = Date.now();
  const summary = await scheduler.run();
  const elapsedMs = Date.now() - started;

  const task = store.requireTask(TASK_ID);
  const worktree = task.worktreePath ?? undefined;
  const artifactDir = typeof task.artifacts.artifactDir === 'string' ? task.artifacts.artifactDir : undefined;
  const attempts = artifactDir ? (JSON.parse(readFileSync(join(artifactDir, 'attempts.json'), 'utf8')) as Record<string, any>[]) : [];
  const afterRefs = refs();
  const beforeLines = new Set(before.refs.split('\n'));
  const newRefs = afterRefs.split('\n').filter((l) => !beforeLines.has(l)).map((l) => l.split(' ')[0]);
  const report = {
    at: new Date().toISOString(),
    taskState: task.state,
    failureCategory: task.failureCategory,
    stateReason: task.stateReason,
    claims: task.claims,
    requeued: summary.requeued,
    stillActive: summary.stillActive,
    elapsedMs,
    codingAttempts: attempts.length,
    runtimeRetries: attempts.reduce((n, a) => n + (a.runtimeRetries ?? 0), 0),
    telemetry: attempts.map((a) => a.telemetry ?? null),
    verifier: attempts.map((a) => a.verification && { command: a.verification.command, exitCode: a.verification.exitCode }),
    filesMutated: attempts.map((a) => a.filesMutated),
    forbiddenFiles: attempts.map((a) => a.forbiddenFiles),
    git: {
      sourceHeadUnchanged: sh(repo, 'rev-parse', 'HEAD') === before.head,
      sourceStatusClean: sh(repo, 'status', '--porcelain') === '',
      // refs that existed before must be exactly as they were; the only new refs are the ones the runtime itself creates
      existingRefsUnchanged: [...beforeLines].every((l) => afterRefs.split('\n').includes(l)),
      newRefs,
      unexpectedNewRefs: newRefs.filter((r) => r !== `refs/heads/${task.branch}` && !r.startsWith('refs/heads/lead-integration/') && !r.startsWith('refs/lead/base/')),
      fsckOk: (() => {
        try {
          sh(repo, 'fsck', '--no-dangling');
          return true;
        } catch {
          return false;
        }
      })(),
      worktreeStatus: worktree ? sh(worktree, 'status', '--porcelain') : null,
    },
    commentsKept: worktree ? ['Package smoke holds', 'Double returns n multiplied by two'].map((c) => readFileSync(join(worktree, 'smoke/double.go'), 'utf8').includes(c)) : null,
    diffOfTaskCommit: task.headCommit ? sh(repo, 'show', '--format=', task.headCommit) : null,
    paths: { outDir, repo, worktree, artifactDir },
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  return { report, store, outDir, repo };
}

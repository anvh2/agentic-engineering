import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CommandRunner } from '../../../runtime/integration/integrate.ts';
import { Scheduler, type Executor, type ExecutorInput, type ExecutorOutcome } from '../../../runtime/scheduler/scheduler.ts';
import type { SchedulerStore } from '../../../runtime/scheduler/store.ts';
import { git, makeStore, tempDir } from '../../../runtime/scheduler/test-helpers.ts';
import type { TaskSpecInput } from '../../../runtime/scheduler/types.ts';
import { WorktreeManager } from '../../../runtime/worktree/worktree.ts';
import type { ProviderBudgetEntry } from '../../../runtime/execution/provider-routing.ts';
import type { ProviderDescriptor } from '../../../runtime/execution/worker-provider.ts';
import { codexDescriptor } from '../../../workers/providers/codex.ts';
import type { LifecycleDeps, LifecycleHooks } from '../driver.ts';
import { pinOracle, type OracleSpecInput } from '../oracle.ts';
import { LifecycleStore } from '../store.ts';

/**
 * A complete disposable objective: a tiny Go module ("fmtkit"), a deterministic fake coding provider that writes files into the
 * task worktree and reports whatever the test scripts (including a false PASS), the real `go` toolchain as the verifier, and an
 * independent objective oracle in a directory outside the repository.
 *
 *   pad       PadLeft   (no dependencies)
 *   title     Title     (no dependencies)
 *   describe  Describe  (depends on pad and title; its task test only passes if both are already integrated)
 */

export const GOOD = {
  pad: `package fmtkit

import "strings"

// PadLeft pads s on the left with spaces to width.
func PadLeft(s string, width int) string {
	n := len([]rune(s))
	if n >= width {
		return s
	}
	return strings.Repeat(" ", width-n) + s
}
`,
  // passes the task's own (ASCII) test but counts bytes, so the objective oracle's non-ASCII case fails
  padBytes: `package fmtkit

import "strings"

// PadLeft pads s on the left with spaces to width.
func PadLeft(s string, width int) string {
	n := len(s)
	if n >= width {
		return s
	}
	return strings.Repeat(" ", width-n) + s
}
`,
  // compiles and is wrong: never pads
  padWrong: `package fmtkit

// PadLeft pads s on the left with spaces to width.
func PadLeft(s string, width int) string {
	return s
}
`,
  title: `package fmtkit

import "strings"

// Title upper-cases the first letter of every space-separated word.
func Title(s string) string {
	words := strings.Split(s, " ")
	for i, w := range words {
		if w == "" {
			continue
		}
		r := []rune(w)
		words[i] = strings.ToUpper(string(r[0])) + string(r[1:])
	}
	return strings.Join(words, " ")
}
`,
  describe: `package fmtkit

import "fmt"

// Describe renders a name and a count as "<padded title>|<count>".
func Describe(name string, n int) string {
	return fmt.Sprintf("%s|%d", PadLeft(Title(name), 8), n)
}
`,
} as const;

const STUBS: Record<string, string> = {
  'go.mod': 'module example.com/fmtkit\n\ngo 1.22\n',
  'pad.go': 'package fmtkit\n\n// PadLeft pads s on the left with spaces to width.\nfunc PadLeft(s string, width int) string {\n\treturn "" // TODO\n}\n',
  'title.go': 'package fmtkit\n\n// Title upper-cases the first letter of every space-separated word.\nfunc Title(s string) string {\n\treturn "" // TODO\n}\n',
  'describe.go': 'package fmtkit\n\n// Describe renders a name and a count as "<padded title>|<count>".\nfunc Describe(name string, n int) string {\n\treturn "" // TODO\n}\n',
  'README.md': '# fmtkit\n',
};

/** The runtime-owned test each task is verified with (never shown to the worker). */
export const TASK_TESTS = {
  pad: { path: 'pad_oracle_test.go', content: 'package fmtkit\n\nimport "testing"\n\nfunc TestPadLeft(t *testing.T) {\n\tif got := PadLeft("ab", 5); got != "   ab" {\n\t\tt.Fatalf("PadLeft(ab,5)=%q", got)\n\t}\n\tif got := PadLeft("abcdef", 3); got != "abcdef" {\n\t\tt.Fatalf("PadLeft(abcdef,3)=%q", got)\n\t}\n}\n' },
  title: { path: 'title_oracle_test.go', content: 'package fmtkit\n\nimport "testing"\n\nfunc TestTitle(t *testing.T) {\n\tif got := Title("hello world"); got != "Hello World" {\n\t\tt.Fatalf("Title=%q", got)\n\t}\n}\n' },
  describe: { path: 'describe_oracle_test.go', content: 'package fmtkit\n\nimport "testing"\n\nfunc TestDescribe(t *testing.T) {\n\tif got := Describe("ab", 3); got != "      Ab|3" {\n\t\tt.Fatalf("Describe=%q", got)\n\t}\n}\n' },
} as const;

/** The independent objective oracle. Its non-ASCII case is what separates `padBytes` from `pad`. */
export const OBJECTIVE_ORACLE = `package fmtkit

import "testing"

func TestObjectiveAcceptance(t *testing.T) {
	cases := []struct{ got, want string }{
		{PadLeft("é", 3), "  é"},
		{PadLeft("abc", 2), "abc"},
		{Title("go is fun"), "Go Is Fun"},
		{Title(""), ""},
		{Describe("go", 7), "      Go|7"},
	}
	for i, c := range cases {
		if c.got != c.want {
			t.Fatalf("case %d: got %q want %q", i, c.got, c.want)
		}
	}
}
`;

/** An oracle that passes on the untouched stubs too: it proves nothing, and the negative control must say so. */
export const VACUOUS_ORACLE = 'package fmtkit\n\nimport "testing"\n\nfunc TestVacuous(t *testing.T) {}\n';

export function goRepo(): string {
  const dir = tempDir('lc-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(STUBS)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const GO_CACHE = join(tmpdir(), 'agentic-lifecycle-test-gocache');

/** Runs the real toolchain, unsandboxed (the sandbox itself is covered separately), with an offline, hermetic environment. */
export const goRunner: CommandRunner = (command, cwd) =>
  new Promise((resolve) => {
    execFile(command[0], command.slice(1), { cwd, timeout: 180_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GOCACHE: GO_CACHE, GOPROXY: 'off', GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOFLAGS: '-mod=mod' } }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({ exitCode: e ? (typeof e.code === 'number' ? e.code : null) : 0, output: `${stdout}${stderr}`, timedOut: Boolean(e?.killed) });
    });
  });

export function goTask(id: string, opts: { file: string; test: { path: string; content: string }; dependsOn?: string[]; provider?: string; priority?: number }): TaskSpecInput {
  return {
    id,
    title: `Implement ${id}`,
    priority: opts.priority ?? 50,
    executor: 'worker',
    dependsOn: opts.dependsOn ?? [],
    request: {
      contract: {
        taskId: id,
        objective: `implement ${opts.file}`,
        allowedFiles: [opts.file],
        contextFiles: [],
        acceptanceCriteria: [`${opts.file} satisfies its tests`],
        verificationCommands: [['go', 'test', './...']],
        constraints: ['tests are immutable'],
        hiddenFiles: { [opts.test.path]: opts.test.content },
      },
      assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'bounded' },
      ...(opts.provider ? { provider: opts.provider } : {}),
    },
  } as TaskSpecInput;
}

export function standardTasks(provider?: Partial<Record<'pad' | 'title' | 'describe', string>>): TaskSpecInput[] {
  return [
    goTask('pad', { file: 'pad.go', test: TASK_TESTS.pad, provider: provider?.pad }),
    goTask('title', { file: 'title.go', test: TASK_TESTS.title, provider: provider?.title }),
    goTask('describe', { file: 'describe.go', test: TASK_TESTS.describe, dependsOn: ['pad', 'title'], provider: provider?.describe }),
  ];
}

const FILE_OF: Record<string, string> = { pad: 'pad.go', title: 'title.go', describe: 'describe.go' };
const rootOf = (id: string) => id.replace(/-fix\d+$/, '');

export interface ProviderCall {
  taskId: string;
  attempt: number;
  epoch: number;
  /** What the worktree already contained when the provider started (to prove dependency ordering). */
  sawFiles: Record<string, string>;
}

/**
 * The fake coding provider. `solutions[root]` lists the file content written on the 1st, 2nd... call for that root task (a
 * correction counts as the next call). It ALWAYS reports a runtime PASS with a passing verifier, true or not: the lifecycle must
 * not take its word for it.
 */
export function fakeProvider(solutions: Record<string, (string | 'noop')[]>, hooks: { onCall?: (call: ProviderCall, input: ExecutorInput) => void | Promise<void>; outcome?: (call: ProviderCall) => Partial<ExecutorOutcome> | undefined } = {}) {
  const calls: ProviderCall[] = [];
  const executor: Executor & { calls: ProviderCall[] } = {
    calls,
    async run(input) {
      const root = rootOf(input.task.id);
      const attempt = calls.filter((c) => rootOf(c.taskId) === root).length;
      const sawFiles: Record<string, string> = {};
      for (const f of Object.values(FILE_OF)) {
        try {
          sawFiles[f] = readFileSync(join(input.repository, f), 'utf8');
        } catch {
          /* absent */
        }
      }
      const call: ProviderCall = { taskId: input.task.id, attempt, epoch: input.task.claimEpoch, sawFiles };
      calls.push(call);
      const runId = `run-${input.task.id}-${attempt}`;
      input.onRunStart({ runId });
      await hooks.onCall?.(call, input);
      const content = (solutions[root] ?? [])[Math.min(attempt, (solutions[root] ?? []).length - 1)];
      if (content && content !== 'noop') writeFileSync(join(input.repository, FILE_OF[root]), content);
      return { runId, status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0, verifier: { command: ['go', 'test', './...'], exitCode: 0 }, ...hooks.outcome?.(call) };
    },
  };
  return executor;
}

export interface Harness {
  repo: string;
  store: SchedulerStore;
  lifecycle: LifecycleStore;
  worktrees: WorktreeManager;
  scheduler: Scheduler;
  provider: ReturnType<typeof fakeProvider>;
  oracleDir: string;
  deps: LifecycleDeps;
  hooks: LifecycleHooks;
  pin(spec?: Partial<OracleSpecInput>): Promise<void>;
}

/** The free local default as a production registry describes it (no Ollama is contacted). */
const OLLAMA: ProviderDescriptor = { identity: { id: 'ollama', kind: 'local', model: 'qwen3:8b' }, capabilities: { taskTypes: ['go', 'js'], editsFiles: 'via-runtime-tools', fileScope: 'tool-enforced', cancellation: 'abort-signal', usage: 'tokens', billing: 'local-free' }, capacity: { resource: 'ollama', defaultPermits: 1 } };

export function harness(options: { solutions: Record<string, (string | 'noop')[]>; tasks?: TaskSpecInput[]; oracle?: string; allowProviders?: string[]; providerBudgets?: ProviderBudgetEntry[]; maxReviewCorrections?: number; provider?: Parameters<typeof fakeProvider>[1]; objectiveId?: string; negativeControl?: OracleSpecInput['negativeControl'] }): Harness {
  const objectiveId = options.objectiveId ?? 'obj1';
  const repo = goRepo();
  const store = makeStore();
  const lifecycle = new LifecycleStore(store);
  const worktrees = new WorktreeManager(join(tempDir('lc-wt-'), 'worktrees'));
  const provider = fakeProvider(options.solutions, options.provider);
  const scheduler = new Scheduler({ store, executor: provider, workspace: worktrees, config: { pollMs: 20, maxTasksPerBatch: 8, maxReviewCorrections: options.maxReviewCorrections ?? 2 },
    allowProviders: options.allowProviders,
    // The operator budget mirrors the allow-list here, so these tests exercise the lifecycle's own authorization gates.
    providerBudgets: options.providerBudgets ?? (options.allowProviders ?? []).map((entry) => ({ provider: entry.split(':')[0], claims: 10 })),
    describeProvider: (id) => (id === 'codex' ? codexDescriptor() : id === 'ollama' ? OLLAMA : undefined),
  });
  store.createBatch({ batchId: objectiveId, project: 'fmtkit', repository: repo, description: 'lifecycle fixture', integrationCommands: [['go', 'vet', './...']], tasks: options.tasks ?? standardTasks() });
  store.promote();
  const oracleDir = tempDir('lc-oracle-');
  writeFileSync(join(oracleDir, 'acceptance_test.go'), options.oracle ?? OBJECTIVE_ORACLE);
  const hooks: LifecycleHooks = {};
  const deps: LifecycleDeps = { store, worktrees, lifecycle, scheduler, run: goRunner, config: { maxReviewCorrections: options.maxReviewCorrections ?? 2 }, hooks, maxRounds: 12 };
  return {
    repo,
    store,
    lifecycle,
    worktrees,
    scheduler,
    provider,
    oracleDir,
    deps,
    hooks,
    async pin(spec = {}) {
      await pinOracle({ store, lifecycle, worktrees }, { objectiveId, batchId: objectiveId, actor: 'test', spec: { dir: oracleDir, files: ['acceptance_test.go'], commands: [['go', 'vet', './...'], ['go', 'test', '-count=1', './...']], negativeControl: options.negativeControl, ...spec } });
    },
  };
}

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Executor, ExecutorInput, ExecutorOutcome } from './scheduler.ts';
import { SchedulerStore } from './store.ts';
import type { BatchPlanInput, TaskSpecInput } from './types.ts';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

export function tempDir(prefix = 'sched-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A real git repo with one commit containing `files` (path -> content). */
export function makeRepo(files: Record<string, string> = {}): string {
  const dir = tempDir('sched-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  const all = { 'README.md': '# repo\n', ...files };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function makeStore(now?: () => number): SchedulerStore {
  return new SchedulerStore(join(tempDir('sched-db-'), 'sched.db'), { now });
}

export function workerTask(id: string, overrides: Partial<TaskSpecInput> & { files?: string[]; dependsOn?: string[] } = {}): TaskSpecInput {
  const files = overrides.files ?? [`src/${id}.js`];
  const { files: _files, ...rest } = overrides;
  return {
    id,
    title: `Task ${id}`,
    priority: 50,
    executor: 'worker',
    request: {
      contract: {
        taskId: id,
        objective: `implement ${id}`,
        allowedFiles: files,
        contextFiles: [],
        acceptanceCriteria: ['works'],
        verificationCommands: [['npx', '--no-install', 'jest', '--runInBand', `tests/${id}.test.js`]],
        constraints: ['tests are immutable'],
        hiddenFiles: { [`tests/${id}.test.js`]: 'test("x",()=>{})\n' },
      },
      assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'bounded' },
    },
    ...rest,
  } as TaskSpecInput;
}

export function plan(repository: string, tasks: TaskSpecInput[], extra: Partial<BatchPlanInput> = {}): BatchPlanInput {
  return { batchId: 'B1', project: 'proj', repository, description: 'test batch', integrationCommands: [], tasks, ...extra };
}

export interface FakeExecutorOptions {
  /** Per-task behavior override. */
  behavior?: (input: ExecutorInput, n: number) => Promise<ExecutorOutcome | undefined> | ExecutorOutcome | undefined;
  /** Awaited before returning (lets tests hold tasks in flight to measure concurrency). */
  gate?: (input: ExecutorInput) => Promise<void>;
  content?: (taskId: string) => string;
}

/** Writes `module.exports = "<id>";` to the task's allowed file inside its worktree and reports a harness PASS. */
export function fakeExecutor(options: FakeExecutorOptions = {}) {
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  const executor: Executor & { calls: string[]; peak: () => number } = {
    calls,
    peak: () => peak,
    async run(input) {
      const id = input.task.id;
      calls.push(id);
      active++;
      peak = Math.max(peak, active);
      try {
        const runId = `run-${id}-${calls.filter((c) => c === id).length}`;
        input.onRunStart({ runId });
        await options.gate?.(input);
        const custom = await options.behavior?.(input, calls.filter((c) => c === id).length);
        if (custom) return { runId, ...custom };
        for (const file of input.task.spec.request!.contract.allowedFiles) {
          mkdirSync(dirname(join(input.repository, file)), { recursive: true });
          writeFileSync(join(input.repository, file), options.content?.(id) ?? `module.exports = "${id}";\n`);
        }
        return { runId, status: 'PASS', reasons: [], codingAttempts: 1, runtimeRetries: 0, verifier: { command: ['npx', 'jest'], exitCode: 0 } };
      } finally {
        active--;
      }
    },
  };
  return executor;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

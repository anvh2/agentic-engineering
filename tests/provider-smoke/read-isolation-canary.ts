import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexArgs } from '../../src/workers/providers/codex.ts';
import { startStubModel } from './stub-model-server.ts';

/**
 * Does the REAL codex CLI, launched with the arguments the adapter builds, stop a model-issued command from reading a denied path?
 * Free and local: the "model" is a stub on 127.0.0.1 that tells the CLI to run one shell command. It exists because the answer is
 * not obvious and not stable: on codex-cli 0.161.0 the permission profile is silently IGNORED when `--sandbox` is also given, and a
 * newer CLI could change that again. The oracle's secrecy therefore rests on this check, run before any real objective.
 */

export interface CanaryResult {
  /** The model-issued `cat` returned the canary text. */
  readable: boolean;
  /** The command's own write inside the worktree worked (the sandbox is not simply refusing everything). */
  worktreeWritable: boolean;
  /** A write outside the worktree and the temp dirs was refused. */
  outsideWriteBlocked: boolean;
  /** A write into the worktree's `.git` (a hook, a ref) was refused: the isolation profile keeps what `workspace-write` protects. */
  gitWriteBlocked: boolean;
  exitCode: number | null;
  output: string;
  detail: string;
}

export async function readIsolationCanary(options: { command?: string; deny: boolean; timeoutMs?: number }): Promise<CanaryResult> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-canary-')));
  const secretDir = join(base, 'secret');
  const outside = join(base, 'outside');
  const work = join(base, 'work');
  const marker = `CANARY-${Math.random().toString(36).slice(2)}`;
  for (const d of [secretDir, outside, work]) mkdirSync(d);
  writeFileSync(join(secretDir, 'canary.txt'), `${marker}\n`);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'c', GIT_AUTHOR_EMAIL: 'c@c', GIT_COMMITTER_NAME: 'c', GIT_COMMITTER_EMAIL: 'c@c' } });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const stub = await startStubModel(`cat '${secretDir}/canary.txt'; echo "cat-rc=$?"; echo ok > in-worktree.txt && echo worktree-write-ok; echo leak > '${outside}/leak.txt'; echo "outside-rc=$?"; echo x > .git/hooks/canary-hook; echo "git-rc=$?"`);
  try {
    const args = buildCodexArgs(work, { json: true, denyReadPaths: options.deny ? [secretDir] : undefined });
    const dash = args.lastIndexOf('-');
    const full = [...args.slice(0, dash), ...stub.codexArgs, '-'];
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) };
    const exit = await new Promise<number | null>((resolve) => {
      const child = spawn(options.command ?? 'codex', full, { cwd: work, env, stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 90_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.on('error', () => resolve(null));
      child.stdin.end('run the command\n');
    });
    const output = stub.outputs().join('\n');
    const result: CanaryResult = {
      readable: output.includes(marker),
      worktreeWritable: output.includes('worktree-write-ok'),
      outsideWriteBlocked: /outside-rc=[1-9]/.test(output),
      gitWriteBlocked: /git-rc=[1-9]/.test(output),
      exitCode: exit,
      output: output.replaceAll(marker, '<canary>').slice(0, 600),
      detail: '',
    };
    result.detail = stub.outputs().length === 0 ? 'the CLI never ran the command (no tool output reached the stub)' : '';
    return result;
  } finally {
    await stub.close();
    rmSync(base, { recursive: true, force: true });
  }
}

/** Preflight form: the problems found, empty when the CLI provably denies the read while still letting the worktree be written. */
export async function readIsolationProblems(options: { command?: string }): Promise<string[]> {
  const r = await readIsolationCanary({ command: options.command, deny: true });
  const problems: string[] = [];
  if (r.detail) problems.push(`read-isolation canary: ${r.detail} (exit ${r.exitCode})`);
  else {
    if (r.readable) problems.push('read-isolation canary: a model-issued command READ a path the adapter asked to deny; this CLI does not enforce denyReadPaths');
    if (!r.worktreeWritable) problems.push('read-isolation canary: the worktree was not writable under the isolation profile; the worker could not work');
    if (!r.outsideWriteBlocked) problems.push('read-isolation canary: a write outside the worktree was not blocked');
    if (!r.gitWriteBlocked) problems.push('read-isolation canary: a write into .git was not blocked (hooks could be planted)');
  }
  return problems;
}

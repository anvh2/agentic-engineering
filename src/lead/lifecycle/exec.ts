import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { CommandRunner } from '../../runtime/integration/integrate.ts';
import { runSandboxedCommand } from '../../runtime/sandbox/sandbox.ts';

/** Shared plumbing for the objective lifecycle: hashing, the sandboxed command runner, a policy for argv, and tree export. */

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Deterministic JSON (sorted keys) so a hash over a record does not depend on property order. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sort(x)]));
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Production runner: every command that executes worker-written code runs under the OS sandbox (fails closed: exitCode null). */
export function sandboxRunner(timeoutMs = 300_000): CommandRunner {
  return async (command, cwd) => {
    const r = await runSandboxedCommand(command[0], command.slice(1), { cwd, root: cwd, timeoutMs });
    return { exitCode: r.exitCode, output: `${r.stdout}${r.stderr}`, timedOut: r.timedOut };
  };
}

/** A command result that proves nothing either way (never started, timed out, sandbox unavailable). */
export const isInconclusive = (r: { exitCode: number | null; timedOut: boolean }): boolean => r.exitCode === null || r.timedOut;

const GO_SUBCOMMANDS = new Set(['test', 'vet', 'build']);
const NODE_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print', '--input-type']);

/**
 * What a lifecycle-run command may be. The lifecycle runs argv (never a shell) of toolchain binaries only; `npx` must not
 * install, `node` runs a file, never an expression, `go` is limited to compile/test/vet. Anything else is refused before it runs.
 */
export function commandPolicyProblems(command: string[]): string[] {
  const [bin, ...args] = command;
  if (!bin) return ['empty command'];
  if (bin === 'gofmt') return [];
  if (bin === 'go') return GO_SUBCOMMANDS.has(args[0] ?? '') ? [] : [`go ${args[0] ?? ''}: only ${[...GO_SUBCOMMANDS].join('/')} are allowed`];
  if (bin === 'npx') return args.includes('--no-install') ? [] : ['npx must run with --no-install'];
  if (bin === 'node') return args.some((a) => NODE_EVAL_FLAGS.has(a)) ? ['node must run a file, not an expression'] : [];
  return [`binary "${bin}" is not allow-listed`];
}

const run = (file: string, args: string[], cwd?: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }, (err, _out, stderr) => (err ? reject(new Error(`${file} ${args.join(' ')} failed: ${(stderr || err.message).trim().slice(0, 300)}`)) : resolve()));
  });

/** A throwaway copy of `commit`'s tree (`git archive`): no .git, no worker-owned state, nothing shared with a worktree. */
export async function exportCommit(repository: string, commit: string, prefix: string): Promise<{ dir: string; tree: string; dispose(): Promise<void> }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const tree = join(dir, 'tree');
  try {
    await mkdir(tree);
    const tar = join(dir, 'src.tar');
    await run('git', ['archive', '--format=tar', '-o', tar, commit], repository);
    await run('tar', ['-xf', tar, '-C', tree]);
    await rm(tar, { force: true });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, tree, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Dependency directories a batch shares with its source repository (node_modules...), linked into an export the same way the
 * worktree manager links them into a task worktree, so a JS verifier or oracle sees the same installed dependencies the worker did.
 * Read-only use: the sandbox forbids writes to node_modules.
 */
export async function linkDependencyPaths(repository: string, tree: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    if (isAbsolute(p) || p.split('/').includes('..')) throw new Error(`linkPath ${p} must be repo-relative without ..`);
    const source = join(repository, p);
    const dest = join(tree, p);
    if (!existsSync(source) || (await lstat(dest).catch(() => undefined))) continue;
    await mkdir(dirname(dest), { recursive: true });
    await symlink(source, dest);
  }
}

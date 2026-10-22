import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { findProjectRoot, isProjectManifest } from '../../core/paths.ts';

/**
 * Paths a coding worker may never be given when the target repository is this runtime itself (self-development).
 *
 * A worker proposes and only the runtime verifier can produce PASS; that holds only while the worker cannot edit the
 * runtime that judges it. These prefixes cover the gates (scheduler, sandbox, delegation, verifier, review, integration,
 * model registry, council), the worker and its tools, the oracles and fixtures, the agent pack that grants tools, CI and
 * the manifests that decide what runs. Enabling a language adapter never shrinks this list; changing it is an
 * authorization change for a human, like enabling the adapter.
 *
 * Matching is case-insensitive (the default macOS filesystem is) and by whole path segment, on the literal path and on
 * the path with its parent directory's symlinks resolved, so an alias directory cannot reach a protected file.
 */
export const NON_DELEGATABLE_PREFIXES: readonly string[] = Object.freeze([
  'src/', 'tests/', 'scripts/', 'engineering/', 'docs/audits/', '.github/', '.claude/', '.workdir/',
]);
export const NON_DELEGATABLE_FILES: readonly string[] = Object.freeze([
  'package.json', 'package-lock.json', 'tsconfig.json', 'AGENTS.md', 'CLAUDE.md', '.gitignore',
]);

const norm = (p: string): string => p.split(/[\\/]+/).filter((s) => s && s !== '.').join('/').toLowerCase();

function matches(repoRelative: string): string | undefined {
  const p = norm(repoRelative);
  const prefix = NON_DELEGATABLE_PREFIXES.find((d) => p === d.slice(0, -1).toLowerCase() || p.startsWith(d.toLowerCase()));
  if (prefix) return prefix;
  return NON_DELEGATABLE_FILES.find((f) => p === f.toLowerCase());
}

/**
 * The root of this runtime's checkout when `repoRoot` is that checkout or a directory inside it; null otherwise.
 *
 * The repository is the git top-level of `repoRoot`, not the nearest ancestor with a package.json: a subdirectory of the runtime
 * handed in as the "repository" resolves to the runtime, while a target repository's worktree that the scheduler keeps under the
 * runtime's `.workdir/worktrees/` is its own top-level and is judged by its own package.json. Outside git, `repoRoot` itself.
 */
export async function runtimeRootOf(repoRoot: string): Promise<string | null> {
  const real = await realpath(repoRoot).catch(() => null);
  if (!real) return null;
  // GIT_DIR / GIT_WORK_TREE / GIT_CEILING_DIRECTORIES in the environment would answer for another repository; they are dropped.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const top = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd: real, timeout: 10_000, env })
    .then(({ stdout }) => realpath(stdout.trim())).catch(() => null);
  if (top && (await isRuntimeCheckout(top))) return top;
  // Fail closed when git cannot answer or answers with a nested repository: a directory inside this runtime's checkout is the
  // runtime, except its .workdir, where the scheduler keeps target repositories' worktrees (judged by their own identity above).
  const ancestor = findProjectRoot(real);
  if (ancestor && !isInside(join(ancestor, '.workdir'), real)) return ancestor;
  return null;
}

async function isRuntimeCheckout(dir: string): Promise<boolean> {
  try { return isProjectManifest(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))); } catch { return false; }
}
const isInside = (parent: string, child: string): boolean => { const rel = relative(parent, child); return rel === '' || (!outside(rel) && !isAbsolute(rel)); };

/** True when `repoRoot` is this runtime's checkout or lies inside one. */
export async function isRuntimeRepository(repoRoot: string): Promise<boolean> {
  return (await runtimeRootOf(repoRoot)) !== null;
}

const outside = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`);

/**
 * Why each allowed file is non-delegatable when the repository is (inside) this runtime's checkout; empty for any other
 * repository. Paths are judged relative to the runtime root, both literally and with the parent directory's symlinks resolved;
 * a `..` segment is refused outright. A parent that cannot be resolved is not a reason here (the gate's existence checks report
 * it); one that resolves outside the runtime is.
 */
export async function nonDelegatableReasons(repoRoot: string, allowedFiles: readonly string[]): Promise<string[]> {
  const root = await runtimeRootOf(repoRoot);
  if (!root) return [];
  const repo = await realpath(repoRoot);
  const reasons: string[] = [];
  for (const file of allowedFiles) {
    if (file.split(/[\\/]+/).includes('..')) { reasons.push(`${file}: ".." segments are not delegated in the runtime's own repository`); continue; }
    const literal = matches(relative(root, join(repo, file)));
    if (literal) { reasons.push(`${file}: non-delegatable in the runtime's own repository (${literal}); a worker never edits the runtime that judges it`); continue; }
    const parent = await realpath(join(repo, dirname(file))).catch(() => undefined);
    if (!parent) continue;
    const rel = relative(root, parent);
    if (outside(rel)) { reasons.push(`${file}: its directory resolves outside the repository`); continue; }
    const resolved = matches(join(rel, file.split(/[\\/]/).at(-1) ?? ''));
    if (resolved) reasons.push(`${file}: resolves through a symlink to a non-delegatable path (${resolved})`);
  }
  return reasons;
}

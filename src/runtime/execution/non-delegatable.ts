import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { isProjectManifest } from '../../core/paths.ts';

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

/** True when `repoRoot` is a checkout of this runtime (identified the way findProjectRoot identifies it: package.json name). */
export async function isRuntimeRepository(repoRoot: string): Promise<boolean> {
  try {
    return isProjectManifest(JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')));
  } catch {
    return false;
  }
}

/**
 * Why each allowed file is non-delegatable in this runtime's own repository; empty when the repository is another one or
 * every file is outside the protected set. A parent directory that cannot be resolved is not a reason here (the gate's
 * existence checks report it); a parent that resolves outside the repository is.
 */
export async function nonDelegatableReasons(repoRoot: string, allowedFiles: readonly string[]): Promise<string[]> {
  if (!(await isRuntimeRepository(repoRoot))) return [];
  const root = await realpath(repoRoot).catch(() => repoRoot);
  const reasons: string[] = [];
  for (const file of allowedFiles) {
    const literal = matches(file);
    if (literal) { reasons.push(`${file}: non-delegatable in the runtime's own repository (${literal}); a worker never edits the runtime that judges it`); continue; }
    const parent = await realpath(join(repoRoot, dirname(file))).catch(() => undefined);
    if (!parent) continue;
    const rel = relative(root, parent);
    if (rel === '..' || rel.startsWith(`..${sep}`)) { reasons.push(`${file}: its directory resolves outside the repository`); continue; }
    const resolved = matches(join(rel, file.split(/[\\/]/).at(-1) ?? ''));
    if (resolved) reasons.push(`${file}: resolves through a symlink to a non-delegatable path (${resolved})`);
  }
  return reasons;
}

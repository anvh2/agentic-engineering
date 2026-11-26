import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { runControlledCommand } from '../../workers/tools/execution-tools.ts';
import type { CodingTask } from './coding-task-runner.ts';

export const TS_VERIFIER_PROFILE = 'typescript-strict-v1' as const;
const TS_TEST_FILE = /(?:^|\/)[^/]+\.test\.ts$/;

export async function packageBoundary(repoRoot: string, file: string): Promise<{ path: string; reason?: string }> {
  let dir = dirname(join(repoRoot, file));
  for (;;) {
    const manifest = join(dir, 'package.json');
    const info = await lstat(manifest).catch(() => undefined);
    if (info?.isSymbolicLink()) return { path: '', reason: `${relative(repoRoot, manifest)}: package boundary may not be a symlink` };
    if (info?.isFile()) return { path: relative(repoRoot, dir) || '.' };
    if (dir === repoRoot) return { path: '.' };
    const parent = dirname(dir);
    const rel = relative(repoRoot, parent);
    if (parent === dir || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { path: '.' };
    dir = parent;
  }
}

export async function symlinkPathReason(repoRoot: string, path: string): Promise<string | undefined> {
  let current = repoRoot;
  for (const segment of path.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (info?.isSymbolicLink()) return `${path}: symlink path components are not allowed`;
  }
  return undefined;
}

function nodeSupportsTypeScriptTests(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

/** Offline, fixed-argv verifier profile. Tests and all compiler inputs must be tracked, clean and read-only. */
export async function validateTypeScriptVerification(
  commands: string[][],
  contract: CodingTask,
  repoRoot: string,
): Promise<string[]> {
  const reasons: string[] = [];
  if (Object.keys(contract.hiddenFiles ?? {}).length > 0) reasons.push(`${TS_VERIFIER_PROFILE} does not accept hidden or generated tests; use an immutable .test.ts oracle`);
  const boundaries = new Set<string>();
  for (const file of contract.allowedFiles) {
    const boundary = await packageBoundary(repoRoot, file);
    if (boundary.reason) reasons.push(boundary.reason);
    boundaries.add(boundary.path);
  }
  if (boundaries.size !== 1 || boundaries.has('')) reasons.push('TypeScript implementation files must belong to one package boundary');
  const boundary = [...boundaries][0] ?? '.';
  const compilerPath = join(repoRoot, 'node_modules/typescript/bin/tsc');
  const compiler = await lstat(compilerPath).catch(() => undefined);
  if (!compiler?.isFile() || compiler.isSymbolicLink()) reasons.push('the pinned local TypeScript compiler is missing or is not a regular file at node_modules/typescript/bin/tsc');
  const tsPackage = await readFile(join(repoRoot, 'node_modules/typescript/package.json'), 'utf8').then((s) => JSON.parse(s) as { version?: string }).catch(() => undefined);
  const lockPath = ['package-lock.json', 'npm-shrinkwrap.json'].map((name) => join(repoRoot, name)).find((path) => existsSync(path));
  const lock = lockPath ? await readFile(lockPath, 'utf8').then((s) => JSON.parse(s) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> }).catch(() => undefined) : undefined;
  const lockedVersion = lock?.packages?.['node_modules/typescript']?.version ?? lock?.dependencies?.typescript?.version;
  if (!tsPackage?.version || !lockedVersion || tsPackage.version !== lockedVersion) reasons.push('the installed TypeScript compiler version must exactly match a local npm lockfile entry');
  if (!nodeSupportsTypeScriptTests()) reasons.push('Node.js >=22.13 is required for the TypeScript test verifier');

  const expectedTsconfig = boundary === '.' ? 'tsconfig.json' : `${boundary}/tsconfig.json`;
  const tsconfigInfo = await lstat(join(repoRoot, expectedTsconfig)).catch(() => undefined);
  if (!tsconfigInfo?.isFile() || tsconfigInfo.isSymbolicLink()) reasons.push(`${expectedTsconfig}: package tsconfig must exist as a regular read-only file`);
  else reasons.push(...(await immutableTrackedFileReasons(repoRoot, expectedTsconfig, 'package tsconfig')));
  reasons.push(...(await immutableTrackedFileReasons(repoRoot, boundary === '.' ? 'package.json' : `${boundary}/package.json`, 'package manifest')));
  if (lockPath) reasons.push(...(await immutableTrackedFileReasons(repoRoot, relative(repoRoot, lockPath), 'npm lockfile')));
  else reasons.push(`${TS_VERIFIER_PROFILE} requires package-lock.json or npm-shrinkwrap.json so the local compiler is pinned`);

  let compilerCount = 0;
  let testCount = 0;
  for (const command of commands) {
    if (command[0] === 'node' && command[1] === './node_modules/typescript/bin/tsc') {
      compilerCount += 1;
      const expected = ['node', './node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--project', expectedTsconfig];
      if (command.join('\0') !== expected.join('\0')) reasons.push(`TypeScript compiler command must be exactly "${expected.join(' ')}"`);
      continue;
    }
    if (command[0] !== 'node' || command[1] !== '--experimental-strip-types' || command[2] !== '--test') {
      reasons.push(`TypeScript verifier command "${command.join(' ')}" is not allow-listed by ${TS_VERIFIER_PROFILE}`);
      continue;
    }
    const paths = command.slice(3);
    if (paths.length === 0) reasons.push('Node TypeScript test verifier must name at least one immutable .test.ts file');
    for (const path of paths) {
      const normalized = normalize(path);
      if (isAbsolute(path) || normalized.startsWith('..') || normalized !== path) {
        reasons.push(`TypeScript test path "${path}" must be a normalized repository-relative path without ".."`);
        continue;
      }
      if (!TS_TEST_FILE.test(path)) {
        reasons.push(`TypeScript test path "${path}" must end in .test.ts`);
        continue;
      }
      testCount += 1;
      const linkReason = await symlinkPathReason(repoRoot, path);
      if (linkReason) reasons.push(linkReason);
      const info = await lstat(join(repoRoot, path)).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink()) reasons.push(`TypeScript test path "${path}" must exist as a regular immutable file`);
      const pathBoundary = await packageBoundary(repoRoot, path);
      if (pathBoundary.reason) reasons.push(pathBoundary.reason);
      if (pathBoundary.path !== boundary) reasons.push(`TypeScript test path "${path}" must be inside the implementation package boundary`);
      const tracked = await runControlledCommand('git', ['ls-files', '--error-unmatch', '--', path], { cwd: repoRoot, timeoutMs: 10_000 });
      if (!tracked.success) reasons.push(`TypeScript test path "${path}" is not tracked and cannot serve as an oracle`);
      const status = await runControlledCommand('git', ['status', '--porcelain', '--', path], { cwd: repoRoot, timeoutMs: 10_000 });
      if (!status.success || status.stdout.trim()) reasons.push(`TypeScript test path "${path}" is dirty and cannot serve as an immutable oracle`);
    }
  }
  if (compilerCount !== 1) reasons.push(`${TS_VERIFIER_PROFILE} requires exactly one pinned local tsc --noEmit check`);
  if (testCount === 0) reasons.push(`${TS_VERIFIER_PROFILE} requires at least one immutable Node TypeScript test`);
  return reasons;
}

async function immutableTrackedFileReasons(repoRoot: string, path: string, label: string): Promise<string[]> {
  const reasons: string[] = [];
  const linkReason = await symlinkPathReason(repoRoot, path);
  if (linkReason) reasons.push(`${label}: ${linkReason}`);
  const tracked = await runControlledCommand('git', ['ls-files', '--error-unmatch', '--', path], { cwd: repoRoot, timeoutMs: 10_000 });
  if (!tracked.success) reasons.push(`${label} ${path} is not tracked`);
  const status = await runControlledCommand('git', ['status', '--porcelain', '--', path], { cwd: repoRoot, timeoutMs: 10_000 });
  if (!status.success || status.stdout.trim()) reasons.push(`${label} ${path} is dirty and cannot be trusted as an immutable verifier input`);
  return reasons;
}

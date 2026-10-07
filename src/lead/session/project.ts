import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findProjectRoot } from '../../core/paths.ts';
import type { Checkpoint, ProjectConfig } from './types.ts';

/**
 * File-based project brain under <project root>/projects/<name>. No database: a
 * project is a directory, a checkpoint is a write-once JSON file, and the
 * latest checkpoint is simply the lexicographically greatest file name.
 */

export const HARNESS_ROOT = findProjectRoot(import.meta.dirname) ?? resolve(import.meta.dirname, '..', '..', '..');

/** Engineering principles injected into every resume packet, relative to the project root. */
export const PRINCIPLES_PATH = join('docs', 'operations', 'lead-principles.md');

export interface ProjectPaths {
  principlesFile: string;
  projectDir: string;
  checkpointsDir: string;
}

export function projectPaths(name: string, harnessRoot = HARNESS_ROOT): ProjectPaths {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid project name "${name}".`);
  const projectDir = join(harnessRoot, 'projects', name);
  return { principlesFile: join(harnessRoot, PRINCIPLES_PATH), projectDir, checkpointsDir: join(projectDir, 'checkpoints') };
}

export async function loadProject(name: string, harnessRoot = HARNESS_ROOT): Promise<{ config: ProjectConfig; repoPath: string }> {
  const { projectDir } = projectPaths(name, harnessRoot);
  let raw: string;
  try {
    raw = await readFile(join(projectDir, 'project.json'), 'utf8');
  } catch {
    throw new Error(`Unknown project "${name}": ${join(projectDir, 'project.json')} not found.`);
  }
  const config = JSON.parse(raw) as ProjectConfig;
  const problems: string[] = [];
  if (config.schema !== 'harness.project/1') problems.push('schema must be "harness.project/1"');
  if (typeof config.repo !== 'string' || config.repo === '') problems.push('repo must be a path relative to the harness root');
  if (typeof config.identity?.rootCommit !== 'string') problems.push('identity.rootCommit is required');
  if (!Array.isArray(config.test?.command) || config.test.command.length === 0) problems.push('test.command must be a non-empty argv array');
  if (typeof config.test?.timeoutMs !== 'number') problems.push('test.timeoutMs must be a number');
  if (!Array.isArray(config.expectedLocal)) problems.push('expectedLocal must be an array');
  if (problems.length) throw new Error(`Invalid project.json for "${name}": ${problems.join('; ')}.`);
  // Resolved against the harness repository root, never the caller's cwd.
  return { config, repoPath: resolve(harnessRoot, config.repo) };
}

export async function readOptional(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

export function newCheckpointId(date = new Date()): string {
  // Millisecond precision keeps lexicographic order == creation order.
  const stamp = date.toISOString().replace(/:/g, '-');
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export async function writeCheckpoint(checkpointsDir: string, checkpoint: Checkpoint): Promise<string> {
  await mkdir(checkpointsDir, { recursive: true });
  const target = join(checkpointsDir, `${checkpoint.id}.json`);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'wx' });
  await rename(temp, target);
  return target;
}

export async function listCheckpoints(checkpointsDir: string): Promise<string[]> {
  const files = await readdir(checkpointsDir).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
}

export async function loadCheckpoint(checkpointsDir: string, id?: string): Promise<{ checkpoint: Checkpoint; path: string } | null> {
  const ids = await listCheckpoints(checkpointsDir);
  const chosen = id ?? ids.at(-1);
  if (!chosen) return null;
  if (!ids.includes(chosen)) throw new Error(`Checkpoint "${chosen}" not found in ${checkpointsDir}.`);
  const path = join(checkpointsDir, `${chosen}.json`);
  let checkpoint: Checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(path, 'utf8')) as Checkpoint;
  } catch (err) {
    throw new Error(`Checkpoint ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (checkpoint.schema !== 'harness.checkpoint/1') throw new Error(`Checkpoint ${path} has unsupported schema "${checkpoint.schema}".`);
  return { checkpoint, path };
}

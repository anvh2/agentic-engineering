import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodingTask } from '../../src/runtime/execution/coding-task-runner.ts';

/**
 * Deterministic Go difficulty ladder (all single-file). Each level lives in
 * go-ladder/<level>/ as real files:
 *   stub/       the repository the worker starts from (incl. the visible, immutable tests)
 *   hidden/     harness-owned verification tests the worker never sees
 *   reference/  a known-good solution, used ONLY by tests to prove the fixture is valid
 *   task.json   the CodingTask contract
 * Every run gets a brand-new temp copy, so runs can never share state.
 */
export const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'] as const;
export type Level = (typeof LEVELS)[number];

const LADDER_DIR = join(dirname(fileURLToPath(import.meta.url)), 'go-ladder');

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string): Promise<void> {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[relative(dir, full)] = await readFile(full, 'utf8');
    }
  }
  await walk(dir);
  return out;
}

export interface BuiltFixture {
  level: Level;
  root: string;
  task: CodingTask;
  cleanup: () => Promise<void>;
}

export async function buildFixture(level: Level, options: { parent?: string } = {}): Promise<BuiltFixture> {
  const dir = join(LADDER_DIR, level);
  const task = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')) as CodingTask;
  const root = await mkdtemp(join(options.parent ?? tmpdir(), `bench-${level}-`));
  await cp(join(dir, 'stub'), root, { recursive: true });
  return {
    level,
    root,
    task: { ...task, hiddenFiles: await readTree(join(dir, 'hidden')) },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Known-good solution files (path -> content) for a level. Tests only; never shown to a worker. */
export function loadReference(level: Level): Promise<Record<string, string>> {
  return readTree(join(LADDER_DIR, level, 'reference'));
}

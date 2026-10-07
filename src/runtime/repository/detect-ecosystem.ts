import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ecosystem } from '../../workers/coding-worker.ts';

/**
 * Detects which ecosystem a repository belongs to by the presence of its
 * canonical manifest file - never by asking a model to guess, since this
 * choice determines which tool set (and therefore which binaries get
 * spawned: go/gofmt vs npx jest/prettier) the worker receives. Go takes
 * precedence if a repository somehow has both.
 */
export async function detectEcosystem(repositoryRoot: string): Promise<Ecosystem | undefined> {
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );

  if (await exists(join(repositoryRoot, 'go.mod'))) return 'go';
  if (await exists(join(repositoryRoot, 'package.json'))) return 'js';
  return undefined;
}

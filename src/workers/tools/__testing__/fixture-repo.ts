import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FixtureRepo {
  /** Parent directory holding this fixture's root (and any sibling dirs created alongside it). */
  parent: string;
  /** Absolute path to the fixture repository root. */
  root: string;
  cleanup: () => Promise<void>;
}

/**
 * Builds a throwaway repository under the OS temp dir shaped like the
 * example fixture used across the repository-tools tests:
 *
 *   <root>/go.mod
 *   <root>/internal/service.go
 *   <root>/internal/service_test.go
 *   <root>/README.md
 *
 * `serviceMarker` is embedded in service.go so tests can assert searchFiles
 * finds repo-specific content instead of a hardcoded shared string.
 */
export async function createFixtureRepo(
  serviceMarker = 'CalculateTotal',
  options: { parent?: string; dirName?: string } = {},
): Promise<FixtureRepo> {
  const parent = options.parent ?? (await mkdtemp(join(tmpdir(), 'repo-tools-fixture-')));
  const root = join(parent, options.dirName ?? 'repo');

  await mkdir(join(root, 'internal'), { recursive: true });
  await writeFile(join(root, 'go.mod'), 'module example.com/fixture\n\ngo 1.22\n');
  await writeFile(
    join(root, 'internal', 'service.go'),
    `package internal\n\nfunc ${serviceMarker}(items []int) int {\n\ttotal := 0\n\tfor _, item := range items {\n\t\ttotal += item\n\t}\n\treturn total\n}\n`,
  );
  await writeFile(
    join(root, 'internal', 'service_test.go'),
    `package internal\n\nimport "testing"\n\nfunc Test${serviceMarker}(t *testing.T) {\n\tif got := ${serviceMarker}([]int{1, 2, 3}); got != 6 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n`,
  );
  await writeFile(join(root, 'README.md'), '# Fixture repository\n\nUsed by repository-tools tests.\n');

  return {
    parent,
    root,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

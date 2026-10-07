import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The package name that identifies this repository's root. The checkout directory's own name is never consulted.
 */
const PROJECT_PACKAGE_NAME = 'agentic-engineering';

/** Walks up from `from` to the directory whose package.json names this project; null when there is none. */
export function findProjectRoot(from: string = process.cwd()): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === PROJECT_PACKAGE_NAME) return dir;
      } catch {
        // An unreadable package.json is not this project's; keep walking.
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

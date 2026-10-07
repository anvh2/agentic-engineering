import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Package names that identify this repository's root. `harness-engineering` is the pre-rename name,
 * accepted so an old checkout keeps working; the checkout directory's own name is never consulted.
 */
const PROJECT_PACKAGE_NAMES = new Set(['agentic-engineering', 'harness-engineering']);

/** Walks up from `from` to the directory whose package.json names this project; null when there is none. */
export function findProjectRoot(from: string = process.cwd()): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (PROJECT_PACKAGE_NAMES.has(JSON.parse(readFileSync(manifest, 'utf8')).name)) return dir;
      } catch {
        // An unreadable package.json is not this project's; keep walking.
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';

/**
 * A worker process killed in the middle of a file mutation (between writing the new content and making it visible)
 * must leave the original file intact: writes go to a temp file and are published by an atomic rename.
 */
describe('repository tools: crash during a file mutation', () => {
  let fixture: FixtureRepo;
  let original: string;
  before(async () => {
    fixture = await createFixtureRepo();
    original = await readFile(join(fixture.root, 'internal', 'service.go'), 'utf8');
  });
  after(() => fixture.cleanup());

  for (const tool of ['writeFile', 'applyPatch'] as const) {
    it(`${tool}: SIGKILL-equivalent exit right before the publishing rename leaves the original file byte-identical`, async () => {
      const here = (p: string) => pathToFileURL(join(import.meta.dirname, p)).href;
      const child = `
        import { createRequire, syncBuiltinESMExports } from 'node:module';
        const require = createRequire(import.meta.url);
        require('fs/promises').rename = async () => process.exit(137); // die after the temp write, before publishing
        syncBuiltinESMExports();
        const tools = await import(${JSON.stringify(here('repository-tools.ts'))});
        const { contextFor } = await import(${JSON.stringify(here('__testing__/context-for.ts'))});
        const args = ${tool === 'writeFile'
          ? `{ path: 'internal/service.go', content: 'package internal\\n// half-way rewrite\\n' }`
          : `{ path: 'internal/service.go', patch: '--- a/internal/service.go\\n+++ b/internal/service.go\\n@@ -1,1 +1,1 @@\\n-package internal\\n+package changed\\n' }`};
        await tools.${tool}.execute(args, contextFor(${JSON.stringify(fixture.root)}));
        process.exit(0);
      `;
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', child], { encoding: 'utf8' });
      assert.equal(r.status, 137, `child should have died mid-write: ${r.stderr}`);
      assert.equal(await readFile(join(fixture.root, 'internal', 'service.go'), 'utf8'), original);
      // the orphaned temp file is the only trace; it is ignored by the mutation snapshot and protected from worker writes
      const leftovers = (await readdir(join(fixture.root, 'internal'))).filter((f) => f.startsWith('.applypatch-'));
      assert.equal(leftovers.length, 1);
      for (const f of leftovers) await rm(join(fixture.root, 'internal', f));
    });
  }
});

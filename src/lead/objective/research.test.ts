import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeFixture, objectiveFor, type Fixture } from './__testing__/fixture.ts';
import { fingerprintRepository, readGit, PlanningIsolationError } from './readonly-repo.ts';
import { keywordsOf, scanRepository } from './research.ts';
import { researchContextSchema } from './types.ts';

let fx: Fixture;
before(async () => {
  fx = await makeFixture();
});
after(() => fx.cleanup());

describe('repository research', () => {
  it('produces a compact, schema-valid ResearchContext from the repository alone', async () => {
    const research = await scanRepository(objectiveFor(fx, { description: 'Add API rate limiting to the HTTP server middleware' }));
    researchContextSchema.parse(research);
    assert.equal(research.commit, fx.git('rev-parse', 'HEAD').trim());
    assert.equal(research.branch, 'main');
    assert.equal(research.languages.javascript, 5);
    assert.ok(research.manifests.includes('package.json'));
    assert.ok(research.dependencies.includes('jest'));
    assert.ok(research.conventions.includes('JavaScript tests use jest'));
    assert.ok(research.conventions.some((c) => /co-located/.test(c)));
    assert.deepEqual(research.testCommands[0], ['npm', 'test']);
    assert.ok(research.modules.some((m) => m.path === 'src/middleware'));
    // existing implementation near the objective, with its tests, ranked
    const paths = research.relevantFiles.map((f) => f.path);
    assert.ok(paths.includes('src/middleware/logger.js') && paths.includes('src/middleware/logger.test.js'));
    assert.equal(research.relevantFiles.find((f) => f.path === 'src/middleware/logger.test.js')?.kind, 'test');
    assert.ok(research.relevantFiles.length <= 40, 'research is compact, not a repository dump');
  });

  it('flags security-sensitive code, schema migrations and files local workers cannot edit', async () => {
    const research = await scanRepository(objectiveFor(fx, { description: 'Rate limit login session checks, migrate the users schema and update the Widget' }));
    const kinds = research.risks.map((r) => r.kind);
    assert.ok(kinds.includes('security_sensitive'), kinds.join());
    assert.ok(kinds.includes('destructive_change'), kinds.join());
    assert.ok(kinds.includes('worker_unsupported_language'), kinds.join());
    assert.ok(research.risks.find((r) => r.kind === 'security_sensitive')?.paths.includes('src/auth/session.js'));
  });

  it('reports uncommitted files that overlap the objective', async () => {
    await writeFile(join(fx.repo, 'src/config.js'), "export const config = { port: 3001, apiPrefix: '/api' };\n");
    try {
      const research = await scanRepository(objectiveFor(fx, { description: 'change the api config' }));
      assert.deepEqual(research.dirtyFiles, ['src/config.js']);
      assert.ok(research.risks.some((r) => r.kind === 'dirty_files' && r.paths.includes('src/config.js')));
    } finally {
      fx.git('checkout', '--', 'src/config.js');
    }
  });

  it('rejects a repository that is not a git work tree root', async () => {
    await assert.rejects(scanRepository(objectiveFor(fx, { repository: join(fx.repo, 'src') })), /repository root|inside the git work tree/);
    await assert.rejects(scanRepository(objectiveFor(fx, { repository: join(fx.root, 'missing') })), /not a directory/);
  });

  it('extracts search keywords without stopwords and splits camelCase', () => {
    assert.deepEqual(keywordsOf('Add the API rateLimiter to this service'), ['api', 'limiter', 'rate']);
  });
});

describe('planning isolation', () => {
  it('research leaves the repository bit-for-bit unchanged (HEAD, refs, status and dirty file stats)', async () => {
    await writeFile(join(fx.repo, 'scratch.txt'), 'untracked\n');
    try {
      const before = await fingerprintRepository(fx.repo);
      await scanRepository(objectiveFor(fx));
      assert.equal(await fingerprintRepository(fx.repo), before);
      assert.equal(fx.git('status', '--porcelain').trim(), '?? scratch.txt');
    } finally {
      fx.git('clean', '-fdq');
    }
  });

  it('the git reader refuses every command that can write', async () => {
    for (const sub of [['checkout', '-b', 'x'], ['commit', '--allow-empty', '-m', 'x'], ['branch', 'x'], ['add', '.'], ['reset', '--hard'], ['diff', '--output=/tmp/x'], ['symbolic-ref', 'HEAD', 'refs/heads/x'], ['push']]) {
      await assert.rejects(readGit(fx.repo, sub), PlanningIsolationError, sub.join(' '));
    }
  });

  it('the fingerprint notices file edits, new files, new branches and commits', async () => {
    const base = await fingerprintRepository(fx.repo);
    await writeFile(join(fx.repo, 'src/new.js'), 'x\n');
    const withFile = await fingerprintRepository(fx.repo);
    assert.notEqual(withFile, base);
    await writeFile(join(fx.repo, 'src/new.js'), 'xyz\n');
    const edited = await fingerprintRepository(fx.repo);
    assert.notEqual(edited, withFile);
    fx.git('branch', 'sneaky');
    assert.notEqual(await fingerprintRepository(fx.repo), edited);
    fx.git('branch', '-D', 'sneaky');
    await import('node:fs/promises').then((fs) => fs.rm(join(fx.repo, 'src/new.js')));
    assert.equal(await fingerprintRepository(fx.repo), base);
  });
});

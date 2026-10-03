import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoTest } from './execution-tools.ts';
import { callTool } from './__testing__/call-tool.ts';
import { contextFor } from './__testing__/context-for.ts';

interface GoFixture {
  root: string;
  cleanup: () => Promise<void>;
}

/**
 * A real, `go test`-runnable module - not the shared createFixtureRepo
 * fixture, since these tests need control over whether the tests pass,
 * fail, or hang, which the shared fixture's fixed contents don't offer.
 */
async function createGoFixture(testBody: string): Promise<GoFixture> {
  const root = await mkdtemp(join(tmpdir(), 'go-test-fixture-'));
  await mkdir(join(root, 'pkg'), { recursive: true });
  await writeFile(join(root, 'go.mod'), 'module example.com/gofixture\n\ngo 1.22\n');
  await writeFile(
    join(root, 'pkg', 'pkg.go'),
    'package pkg\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n',
  );
  await writeFile(join(root, 'pkg', 'pkg_test.go'), testBody);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('runGoTest', () => {
  it('reports success for a passing test suite', async () => {
    const fixture = await createGoFixture(
      'package pkg\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("bad")\n\t}\n}\n',
    );
    try {
      const result = await callTool(runGoTest.execute!({ package: './...' }, contextFor(fixture.root)));
      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      assert.match(result.stdout, /ok/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports failure, exit code, and useful output for a failing test', async () => {
    const fixture = await createGoFixture(
      'package pkg\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 999 {\n\t\tt.Fatalf("got %d, want 999", Add(1, 2))\n\t}\n}\n',
    );
    try {
      const result = await callTool(runGoTest.execute!({ package: './...' }, contextFor(fixture.root)));
      assert.equal(result.success, false);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stdout, /FAIL/);
      assert.match(result.stdout, /got 3, want 999/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports a controlled failure for a nonexistent package instead of crashing', async () => {
    const fixture = await createGoFixture(
      'package pkg\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {}\n',
    );
    try {
      const result = await callTool(runGoTest.execute!({ package: './does-not-exist' }, contextFor(fixture.root)));
      assert.equal(result.success, false);
      assert.notEqual(result.exitCode, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('defaults to "./..." when no package is given', async () => {
    const fixture = await createGoFixture(
      'package pkg\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("bad")\n\t}\n}\n',
    );
    try {
      const result = await callTool(runGoTest.execute!({}, contextFor(fixture.root)));
      assert.equal(result.success, true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('terminates a hanging test at the configured timeout and reports it cleanly, without leaving the process running', async () => {
    const fixture = await createGoFixture(
      'package pkg\n\nimport (\n\t"testing"\n\t"time"\n)\n\nfunc TestHangs(t *testing.T) {\n\ttime.Sleep(30 * time.Second)\n}\n',
    );
    const originalTimeout = process.env.GO_TEST_TIMEOUT_MS;
    process.env.GO_TEST_TIMEOUT_MS = '1000';
    try {
      const start = Date.now();
      const result = await callTool(runGoTest.execute!({ package: './...' }, contextFor(fixture.root)));
      const elapsed = Date.now() - start;

      assert.equal(result.success, false);
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, null);
      assert.match(result.stderr, /timed out/i);
      // Generous upper bound - proves the test process was actually killed
      // rather than left to run for its full 30s sleep.
      assert.ok(elapsed < 15_000, `expected the timeout to cut the run short, took ${elapsed}ms`);
    } finally {
      if (originalTimeout === undefined) delete process.env.GO_TEST_TIMEOUT_MS;
      else process.env.GO_TEST_TIMEOUT_MS = originalTimeout;
      await fixture.cleanup();
    }
  });

  it('never executes outside the configured repository', async () => {
    await assert.rejects(
      () => runGoTest.execute!({ package: './...' }, { requestContext: undefined } as any),
      /No repository is configured/,
    );
  });

  it('rejects a package selector that attempts directory traversal', async () => {
    const fixture = await createGoFixture('package pkg\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {}\n');
    try {
      await assert.rejects(
        () => runGoTest.execute!({ package: '../../etc' }, contextFor(fixture.root)),
        /not a valid package selector/,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects an absolute package path', async () => {
    const fixture = await createGoFixture('package pkg\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {}\n');
    try {
      await assert.rejects(
        () => runGoTest.execute!({ package: '/etc/passwd' }, contextFor(fixture.root)),
        /not a valid package selector/,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a package selector carrying shell metacharacters instead of passing them to a shell', async () => {
    const fixture = await createGoFixture('package pkg\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {}\n');
    const markerFile = join(fixture.root, 'injection-marker');
    try {
      const injectionAttempts = [
        './...; touch injection-marker',
        './... && touch injection-marker',
        './...`touch injection-marker`',
        '$(touch injection-marker)',
        './... | touch injection-marker',
      ];
      for (const attempt of injectionAttempts) {
        await assert.rejects(
          () => runGoTest.execute!({ package: attempt }, contextFor(fixture.root)),
          /not a valid package selector/,
          `expected "${attempt}" to be rejected`,
        );
      }
      await assert.rejects(() => stat(markerFile), /ENOENT/, 'the injected `touch` must never have run');
    } finally {
      await fixture.cleanup();
    }
  });

  it('truncates excessive output and says so explicitly', async () => {
    const fixture = await createGoFixture(
      'package pkg\n\nimport (\n\t"fmt"\n\t"testing"\n)\n\nfunc TestNoisy(t *testing.T) {\n\tfor i := 0; i < 2000; i++ {\n\t\tfmt.Println("noisy output line filler filler filler filler")\n\t}\n\tt.Fatal("fail to force output through stdout on -v-less run too")\n}\n',
    );
    try {
      const result = await callTool(runGoTest.execute!({ package: './...' }, contextFor(fixture.root)));
      assert.match(result.stdout + result.stderr, /output truncated/);
    } finally {
      await fixture.cleanup();
    }
  });
});

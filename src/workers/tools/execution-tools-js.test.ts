import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile as readRaw, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJestTest, runPrettier } from './execution-tools.ts';
import { callTool } from './__testing__/call-tool.ts';
import { contextFor } from './__testing__/context-for.ts';

/**
 * Neither `jest` nor `prettier` is a dependency of this project (only the
 * *target* repository's own installs matter at runtime - `npx` resolves
 * from `<repo>/node_modules/.bin` first). Network installs are also
 * unavailable in this environment, so these tests never touch the real
 * npm registry: each fixture gets its own `node_modules/.bin/<name>` stub
 * script, exactly what a real local install would put there, and `npx`
 * picks it up the same way it would a real binary. This tests this
 * module's own command-construction/boundary-check/success-detection
 * logic, not jest/prettier's actual formatting/testing behavior (those are
 * third-party tools, out of scope to test here - same spirit as the Go
 * tool tests assuming a real `go`/`gofmt` on the host, just swapped for a
 * stub since a JS binary isn't a host-wide assumption this project can make).
 */
async function createJsFixture(): Promise<{
  root: string;
  setBin: (name: 'jest' | 'prettier', script: string) => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'js-exec-fixture-'));
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });

  const setBin = async (name: 'jest' | 'prettier', script: string) => {
    const binPath = join(root, 'node_modules', '.bin', name);
    await writeFile(binPath, script);
    await chmod(binPath, 0o755);
  };

  return { root, setBin, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('runPrettier', () => {
  it('reports no change for an already-formatted file, and leaves it byte-identical', async () => {
    const fixture = await createJsFixture();
    try {
      await fixture.setBin('prettier', '#!/bin/sh\nexit 0\n');
      const content = 'module.exports = { a: 1 };\n';
      await writeFile(join(fixture.root, 'src', 'already.js'), content);

      const result = await callTool(runPrettier.execute!({ path: 'src/already.js' }, contextFor(fixture.root)));

      assert.equal(result.success, true);
      assert.equal(result.changed, false);
      const onDisk = await readRaw(join(fixture.root, 'src', 'already.js'), 'utf8');
      assert.equal(onDisk, content);
    } finally {
      await fixture.cleanup();
    }
  });

  it('formats an unformatted file in place and reports that it changed', async () => {
    const fixture = await createJsFixture();
    try {
      await fixture.setBin(
        'prettier',
        '#!/bin/sh\ncase "$1" in\n  --check) exit 1 ;;\n  --write) echo "formatted;" > "$2"; exit 0 ;;\nesac\n',
      );
      await writeFile(join(fixture.root, 'src', 'messy.js'), 'module.exports={a:1}\n');

      const result = await callTool(runPrettier.execute!({ path: 'src/messy.js' }, contextFor(fixture.root)));

      assert.equal(result.success, true);
      assert.equal(result.changed, true);
      const onDisk = await readRaw(join(fixture.root, 'src', 'messy.js'), 'utf8');
      assert.equal(onDisk, 'formatted;\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('handles a parse error cleanly, without modifying the file', async () => {
    const fixture = await createJsFixture();
    try {
      await fixture.setBin(
        'prettier',
        '#!/bin/sh\ncase "$1" in\n  --check) exit 1 ;;\n  --write) echo "SyntaxError: Unexpected token" >&2; exit 2 ;;\nesac\n',
      );
      const invalid = 'function broken( {\n';
      await writeFile(join(fixture.root, 'src', 'invalid.js'), invalid);

      const result = await callTool(runPrettier.execute!({ path: 'src/invalid.js' }, contextFor(fixture.root)));

      assert.equal(result.success, false);
      assert.equal(result.changed, false);
      assert.match(result.stderr, /SyntaxError/);
      const onDisk = await readRaw(join(fixture.root, 'src', 'invalid.js'), 'utf8');
      assert.equal(onDisk, invalid);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a path outside the repository', async () => {
    const fixture = await createJsFixture();
    try {
      await assert.rejects(
        () => runPrettier.execute!({ path: '../outside.js' }, contextFor(fixture.root)),
        /outside the repository root/,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a symlink-mediated path, even one whose real target is inside the repository', async () => {
    const fixture = await createJsFixture();
    try {
      await writeFile(join(fixture.root, 'src', 'real.js'), 'module.exports = {};\n');
      const aliasPath = join(fixture.root, 'prettier-alias.js');
      await symlink(join(fixture.root, 'src', 'real.js'), aliasPath, 'file');
      try {
        await assert.rejects(
          () => runPrettier.execute!({ path: 'prettier-alias.js' }, contextFor(fixture.root)),
          /reached through a symlink/,
        );
      } finally {
        await rm(aliasPath, { force: true });
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('runJestTest', () => {
  it('reports success for a passing test run', async () => {
    const fixture = await createJsFixture();
    try {
      await fixture.setBin('jest', '#!/bin/sh\necho "PASS $@"\nexit 0\n');
      await writeFile(join(fixture.root, 'src', 'foo.test.js'), "test('x', () => {});\n");

      const result = await callTool(runJestTest.execute!({ testPath: 'src/foo.test.js' }, contextFor(fixture.root)));

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      assert.match(result.stdout, /PASS/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports failure and exit code for a failing test run', async () => {
    const fixture = await createJsFixture();
    try {
      await fixture.setBin('jest', '#!/bin/sh\necho "FAIL $@" >&2\nexit 1\n');

      const result = await callTool(runJestTest.execute!({ testPath: 'src/foo.test.js' }, contextFor(fixture.root)));

      assert.equal(result.success, false);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /FAIL/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs without a scoping argument when testPath is omitted', async () => {
    const fixture = await createJsFixture();
    try {
      await fixture.setBin('jest', '#!/bin/sh\necho "ARGS:$@:"\nexit 0\n');

      const result = await callTool(runJestTest.execute!({}, contextFor(fixture.root)));

      assert.equal(result.success, true);
      assert.match(result.stdout, /^ARGS:--ci:/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('terminates a hanging test run at the configured timeout, without leaving the process running', async () => {
    const fixture = await createJsFixture();
    await fixture.setBin('jest', '#!/bin/sh\nsleep 30\n');
    const originalTimeout = process.env.JEST_TEST_TIMEOUT_MS;
    process.env.JEST_TEST_TIMEOUT_MS = '1000';
    try {
      const start = Date.now();
      const result = await callTool(runJestTest.execute!({}, contextFor(fixture.root)));
      const elapsed = Date.now() - start;

      assert.equal(result.success, false);
      assert.equal(result.timedOut, true);
      assert.match(result.stderr, /timed out/i);
      assert.ok(elapsed < 15_000, `expected the timeout to cut the run short, took ${elapsed}ms`);
    } finally {
      if (originalTimeout === undefined) delete process.env.JEST_TEST_TIMEOUT_MS;
      else process.env.JEST_TEST_TIMEOUT_MS = originalTimeout;
      await fixture.cleanup();
    }
  });

  it('never executes outside the configured repository', async () => {
    await assert.rejects(
      () => runJestTest.execute!({}, { requestContext: undefined } as any),
      /No repository is configured/,
    );
  });

  it('rejects a testPath that attempts directory traversal', async () => {
    const fixture = await createJsFixture();
    try {
      await fixture.setBin('jest', '#!/bin/sh\nexit 0\n');
      await assert.rejects(
        () => runJestTest.execute!({ testPath: '../../etc' }, contextFor(fixture.root)),
        /outside the repository root/,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

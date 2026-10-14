import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createOwnedDir, findRealCredentialCopies, killGroup, removeOwnedSync, sweepStaleOwnedDirs } from '../provider-smoke/canary-fs.ts';

/** Regression tests for the canary cleanup (M8 final, gate 1): ownership-safe, reliable under background writers, and no real credential copies. */

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'canary-cleanup-test-')));

describe('canary cleanup', () => {
  // Keep the writer anchored to the original directory inode. Absolute mkdir -p can recreate the
  // removed root without its ownership marker; a successful removal cannot promise it stays absent.
  function writer(dir: string, signal: AbortSignal) {
    const child = spawn('/bin/sh', ['-c', 'mkdir -p .codex/a/b; echo x > .codex/a/b/f; echo ready; while true; do mkdir -p .codex/a/b 2>/dev/null; echo x > .codex/a/b/f 2>/dev/null; done'], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const closed = once(child, 'close');
    const ready = Promise.race([once(child.stdout, 'data', { signal }), closed.then(() => { throw new Error('writer exited before readiness'); })]);
    let stopping: Promise<void> | undefined;
    return {
      ready,
      stop() {
        return stopping ??= (async () => {
          assert.equal(await killGroup(child.pid), true, 'the writer process group is gone');
          await closed;
        })();
      },
    };
  }

  it('removes an owned directory even while a background process keeps writing into it (the ENOTEMPTY race)', { timeout: 60_000 }, async (t) => {
    const parent = scratch();
    const dir = createOwnedDir(parent, '.agentic-canary-');
    const child = writer(dir, t.signal);
    try {
      await child.ready;
      assert.ok(existsSync(join(dir, '.codex', 'a', 'b', 'f')), 'the background writer is active');
      await child.stop();
      assert.deepEqual(removeOwnedSync(dir), { removed: true });
      assert.equal(existsSync(dir), false);
    } finally {
      await child.stop();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('even with the writer still running, removal retries until the tree is gone or reports it did not remove it', { timeout: 60_000 }, async (t) => {
    const parent = scratch();
    const dir = createOwnedDir(parent, '.agentic-canary-');
    const child = writer(dir, t.signal);
    try {
      await child.ready;
      const r = removeOwnedSync(dir);
      await child.stop();
      assert.equal(typeof r.removed, 'boolean');
      if (!r.removed) assert.match(r.refused ?? '', /not empty/);
      else assert.equal(existsSync(dir), false);
      assert.equal(removeOwnedSync(dir).removed, true, 'once the writer is dead the second removal succeeds');
    } finally {
      await child.stop();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses a directory recreated by a writer after successful removal', { timeout: 60_000 }, async (t) => {
    const parent = scratch();
    const dir = createOwnedDir(parent, '.agentic-canary-');
    // Force the old race: remove -> writer recreates the absolute path -> writer exits -> inspect.
    const script = `import { mkdirSync, writeFileSync } from 'node:fs'; process.stdin.once('data', () => { mkdirSync(${JSON.stringify(dir)}, { recursive: true }); writeFileSync(${JSON.stringify(join(dir, 'new-file'))}, 'keep'); process.stdin.destroy(); }); console.log('ready');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { detached: true, stdio: ['pipe', 'pipe', 'inherit'] });
    const closed = once(child, 'close');
    try {
      await Promise.race([once(child.stdout, 'data', { signal: t.signal }), closed.then(() => { throw new Error('writer exited before readiness'); })]);
      assert.deepEqual(removeOwnedSync(dir), { removed: true });
      assert.equal(existsSync(dir), false);
      child.stdin.end('recreate');
      const [code] = await closed;
      assert.equal(code, 0);
      assert.equal(existsSync(dir), true, 'a live writer can recreate a successfully removed path');
      assert.deepEqual(removeOwnedSync(dir), { removed: false, refused: 'not created by this process' });
      assert.equal(readFileSync(join(dir, 'new-file'), 'utf8'), 'keep', 'the replacement is never adopted');
    } finally {
      if (child.exitCode === null && child.signalCode === null) assert.equal(await killGroup(child.pid), true);
      await closed;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses a path this process did not create, a symlink and a replaced marker; the victim stays intact', () => {
    const parent = scratch();
    try {
      const victim = join(parent, 'victim');
      mkdirSync(victim);
      writeFileSync(join(victim, 'precious.txt'), 'keep');
      assert.equal(removeOwnedSync(victim).removed, false, 'a directory nobody registered');

      const dir = createOwnedDir(parent, '.agentic-canary-');
      rmSync(dir, { recursive: true });
      symlinkSync(victim, dir); // the owned path is swapped for a symlink to somewhere else
      const r = removeOwnedSync(dir);
      assert.equal(r.removed, false);
      assert.match(r.refused ?? '', /symlink|real directory/);
      assert.equal(readFileSync(join(victim, 'precious.txt'), 'utf8'), 'keep');
      unlinkSync(dir);

      const dir2 = createOwnedDir(parent, '.agentic-canary-');
      writeFileSync(join(dir2, '.agentic-canary-owner.json'), JSON.stringify({ pid: 1, nonce: 'someone-else' }));
      assert.match(removeOwnedSync(dir2).refused ?? '', /marker/);
      rmSync(dir2, { recursive: true, force: true });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('sweeps only leftovers of dead owners: live owner, no marker, wrong prefix and symlinks are kept', () => {
    const parent = scratch();
    try {
      const mk = (name: string, marker?: object) => {
        const d = join(parent, name);
        mkdirSync(d);
        if (marker) writeFileSync(join(d, '.agentic-canary-owner.json'), JSON.stringify(marker));
        writeFileSync(join(d, 'f'), 'x');
        return d;
      };
      const dead = mk('.agentic-canary-dead', { pid: 2 ** 22 - 3, nonce: 'n' });
      const live = mk('.agentic-canary-live', { pid: process.ppid, nonce: 'n' });
      const unmarked = mk('.agentic-canary-unmarked');
      const other = mk('unrelated-dir', { pid: 2 ** 22 - 3, nonce: 'n' });
      const target = mk('target', { pid: 2 ** 22 - 3, nonce: 'n' });
      symlinkSync(target, join(parent, '.agentic-canary-link'));
      const r = sweepStaleOwnedDirs(parent, ['.agentic-canary-']);
      assert.deepEqual(r.removed, [dead]);
      assert.equal(existsSync(dead), false);
      for (const d of [live, unmarked, other, target]) assert.equal(existsSync(d), true, d);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('removes owned directories on process exit and on SIGTERM', { timeout: 60_000 }, async () => {
    const parent = scratch();
    try {
      const lib = join(import.meta.dirname, 'canary-fs.ts');
      for (const how of ['exit', 'sigterm']) {
        const script = `import { createOwnedDir } from ${JSON.stringify(lib)}; const d = createOwnedDir(${JSON.stringify(parent)}, '.agentic-canary-${how}-'); console.log(d); ${how === 'exit' ? '' : 'setInterval(() => {}, 1000);'}`;
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
        const dir = await new Promise<string>((resolve) => child.stdout.once('data', (b) => resolve(String(b).trim())));
        assert.ok(existsSync(dir), 'created');
        if (how === 'sigterm') child.kill('SIGTERM');
        await new Promise((r) => child.once('exit', r));
        assert.equal(existsSync(dir), false, `${how}: removed`);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('detects a byte-identical copy of the Codex login without exposing it, and ignores synthetic and symlinked files', () => {
    const parent = scratch();
    try {
      const fakeHome = join(parent, 'codex-home');
      mkdirSync(fakeHome);
      writeFileSync(join(fakeHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-test-not-a-real-key"}');
      const env = { CODEX_HOME: fakeHome } as NodeJS.ProcessEnv;
      const work = join(parent, 'work');
      mkdirSync(join(work, 'copy'), { recursive: true });
      mkdirSync(join(work, 'synthetic'), { recursive: true });
      writeFileSync(join(work, 'copy', 'auth.json'), '{"OPENAI_API_KEY":"sk-test-not-a-real-key"}');
      writeFileSync(join(work, 'synthetic', 'auth.json'), '{"OPENAI_API_KEY":"sk-m87synthetic-abc"}');
      symlinkSync(join(fakeHome, 'auth.json'), join(work, 'linked-auth.json'));
      assert.deepEqual(findRealCredentialCopies([work], env), [join(work, 'copy', 'auth.json')]);
      assert.deepEqual(findRealCredentialCopies([work], { CODEX_HOME: join(parent, 'nonexistent') } as NodeJS.ProcessEnv), [], 'no login, nothing to compare');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('after the real-CLI canaries have run, nothing of theirs is left under the home directory or the temp dirs, and no real login copy exists', { timeout: 400_000 }, async () => {
    const { readIsolationCanary, launcherAuthCheck, verifierSandboxProblems } = await import('../provider-smoke/read-isolation-canary.ts');
    const home = realpathSync(homedir());
    const before = new Set(readdirLeftovers(home));
    await verifierSandboxProblems();
    await launcherAuthCheck();
    await readIsolationCanary({ mode: 'allowlist' });
    const after = readdirLeftovers(home).filter((n) => !before.has(n));
    assert.deepEqual(after, [], 'canary directories left under the home directory');
    assert.deepEqual(findRealCredentialCopies([home, realpathSync(tmpdir())], process.env, 3), [], 'a copy of the real Codex login exists');
  });
});

import { readdirSync } from 'node:fs';
function readdirLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.startsWith('.agentic-canary-') || n.startsWith('.agentic-vcanary-'));
}

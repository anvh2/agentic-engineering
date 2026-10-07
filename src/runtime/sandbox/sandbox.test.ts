import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSandboxStatusForTests, runSandboxedCommand, sandboxStatus } from './sandbox.ts';

/**
 * The OS sandbox around model-generated code. Every property is checked by actually attempting the forbidden action
 * from inside the sandbox (no mocks), plus the fail-closed paths: a missing sandbox binary and a "sandbox" that does
 * not isolate must both result in the command never running.
 */

const darwin = process.platform === 'darwin';
const sh = (root: string, script: string, timeoutMs = 20_000) => runSandboxedCommand('/bin/sh', ['-c', script], { cwd: root, root, timeoutMs });

describe('sandbox: availability', () => {
  it(darwin ? 'is available on macOS (functional self-test passed)' : 'is reported unavailable on platforms without a supported sandbox', async () => {
    const status = await sandboxStatus();
    assert.equal(status.available, darwin, JSON.stringify(status));
  });
});

describe('sandbox: isolation properties', { skip: !darwin && 'macOS only' }, () => {
  let base: string;
  let root: string;
  let outside: string;
  before(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'sbx-test-')));
    root = join(base, 'root');
    outside = join(base, 'outside');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), '[core]\n');
    await mkdir(join(root, 'node_modules', 'jest'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(root, 'escape'));
  });
  after(() => rm(base, { recursive: true, force: true }));

  it('writes inside the root succeed', async () => {
    const r = await sh(root, 'echo ok > src/a.js && echo ok > .gitignore');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(await readFile(join(root, 'src', 'a.js'), 'utf8'), 'ok\n');
  });

  it('writes outside the root are denied, including through a symlink inside the root', async () => {
    const r1 = await sh(root, `echo leak > '${outside}/direct.txt'`);
    const r2 = await sh(root, 'echo leak > escape/via-link.txt');
    assert.notEqual(r1.exitCode, 0);
    assert.notEqual(r2.exitCode, 0);
    assert.deepEqual(readdirSync(outside), []);
  });

  it('the root .git and node_modules are not writable even though they are inside the root', async () => {
    const r1 = await sh(root, 'echo pwned >> .git/config');
    const r2 = await sh(root, 'echo pwned > node_modules/jest/index.js');
    assert.notEqual(r1.exitCode, 0);
    assert.notEqual(r2.exitCode, 0);
    assert.equal(await readFile(join(root, '.git', 'config'), 'utf8'), '[core]\n');
    assert.equal(existsSync(join(root, 'node_modules', 'jest', 'index.js')), false);
  });

  it('gets a private, writable TMPDIR that is removed afterwards', async () => {
    const r = await sh(root, 'echo x > "$TMPDIR/t" && echo "$TMPDIR"');
    assert.equal(r.exitCode, 0, r.stderr);
    const dir = r.stdout.trim();
    assert.match(dir, /harness-sbx-/);
    assert.equal(existsSync(dir), false, 'temp dir cleaned up');
  });

  it('has no network, loopback included (a local service is reachable on loopback)', async () => {
    const server: Server = createServer((s) => s.end('hello'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await runSandboxedCommand('node', ['-e', `require('net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(3)})`], { cwd: root, root, timeoutMs: 20_000 });
      assert.doesNotMatch(r.stdout, /CONNECTED/);
      assert.equal(r.exitCode, 3, r.stdout + r.stderr);
    } finally {
      server.close();
    }
  });

  it('cannot read credential stores of the user, nor .env files outside its root', async () => {
    const claudeDir = join(homedir(), '.claude');
    if (existsSync(claudeDir)) {
      const r = await sh(root, `ls '${claudeDir}' > /dev/null`);
      assert.notEqual(r.exitCode, 0, `listing ${claudeDir} must be denied`);
    }
    await writeFile(join(outside, '.env'), 'API_KEY=outside-secret\n');
    await writeFile(join(root, '.env'), 'LOCAL=ok\n');
    const outsideRead = await sh(root, `cat '${outside}/.env'`);
    const insideRead = await sh(root, 'cat .env');
    assert.doesNotMatch(outsideRead.stdout, /outside-secret/);
    assert.notEqual(outsideRead.exitCode, 0);
    assert.equal(insideRead.stdout, 'LOCAL=ok\n', 'the repository under test may read its own .env');
  });

  it('does not inherit the harness environment (secrets are not passed down)', async () => {
    process.env.HARNESS_TEST_SECRET_TOKEN = 'super-secret-value-123';
    process.env.NODE_OPTIONS = '--require /nonexistent-hook.js';
    try {
      const r = await sh(root, 'env');
      assert.equal(r.exitCode, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /super-secret-value-123|HARNESS_TEST_SECRET_TOKEN|NODE_OPTIONS/);
      assert.match(r.stdout, /^PATH=/m);
    } finally {
      delete process.env.HARNESS_TEST_SECRET_TOKEN;
      delete process.env.NODE_OPTIONS;
    }
  });

  it('cannot signal or inspect processes outside the sandbox, but manages its own children', async () => {
    const r = await sh(root, `kill -0 ${process.pid} && echo SIGNALLED; ps -o command= -p ${process.pid} | grep -q node && echo INSPECTED; sleep 30 & C=$!; kill $C && echo OWN_CHILD_OK`);
    assert.doesNotMatch(r.stdout, /SIGNALLED/);
    assert.doesNotMatch(r.stdout, /INSPECTED/);
    assert.match(r.stdout, /OWN_CHILD_OK/);
  });

  it('enforces the timeout by killing the whole process group', async () => {
    const r = await sh(root, 'sleep 30', 300);
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
  });

  it('a command that is not installed is a start failure (exitCode null), not a sandbox error', async () => {
    const r = await runSandboxedCommand('definitely-not-a-real-binary-xyz', [], { cwd: root, root, timeoutMs: 5_000 });
    assert.equal(r.exitCode, null);
    assert.equal(r.sandboxUnavailable, undefined);
    assert.match(r.stderr, /not found/);
  });
});

describe('sandbox: real toolchains work inside it', { skip: !darwin && 'macOS only' }, () => {
  let mod: string;
  before(async () => {
    mod = realpathSync(await mkdtemp(join(tmpdir(), 'sbx-go-')));
    const ladder = join(import.meta.dirname, '..', '..', '..', 'tests', 'bench', 'go-ladder', 'L4');
    await cp(join(ladder, 'stub'), mod, { recursive: true });
    await cp(join(ladder, 'reference', 'internal', 'cart', 'cart.go'), join(mod, 'internal', 'cart', 'cart.go'));
  });
  after(() => rm(mod, { recursive: true, force: true }));

  it('go test passes in a fresh private build cache, with no network', async () => {
    const r = await runSandboxedCommand('go', ['test', '-count=1', './...'], { cwd: mod, root: mod, timeoutMs: 120_000 });
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok\s/m);
  });

  it('gofmt can rewrite a file inside the root', async () => {
    const file = join(mod, 'internal', 'cart', 'cart.go');
    const before = await readFile(file, 'utf8');
    await writeFile(file, before.replace(/\t/g, '    '));
    const r = await runSandboxedCommand('gofmt', ['-w', 'internal/cart/cart.go'], { cwd: mod, root: mod, timeoutMs: 20_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(await readFile(file, 'utf8'), before);
  });

  it('node runs and child processes with IPC work (test-runner worker pools)', async () => {
    await writeFile(join(mod, 'child.js'), "process.on('message', (m) => { process.send(m * 2); process.exit(0); });\n");
    const r = await runSandboxedCommand('node', ['-e', "const c=require('child_process').fork('./child.js');c.on('message',m=>console.log('IPC',m));c.send(21)"], { cwd: mod, root: mod, timeoutMs: 20_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /IPC 42/);
  });
});

describe('sandbox: fail closed', { skip: !darwin && 'macOS only' }, () => {
  let base: string;
  before(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'sbx-failclosed-')));
  });
  afterEach(() => {
    delete process.env.HARNESS_SANDBOX_EXEC;
    resetSandboxStatusForTests();
  });
  after(() => rm(base, { recursive: true, force: true }));

  it('a missing sandbox binary means nothing runs', async () => {
    process.env.HARNESS_SANDBOX_EXEC = join(base, 'does-not-exist');
    resetSandboxStatusForTests();
    const r = await sh(base, 'echo ran > ran.txt');
    assert.equal(r.sandboxUnavailable, true);
    assert.equal(r.success, false);
    assert.match(r.stderr, /OS sandbox unavailable/);
    assert.equal(existsSync(join(base, 'ran.txt')), false, 'the command never executed');
  });

  it('a "sandbox" that does not actually isolate fails the self-test, so nothing runs', async () => {
    // Accepts sandbox-exec's arguments and runs the command WITHOUT any profile.
    const fake = join(base, 'fake-sandbox-exec');
    await writeFile(fake, '#!/bin/sh\nwhile [ "$1" = "-D" ]; do shift 2; done\n[ "$1" = "-p" ] && shift 2\nexec "$@"\n');
    await chmod(fake, 0o755);
    process.env.HARNESS_SANDBOX_EXEC = fake;
    resetSandboxStatusForTests();
    const status = await sandboxStatus();
    assert.equal(status.available, false);
    assert.match(status.reason ?? '', /not blocked/);
    const r = await sh(base, 'echo ran > ran2.txt');
    assert.equal(r.sandboxUnavailable, true);
    assert.equal(existsSync(join(base, 'ran2.txt')), false);
  });
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { tempDir } from '../../runtime/scheduler/test-helpers.ts';
import { buildChildEnv, runProviderProcess } from './process.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const waitDead = async (pid: number, ms = 3_000) => {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
};
const sh = (script: string, extra: Partial<Parameters<typeof runProviderProcess>[0]> = {}) => runProviderProcess({ command: 'sh', args: ['-c', script], cwd: tempDir('proc-'), timeoutMs: 10_000, termGraceMs: 200, killWaitMs: 1_000, ...extra });

describe('runProviderProcess', () => {
  it('captures output and exit code, delivers stdin', async () => {
    const r = await sh('read x; echo "got:$x"; echo err >&2; exit 3', { stdin: 'hello\n' });
    assert.equal(r.exitCode, 3);
    assert.equal(r.stdout.trim(), 'got:hello');
    assert.equal(r.stderr.trim(), 'err');
    assert.equal(r.terminatedBy, 'exit');
    assert.equal(r.stillRunning, false);
  });

  it('reports a missing binary as a spawn error and runs nothing', async () => {
    const r = await runProviderProcess({ command: '/definitely/not/a/binary', args: [], cwd: tempDir('proc-'), timeoutMs: 1_000 });
    assert.ok(r.spawnError);
    assert.equal(r.exitCode, null);
  });

  it('timeout: SIGTERM first; a process that honors it exits without SIGKILL', async () => {
    const r = await sh('sleep 30', { timeoutMs: 100 });
    assert.equal(r.timedOut, true);
    assert.equal(r.terminatedBy, 'SIGTERM');
    assert.equal(r.stillRunning, false);
    assert.ok(r.durationMs < 3_000);
  });

  it('a process that ignores SIGTERM is SIGKILLed after the grace period, grandchildren included', async () => {
    const r = await sh(`trap '' TERM; sleep 60 & echo $! ; wait`, { timeoutMs: 100, termGraceMs: 150 });
    assert.equal(r.timedOut, true);
    assert.equal(r.terminatedBy, 'SIGKILL');
    const grandchild = Number(r.stdout.trim());
    assert.ok(grandchild > 0);
    assert.equal(await waitDead(grandchild), true, 'the whole process group died, not just the leader');
  });

  it('abort behaves like a timeout and is reported as aborted', async () => {
    const c = new AbortController();
    const pending = sh('sleep 30', { signal: c.signal });
    setTimeout(() => c.abort(), 50);
    const r = await pending;
    assert.equal(r.aborted, true);
    assert.equal(r.timedOut, false);
    assert.notEqual(r.terminatedBy, 'exit');
  });

  it('an already-aborted signal never launches the process', async () => {
    const r = await sh('echo ran', { signal: AbortSignal.abort() });
    assert.equal(r.aborted, true);
    assert.equal(r.pid, undefined);
    assert.equal(r.stdout, '');
  });

  it('never signals a process it did not start (unrelated sentinel survives a timeout kill)', async () => {
    const sentinel = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
    try {
      await sh('sleep 30', { timeoutMs: 80 });
      assert.equal(alive(sentinel.pid!), true, 'a process outside the call is untouched');
    } finally {
      process.kill(-sentinel.pid!, 'SIGKILL');
    }
  });

  it('leftover helpers in the group do not outlive a call that exited normally', async () => {
    const r = await sh('sleep 60 & echo $!; exit 0');
    assert.equal(r.exitCode, 0);
    assert.equal(await waitDead(Number(r.stdout.trim())), true);
  });

  it('bounds captured output', async () => {
    const r = await sh('yes x | head -c 500000', { maxOutputBytes: 1_000 });
    assert.ok(r.stdout.length <= 1_000);
    assert.equal(r.outputTruncated, true);
  });
});

describe('child environment', () => {
  const parent = { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'sk-secret', GEMINI_API_KEY: 'g-secret', AWS_SECRET_ACCESS_KEY: 'a-secret', LANG: 'C' } as NodeJS.ProcessEnv;

  it('forwards only the allowlist; credentials need an explicit pass', () => {
    const env = buildChildEnv(parent);
    assert.deepEqual(Object.keys(env).sort(), ['CI', 'HOME', 'LANG', 'NO_COLOR', 'PATH']);
    assert.equal(buildChildEnv(parent, ['OPENAI_API_KEY']).OPENAI_API_KEY, 'sk-secret');
    assert.equal(buildChildEnv(parent, ['OPENAI_API_KEY']).GEMINI_API_KEY, undefined);
  });

  it('the child really does not see unlisted secrets', async () => {
    const r = await sh('echo "[$OPENAI_API_KEY][$GEMINI_API_KEY][$HOME]"', { parentEnv: parent });
    assert.equal(r.stdout.trim(), '[][][/h]');
  });
});

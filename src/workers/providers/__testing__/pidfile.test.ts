import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAlive, readPid } from './pidfile.ts';

const dir = mkdtempSync(join(tmpdir(), 'pidfile-test-'));

test('readPid never reports a partial or empty file as a pid (the CI race: empty read -> pid 0 -> "alive" forever)', () => {
  const f = join(dir, 'p');
  assert.equal(readPid(join(dir, 'missing')), undefined);
  for (const content of ['', '   ', '0', '1', '-5', '12abc', '1.5', '99999999999999999999', 'NaN']) {
    writeFileSync(f, content);
    assert.equal(readPid(f), undefined, JSON.stringify(content));
  }
  writeFileSync(f, '4242\n');
  assert.equal(readPid(f), 4242);
});

test('isAlive refuses the pids that address process groups, so a bad pid cannot pass vacuously', () => {
  assert.equal(process.kill(0, 0), true, 'the hazard is real: kill(0, 0) succeeds for anyone');
  for (const pid of [0, 1, -1, -1234, NaN, 1.5, Infinity]) assert.throws(() => isAlive(pid), /refusing pid/, String(pid));
  assert.equal(isAlive(process.pid), true);
});

test('isAlive turns false for a process that really exited', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 50)'], { stdio: 'ignore' });
  const pid = child.pid!;
  assert.equal(isAlive(pid), true);
  await new Promise((r) => child.once('close', r));
  assert.equal(isAlive(pid), false);
});

test('the fake provider CLIs publish their pid atomically: the first read after the file exists is never empty', async () => {
  // Same wait the scheduler tests used to do: poll for EXISTENCE, then read once. With a plain writeFileSync about 3% of reads were
  // empty on a developer machine (probabilistic against the old fakes, deterministic against the fixed ones), so 100 spawns per fake.
  const argsFor = (fake: string) => (fake === 'fake-gemini.mjs' ? ['--prompt', 'x'] : ['exec', '--cd', dir]);
  for (const fake of ['fake-gemini.mjs', 'fake-codex.mjs']) {
    let empty = 0;
    for (let i = 0; i < 100; i++) {
      const f = join(dir, `${fake}-${i}`);
      const child = spawn(process.execPath, [join(import.meta.dirname, fake), ...argsFor(fake)], { stdio: 'ignore', env: { ...process.env, FAKE_MODE: 'hang', FAKE_PIDFILE: f } });
      const deadline = Date.now() + 5000;
      while (!existsSync(f) && Date.now() < deadline) await new Promise((r) => setImmediate(r));
      const raw = existsSync(f) ? readFileSync(f, 'utf8') : '<never published>';
      if (raw !== String(child.pid)) empty++;
      child.kill('SIGKILL');
      await new Promise((r) => child.once('close', r));
    }
    assert.equal(empty, 0, `${fake}: every first read returned the complete pid`);
  }
});

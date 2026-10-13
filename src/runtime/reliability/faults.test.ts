import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runProviderProcess } from '../../workers/providers/process.ts';
import { tempDir } from '../scheduler/test-helpers.ts';
import { FAULTS_ENABLE_ENV, FAULTS_ENV, FAULTS_LOG_ENV, faultEnv, faultPoint, parseFaultPlan } from './faults.ts';

const saved = { ...process.env };
afterEach(() => {
  for (const k of [FAULTS_ENABLE_ENV, FAULTS_ENV, FAULTS_LOG_ENV]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('M10 fault points', () => {
  it('parseFaultPlan refuses unknown points, unknown fields and bad values', () => {
    assert.throws(() => parseFaultPlan('{"provider.befor-spawn":{"delayMs":1}}'), /unknown fault point/);
    assert.throws(() => parseFaultPlan('{"provider.before-spawn":{"sleep":1}}'), /unknown action field/);
    assert.throws(() => parseFaultPlan('{"provider.before-spawn":{"delayMs":-1}}'), /non-negative/);
    assert.throws(() => parseFaultPlan('{"provider.before-spawn":{"times":0}}'), /positive integer/);
    assert.throws(() => parseFaultPlan('[]'), /must be an object/);
    assert.throws(() => faultEnv({ 'nope': {} } as never), /unknown fault point/, 'refused where the plan is written');
  });

  it('times limits the firings per process; the log records each one', async () => {
    const log = join(tempDir('faults-'), 'f.jsonl');
    const env = { ...faultEnv({ 'runner.after-permit': { throw: 'once only', times: 1 } }, log) };
    await assert.rejects(faultPoint('runner.after-permit', { env }), /injected fault at runner.after-permit: once only/);
    await faultPoint('runner.after-permit', { env }); // second time: inert
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
  });

  it('an already-aborted signal rejects at once with its reason', async () => {
    const env = faultEnv({ 'runner.before-permit': { delayMs: 60_000 } });
    const ac = new AbortController();
    ac.abort(new Error('already gone'));
    await assert.rejects(faultPoint('runner.before-permit', { env, signal: ac.signal }), /already gone/);
  });

  it('the launcher never spawns when the cancel arrives while it is held at provider.before-spawn', async () => {
    const dir = tempDir('faults-spawn-');
    const marker = join(dir, 'spawned');
    Object.assign(process.env, faultEnv({ 'provider.before-spawn': { delayMs: 60_000 } }, join(dir, 'f.jsonl')));
    const ac = new AbortController();
    const pending = runProviderProcess({ command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`], cwd: dir, timeoutMs: 10_000, signal: ac.signal, faultPoint: 'provider.before-spawn' });
    setTimeout(() => ac.abort(new Error('task timeout')), 50);
    const r = await pending;
    assert.equal(r.aborted, true);
    assert.equal(r.pid, undefined, 'no process');
    assert.match(r.stderr, /not started: cancelled before launch/);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(existsSync(marker), false, 'nothing ran');
    assert.equal(readFileSync(join(dir, 'f.jsonl'), 'utf8').trim().split('\n').length, 1, 'the boundary was reached once');
  });

  it('a launch that does not opt in (probes) is never affected by a plan', async () => {
    const dir = tempDir('faults-probe-');
    Object.assign(process.env, faultEnv({ 'provider.before-spawn': { delayMs: 60_000 } }, join(dir, 'f.jsonl')));
    const t0 = Date.now();
    const r = await runProviderProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: dir, timeoutMs: 10_000 });
    assert.equal(r.exitCode, 0);
    assert.ok(Date.now() - t0 < 5_000);
    assert.equal(existsSync(join(dir, 'f.jsonl')), false);
  });

  it('without the enable switch a plan in the environment does nothing (production)', async () => {
    process.env[FAULTS_ENV] = JSON.stringify({ 'runner.before-permit': { throw: 'must not fire' } });
    delete process.env[FAULTS_ENABLE_ENV];
    await faultPoint('runner.before-permit');
    process.env[FAULTS_ENABLE_ENV] = 'yes'; // only the exact value enables it
    await faultPoint('runner.before-permit');
  });
});

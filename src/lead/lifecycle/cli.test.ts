import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { tempDir } from '../../runtime/scheduler/test-helpers.ts';
import { EXIT, runLifecycleCommand, type LifecycleCliContext } from './cli.ts';
import { GOOD, goRunner, harness, type Harness } from './__testing__/fixture.ts';

const solutions = { pad: [GOOD.pad], title: [GOOD.title], describe: [GOOD.describe] };

function cli(h: Harness) {
  const out: string[] = [];
  const err: string[] = [];
  const dir = tempDir('lc-cli-');
  const ctx: LifecycleCliContext = {
    store: h.store,
    worktrees: h.worktrees,
    workdir: dir,
    cwd: dir,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    config: { maxReviewCorrections: 2 },
    run: goRunner,
    actor: 'operator',
    makeRuntime: () => ({ scheduler: h.scheduler }),
  };
  const oracleFile = join(dir, 'oracle.json');
  writeFileSync(oracleFile, JSON.stringify({ dir: h.oracleDir, files: ['acceptance_test.go'], commands: [['go', 'vet', './...'], ['go', 'test', '-count=1', './...']] }));
  return { ctx, out, err, dir, oracleFile, run: (...args: string[]) => runLifecycleCommand(args, ctx) };
}

describe('M8.5 lead lifecycle CLI', () => {
  it('pin -> run -> status drives one disposable objective to ACCEPTED (exit 0) and writes the verdict file', async () => {
    const h = harness({ solutions });
    const c = cli(h);
    assert.equal(await c.run('pin', 'obj1', '--oracle', c.oracleFile), 0);
    assert.match(c.out.join('\n'), /oracle [0-9a-f]{12} pinned \(1 file\(s\)\)/);
    assert.match(c.out.join('\n'), /acceptance_test\.go {2}sha256 [0-9a-f]{64}/);
    c.out.length = 0;

    assert.equal(await c.run('run', 'obj1'), EXIT.ACCEPTED);
    const text = c.out.join('\n');
    assert.match(text, /objective obj1: ACCEPTED \(accepted\)/);
    assert.match(text, /candidate [0-9a-f]{10}: PASS go vet \.\/\.\.\. -> 0 .*go test -count=1 \.\/\.\.\. -> 0/);
    assert.match(text, /negative control [0-9a-f]{10}: failed as it must/);
    assert.match(text, /evidence [0-9a-f]{64}/);
    const verdict = JSON.parse(readFileSync(join(c.dir, 'objectives', 'obj1', 'lifecycle-verdict-obj1.json'), 'utf8'));
    assert.equal(verdict.verdict, 'ACCEPTED');
    assert.ok(verdict.events.length > 5);

    c.out.length = 0;
    assert.equal(await c.run('status', 'obj1'), 0);
    assert.match(c.out.join('\n'), /objective obj1: ACCEPTED \(accepted\)/);
    assert.match(c.out.join('\n'), /DONE\s+describe/);
  });

  it('exit codes follow the verdict: a failed oracle is 1, a dead end is 3', async () => {
    const failing = harness({ solutions: { ...solutions, pad: [GOOD.padBytes] } });
    const a = cli(failing);
    await a.run('pin', 'obj1', '--oracle', a.oracleFile);
    assert.equal(await a.run('run', 'obj1'), EXIT.NOT_ACCEPTED);
    assert.match(a.out.join('\n'), /NOT_ACCEPTED \(oracle_failed\)/);

    const dead = harness({ solutions: { ...solutions, pad: [GOOD.padWrong] } });
    const b = cli(dead);
    await b.run('pin', 'obj1', '--oracle', b.oracleFile);
    assert.equal(await b.run('run', 'obj1'), EXIT.ESCALATED);
    assert.match(b.out.join('\n'), /ESCALATED \(task_dead_end\)/);
  });

  it('authorize / resume / cancel need a reason, and cancel ends the objective', async () => {
    const h = harness({ solutions });
    const c = cli(h);
    await c.run('pin', 'obj1', '--oracle', c.oracleFile);
    assert.equal(await c.run('authorize', 'obj1', 'pad'), EXIT.USAGE);
    assert.match(c.err.join('\n'), /needs a reason/);
    assert.equal(await c.run('authorize', 'obj1', 'pad', '--reason', 'ok'), 0);
    assert.equal(await c.run('resume', 'obj1', '--reason', 'x'), EXIT.USAGE, 'a PINNED objective cannot be resumed');
    assert.equal(await c.run('cancel', 'obj1', '--reason', ' '), EXIT.USAGE);
    assert.equal(await c.run('cancel', 'obj1', '--reason', 'not needed'), EXIT.CANCELLED);
    assert.equal(h.lifecycle.require('obj1').phase, 'CANCELLED');
    assert.equal(await c.run('run', 'obj1'), EXIT.CANCELLED);
    assert.equal(h.provider.calls.length, 0);
  });

  it('usage errors never touch state', async () => {
    const h = harness({ solutions });
    const c = cli(h);
    assert.equal(await c.run(), EXIT.USAGE);
    assert.equal(await c.run('pin', 'obj1'), EXIT.USAGE);
    assert.equal(await c.run('bogus', 'obj1'), EXIT.USAGE);
    assert.equal(await c.run('status', 'nope'), EXIT.USAGE);
    assert.equal(h.lifecycle.get('obj1'), undefined);
  });
});

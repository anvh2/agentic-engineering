import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { inspectChange } from '../review/change-review.ts';
import { taskSpecSchema } from '../scheduler/types.ts';
import { CAPACITY_CEILING, DEFAULT_DELEGATION_CAPACITY, capacityFindings, delegationCapacitySchema, describeCapacity, resolveCapacity, type DelegationCapacity } from './delegation-capacity.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('M9.0 delegation capacity policy', () => {
  it('missing policy: the conservative default applies and says so', () => {
    const r = resolveCapacity(undefined);
    assert.deepEqual(r, { ...DEFAULT_DELEGATION_CAPACITY, source: 'default' });
    assert.equal(r.warnChangedLinesPerFile, 80, 'the M8 review threshold is kept');
    assert.match(describeCapacity(r), /default policy/);
    assert.equal(taskSpecSchema.parse({ id: 't', title: 't' }).capacity, undefined, 'stored specs without a policy still parse');
    const [warn] = capacityFindings(new Map([['a.go', 81]]), r);
    assert.match(warn.detail, /default policy's warnChangedLinesPerFile of 80/);
  });

  it('an explicit policy is used as given and recorded as the task\'s own', () => {
    const r = resolveCapacity({ warnChangedLinesPerFile: 150, maxChangedLinesPerTask: 600 });
    assert.deepEqual(r, { warnChangedLinesPerFile: 150, maxChangedLinesPerTask: 600, source: 'task' });
    assert.deepEqual(taskSpecSchema.parse({ id: 't', title: 't', capacity: { warnChangedLinesPerFile: 150, maxChangedLinesPerTask: 600 } }).capacity, { warnChangedLinesPerFile: 150, maxChangedLinesPerTask: 600 });
  });

  it('a partial, incoherent or out-of-ceiling policy is rejected, never filled in with defaults', () => {
    const bad: unknown[] = [
      { warnChangedLinesPerFile: 100 },
      { maxChangedLinesPerTask: 100 },
      { warnChangedLinesPerFile: 500, maxChangedLinesPerTask: 100 },
      { warnChangedLinesPerFile: 10, maxChangedLinesPerTask: CAPACITY_CEILING.maxChangedLinesPerTask + 1 },
      { warnChangedLinesPerFile: 0, maxChangedLinesPerTask: 10 },
      { warnChangedLinesPerFile: 10, maxChangedLinesPerTask: 10, unlimited: true },
      { warnChangedLinesPerFile: 1.5, maxChangedLinesPerTask: 10 },
    ];
    for (const policy of bad) {
      assert.equal(delegationCapacitySchema.safeParse(policy).success, false, JSON.stringify(policy));
      assert.equal(taskSpecSchema.safeParse({ id: 't', title: 't', capacity: policy }).success, false, JSON.stringify(policy));
    }
  });

  it('at the limits nothing fires; one line over fires the quality warning and the hard block separately', () => {
    const p = resolveCapacity({ warnChangedLinesPerFile: 10, maxChangedLinesPerTask: 20 });
    assert.deepEqual(capacityFindings(new Map([['a.go', 10], ['b.go', 10]]), p), [], 'exactly at both limits is within them');
    assert.deepEqual(capacityFindings(new Map([['a.go', 11], ['b.go', 9]]), p).map((f) => `${f.severity}:${f.code}`), ['warn:too_large']);
    assert.deepEqual(capacityFindings(new Map([['a.go', 10], ['b.go', 11]]), p).map((f) => `${f.severity}:${f.code}`), ['warn:too_large', 'block:capacity_exceeded']);
    const hard = capacityFindings(new Map([['a.go', 7], ['b.go', 7], ['c.go', 7]]), p);
    assert.deepEqual(hard.map((f) => `${f.severity}:${f.code}`), ['block:capacity_exceeded'], 'the hard limit is per task, not per file');
    assert.match(hard[0].detail, /21 changed lines across 3 file\(s\).*escalated to a human/);
  });
});

describe('M9.0 delegation capacity in the review gate', () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  /** Adds exactly `n` lines to a committed one-line file (additions only, so the numstat count is exactly n). */
  async function inspectAdding(n: number, capacity?: DelegationCapacity) {
    const repo = mkdtempSync(join(tmpdir(), 'capacity-'));
    dirs.push(repo);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'p'));
    writeFileSync(join(repo, 'p/a.go'), 'package p\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    writeFileSync(join(repo, 'p/a.go'), `package p\n${Array.from({ length: n }, (_, i) => `var V${i} = ${i}`).join('\n')}\n`);
    return inspectChange({ repoRoot: repo, allowedFiles: ['p/a.go'], statusBefore: [], capacity: resolveCapacity(capacity) });
  }
  const codesOf = (i: Awaited<ReturnType<typeof inspectAdding>>) => i.findings.map((f) => `${f.severity}:${f.code}`);

  it('records the policy it judged by and the measured line counts', async () => {
    const i = await inspectAdding(5);
    assert.equal(i.capacity.source, 'default');
    assert.deepEqual(i.changedLines, { 'p/a.go': 5 });
    assert.deepEqual(codesOf(i), []);
  });

  it('missing policy: 80 lines pass, 81 lines are a repairable warning (the old behaviour, now explicit)', async () => {
    assert.deepEqual(codesOf(await inspectAdding(80)), []);
    assert.deepEqual(codesOf(await inspectAdding(81)), ['warn:too_large']);
  });

  it('a task policy raises the quality threshold; the hard limit blocks one line past it', async () => {
    const policy = { warnChangedLinesPerFile: 120, maxChangedLinesPerTask: 150 };
    assert.deepEqual(codesOf(await inspectAdding(120, policy)), []);
    assert.deepEqual(codesOf(await inspectAdding(150, policy)), ['warn:too_large']);
    const over = await inspectAdding(151, policy);
    assert.deepEqual(codesOf(over), ['warn:too_large', 'block:capacity_exceeded']);
    assert.match(over.findings.find((f) => f.code === 'capacity_exceeded')!.detail, /task policy's maxChangedLinesPerTask of 150/);
  });
});

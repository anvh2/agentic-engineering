import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HookSession, type HookPolicy } from './engineering-hooks.ts';
import { DurableHookLog } from './engineering-hooks-store.ts';

const policy: HookPolicy = { taskId: 't1', tools: ['readFile', 'writeFile'], paths: ['src/a.go'] };
const e = (seq: number, phase: string, extra: Record<string, unknown> = {}) => ({ sessionId: 's1', seq, phase, taskId: 't1', ...extra });
const write = { tool: 'writeFile', relativePath: 'src/a.go' };

test('accepted events are recorded once; a replay is flagged and writes nothing', () => {
  const db = new DatabaseSync(':memory:');
  const log = new DurableHookLog(db);
  assert.equal(log.accept(policy, 's1', e(0, 'SessionStart')).accepted, true);
  const first = log.accept(policy, 's1', e(1, 'PreToolUse', write));
  assert.deepEqual([first.accepted, first.replay], [true, undefined]);
  const again = log.accept(policy, 's1', e(1, 'PreToolUse', write));
  assert.deepEqual([again.accepted, again.replay], [true, true]);
  assert.equal(log.events('s1').length, 2);
});

test('rejected events are not recorded, and a conflicting event cannot overwrite history', () => {
  const log = new DurableHookLog(new DatabaseSync(':memory:'));
  log.accept(policy, 's1', e(0, 'SessionStart'));
  assert.equal(log.accept(policy, 's1', e(1, 'PreToolUse', { tool: 'shell' })).accepted, false);
  assert.equal(log.accept(policy, 's1', e(1, 'PreToolUse', { tool: 'writeFile' })).accepted, false, 'write without a path');
  assert.equal(log.events('s1').length, 1);
  log.accept(policy, 's1', e(1, 'PreToolUse', write));
  const conflict = log.accept(policy, 's1', e(1, 'PreToolUse', { tool: 'readFile' }));
  assert.equal(conflict.reason, 'conflicting event for this sequence number');
  assert.equal(log.events('s1')[1]!.tool, 'writeFile');
});

test('RESUME: after a restart (new connection, new objects) completed events replay without a second side effect and the session continues', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooklog-'));
  try {
    const file = join(dir, 'hooks.db');
    const before = new DurableHookLog(new DatabaseSync(file));
    before.accept(policy, 's1', e(0, 'SessionStart'));
    before.accept(policy, 's1', e(1, 'PreToolUse', write));
    // process "crashes" here: the tool call is open
    const after = new DurableHookLog(new DatabaseSync(file));
    const sideEffects: string[] = [];
    const run = (event: ReturnType<typeof e>) => { const d = after.accept(policy, 's1', event); if (d.accepted && !d.replay) sideEffects.push(`${event.phase}:${event.seq}`); return d; };
    assert.equal(run(e(0, 'SessionStart')).replay, true);
    assert.equal(run(e(1, 'PreToolUse', write)).replay, true);
    assert.deepEqual(sideEffects, [], 'nothing completed is executed again');
    assert.equal(run(e(2, 'SessionEnd')).reason, 'tool call still open', 'the open tool call survived the restart');
    assert.equal(run(e(2, 'PostToolUse', { ...write, outcome: 'ok' })).accepted, true);
    assert.equal(run(e(3, 'SessionEnd')).accepted, true);
    assert.deepEqual(sideEffects, ['PostToolUse:2', 'SessionEnd:3']);
    assert.equal(run(e(4, 'PreToolUse', write)).reason, 'session already ended');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the database forbids rewriting or deleting the log', () => {
  const db = new DatabaseSync(':memory:');
  const log = new DurableHookLog(db);
  log.accept(policy, 's1', e(0, 'SessionStart'));
  assert.throws(() => db.exec("UPDATE engineering_hook_events SET event_json='{}'"), /append only/);
  assert.throws(() => db.exec('DELETE FROM engineering_hook_events'), /append only/);
});

test('a corrupted or policy-incompatible log stops the session instead of being worked around', () => {
  const db = new DatabaseSync(':memory:');
  const log = new DurableHookLog(db);
  log.accept(policy, 's1', e(0, 'SessionStart'));
  log.accept(policy, 's1', e(1, 'PreToolUse', write));
  const narrower: HookPolicy = { ...policy, paths: [] };
  const d = log.accept(narrower, 's1', e(2, 'PostToolUse', { ...write, outcome: 'ok' }));
  assert.equal(d.accepted, false);
  assert.match(d.reason, /hook log unusable/);
  db.exec('DROP TRIGGER engineering_hook_events_no_update');
  db.exec("UPDATE engineering_hook_events SET event_json='{\"sessionId\":\"s1\",\"seq\":1,\"phase\":\"Bogus\",\"taskId\":\"t1\"}' WHERE seq=1");
  assert.match(log.accept(policy, 's1', e(2, 'SessionEnd')).reason, /hook log unusable/);
});

test('sessions are isolated from each other', () => {
  const log = new DurableHookLog(new DatabaseSync(':memory:'));
  log.accept(policy, 's1', e(0, 'SessionStart'));
  const other = log.accept(policy, 's2', { ...e(0, 'SessionStart'), sessionId: 's2' });
  assert.equal(other.accepted, true);
  assert.equal(log.accept(policy, 's2', e(1, 'PreToolUse', write)).reason, 'hook belongs to another session');
  assert.equal(log.events('s1').length, 1);
});

test('HookSession.restore refuses an invalid stored history', () => {
  assert.throws(() => HookSession.restore(policy, 's1', [e(1, 'PreToolUse', write)]), /not valid for this session/);
  assert.throws(() => HookSession.restore(policy, 's1', [e(0, 'SessionStart'), e(0, 'SessionStart')]), /not valid for this session/, 'a duplicated stored event is corruption, not a replay');
  assert.equal(HookSession.restore(policy, 's1', [e(0, 'SessionStart'), e(1, 'PreToolUse', write)]).next, 2);
});

test('F-22 a lock the store cannot take is a rejection and not an exception, and the log stays usable afterwards', () => {
  const db = new DatabaseSync(':memory:');
  const log = new DurableHookLog(db);
  db.exec('BEGIN'); // an enclosing transaction makes BEGIN IMMEDIATE fail
  const blocked = log.accept(policy, 's1', e(0, 'SessionStart'));
  assert.equal(blocked.accepted, false);
  assert.match(blocked.reason, /hook log unusable/);
  db.exec('ROLLBACK');
  assert.equal(log.accept(policy, 's1', e(0, 'SessionStart')).accepted, true);
  assert.equal(log.events('s1').length, 1);
});

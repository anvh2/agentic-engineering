import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HookSession, TOOL_CLASSES, compactSession, inspectHook, type HookPolicy } from './engineering-hooks.ts';

const policy: HookPolicy = { taskId: 't1', tools: ['readFile', 'writeFile', 'runGoTest'], paths: ['src/a.go'] };
const pre = { sessionId: 's1', seq: 1, phase: 'PreToolUse' as const, taskId: 't1', tool: 'writeFile', relativePath: 'src/a.go' };

test('tool, path and task scope are enforced for write-class tools', () => {
  assert.equal(inspectHook(pre, policy).accepted, true);
  assert.equal(inspectHook({ ...pre, tool: 'shell' }, policy).reason, 'unknown tool');
  assert.equal(inspectHook({ ...pre, tool: 'applyPatch' }, policy).reason, 'tool outside allowlist');
  assert.equal(inspectHook({ ...pre, relativePath: '../secrets' }, policy).accepted, false);
  assert.equal(inspectHook({ ...pre, relativePath: 'src/a.go/../secret' }, policy).accepted, false);
  assert.equal(inspectHook({ ...pre, relativePath: 'src/other.go' }, policy).reason, 'path outside allowlist');
  assert.equal(inspectHook({ ...pre, taskId: 'other' }, policy).accepted, false);
});

test('F-07 a write-class tool with no path is rejected instead of passing by omission', () => {
  const { relativePath: _omitted, ...noPath } = pre;
  assert.equal(inspectHook(noPath, policy).reason, 'write tool requires a path');
  assert.equal(inspectHook({ ...pre, relativePath: '' }, policy).accepted, false);
});

test('read and execute tools are allowed only when listed, and unknown tools are rejected even if listed', () => {
  assert.equal(inspectHook({ ...pre, tool: 'readFile', relativePath: undefined }, policy).accepted, true);
  assert.equal(inspectHook({ ...pre, tool: 'runGoTest', relativePath: undefined }, policy).accepted, true);
  assert.equal(inspectHook({ ...pre, tool: 'runPrettier' }, policy).reason, 'tool outside allowlist');
  assert.equal(inspectHook({ ...pre, tool: 'bash' }, { ...policy, tools: ['bash'] }).reason, 'unknown tool');
  assert.equal(TOOL_CLASSES['bash'], undefined);
});

test('malformed and malicious events are rejected without throwing', () => {
  const bad: unknown[] = [null, undefined, 'x', 7, [], {}, { ...pre, seq: -1 }, { ...pre, seq: 1.5 }, { ...pre, seq: '1' }, { ...pre, phase: 'Nope' },
    { ...pre, sessionId: '' }, { ...pre, sessionId: 'a b' }, { ...pre, extra: 'field' }, { ...pre, tool: 5 }, { ...pre, relativePath: '/etc/passwd' },
    { ...pre, relativePath: 'a\\b' }, { ...pre, relativePath: 'a\u0000b' }, { ...pre, relativePath: 'x'.repeat(500) }, { ...pre, outcome: 'maybe' },
    { ...pre, phase: 'SessionStart', tool: 'writeFile' }, { ...pre, phase: 'PreToolUse', outcome: 'ok' }, { ...pre, tool: undefined },
    JSON.parse('{"__proto__":{"x":1},"sessionId":"s","seq":0,"phase":"SessionStart","taskId":"t1"}')];
  for (const event of bad) assert.equal(inspectHook(event, policy).accepted, false, JSON.stringify(event));
  const cyclic: Record<string, unknown> = { ...pre }; cyclic.self = cyclic;
  assert.equal(inspectHook(cyclic, policy).accepted, false);
});

test('fingerprint does not depend on key order', () => {
  const reordered = { relativePath: pre.relativePath, tool: pre.tool, taskId: pre.taskId, phase: pre.phase, seq: pre.seq, sessionId: pre.sessionId };
  assert.equal(inspectHook(pre, policy).eventFingerprint, inspectHook(reordered, policy).eventFingerprint);
});

const start = { sessionId: 's1', seq: 0, phase: 'SessionStart' as const, taskId: 't1' };
const post = { ...pre, seq: 2, phase: 'PostToolUse' as const, outcome: 'ok' as const };

test('session enforces order, pairing and idempotent replay', () => {
  const s = new HookSession(policy, 's1');
  assert.equal(s.accept({ ...start, seq: 1 }).reason, 'out-of-order sequence');
  assert.equal(s.accept(pre).accepted, false, 'must begin with SessionStart');
  assert.equal(s.accept(start).accepted, true);
  assert.equal(s.accept(pre).accepted, true);
  const replay = s.accept(pre);
  assert.deepEqual([replay.accepted, replay.replay], [true, true], 'replay is acknowledged but flagged so no second side effect runs');
  assert.equal(s.accept({ ...pre, relativePath: 'src/a.go', tool: 'writeFile', outcome: undefined, seq: 1, taskId: 't1', phase: 'PreToolUse', sessionId: 's1' }).replay, true);
  assert.equal(s.accept({ ...post, tool: 'readFile' }).reason, 'PostToolUse without matching PreToolUse');
  assert.equal(s.accept({ ...pre, seq: 2 }).reason, 'previous tool call has no PostToolUse');
  assert.equal(s.accept({ ...start, seq: 2, phase: 'SessionEnd' }).reason, 'tool call still open');
  assert.equal(s.accept(post).accepted, true);
  assert.equal(s.accept({ ...start, seq: 3, phase: 'SessionEnd' }).accepted, true);
  assert.equal(s.accept({ ...pre, seq: 4 }).reason, 'session already ended');
});

test('a conflicting event cannot overwrite an accepted sequence number, and other sessions are refused', () => {
  const s = new HookSession(policy, 's1');
  s.accept(start);
  s.accept(pre);
  assert.equal(s.accept({ ...pre, tool: 'readFile', relativePath: undefined }).reason, 'conflicting event for this sequence number');
  assert.equal(s.accept({ ...start, sessionId: 's2' }).reason, 'hook belongs to another session');
  assert.throws(() => new HookSession(policy, '../x'), /session id/);
});

test('compaction preserves verified and unverified task status without truncation or credentials', () => {
  const data = { taskId: 't1', checkpointDigest: 'a'.repeat(64), completedSteps: ['tested'], pendingSteps: ['review'], unverifiedClaims: ['model said pass'] };
  assert.deepEqual(JSON.parse(compactSession(data)).unverifiedClaims, ['model said pass']);
  assert.throws(() => compactSession({ ...data, pendingSteps: ['x'.repeat(5000)] }, 512), /truncate/);
  assert.throws(() => compactSession({ ...data, completedSteps: ['key ghp_' + 'a'.repeat(36)] }), /credential/);
  assert.throws(() => compactSession({ ...data, checkpointDigest: 'short' }), /checkpoint/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collaborationFixture } from '../__testing__/collaboration-fixture.ts';
import { collaborationSchema, orderedMessages, safeReference } from './collaboration-model.ts';

test('presentation contract strips private reasoning; chronology and duplicate replay are stable', () => {
  const fixture = structuredClone(collaborationFixture);
  fixture.threads[0].messages.reverse();
  fixture.threads[0].messages.push(fixture.threads[0].messages[0]);
  Object.assign(fixture.threads[0].messages[0], { chainOfThought: 'PRIVATE_HIDDEN', credentials: 'SECRET' });
  const parsed = collaborationSchema.parse(fixture);
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE_HIDDEN|SECRET/);
  assert.deepEqual(orderedMessages(parsed.threads[0]).map(m => m.id), ['m1', 'm2', 'm3']);
  assert.equal(parsed.meetings[0].usage.inputTokens, null);
  assert.equal(parsed.meetings[0].budgetExhausted, null);
  assert.equal(parsed.meetings[0].agreements.length, 0);
  assert.equal(parsed.meetings[0].disagreements[0].messageIds[0], 'm2');
});
test('evidence links never execute scripts or leak embedded URL credentials', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.example', '/\\evil.example', 'https://user:secret@example.com']) assert.equal(safeReference(bad), null);
  assert.equal(safeReference('/observability'), '/observability');
  assert.equal(safeReference('https://example.com/evidence'), 'https://example.com/evidence');
});
test('council meetings: LIVE/SCRIPTED is a closed set, an unverified record carries no council claims', () => {
  const fixture = structuredClone(collaborationFixture);
  const council = { meetingId: 'm12', mode: 'LIVE', model: 'ollama/qwen3:8b-ctx8192', recordPath: '.workdir/council/m12/record.md', workflowRuns: [{ runId: 'c895fd2e', url: 'http://127.0.0.1:4111/workflows/engineering-council-workflow/graph/c895fd2e' }], traceIds: ['95cac200f1a7996601deb3c1b3b513d8'], modelCalls: 7, failedCalls: 0, toolCalls: [{ tool: 'searchFiles', count: 2 }], integrity: 'RECORD_VERIFIED' };
  const live = collaborationSchema.parse({ ...fixture, meetings: [{ ...fixture.meetings[0], council }] });
  assert.equal(live.meetings[0].council?.mode, 'LIVE');
  assert.equal(live.meetings[0].councilIssue, null);
  assert.equal(collaborationSchema.parse(fixture).meetings[0].council, null, 'scheduler meetings carry no council block');
  assert.throws(() => collaborationSchema.parse({ ...fixture, meetings: [{ ...fixture.meetings[0], council: { ...council, mode: 'PAID' } }] }));
  assert.throws(() => collaborationSchema.parse({ ...fixture, meetings: [{ ...fixture.meetings[0], council: { ...council, integrity: 'VERIFIED' } }] }));
  const open = collaborationSchema.parse({ ...fixture, meetings: [{ ...fixture.meetings[0], council: { ...council, integrity: 'OPEN_UNRECORDED', workflowRuns: [], modelCalls: null, failedCalls: null, toolCalls: null } }] });
  assert.equal(open.meetings[0].council?.modelCalls, null, 'an open meeting has no call count rather than a guessed one');
});

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

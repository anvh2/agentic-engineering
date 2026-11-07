import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderSuggestions, suggestionsSchema } from './suggestions-model.ts';
import { inScope } from './view-state.ts';

const base = {
  kind: 'suggestion', meetingType: 'review_escalation', category: 'review_rejected', objectiveId: 'obj1', batchId: 'obj1', taskId: 'obj1.t1',
  attribution: { status: 'ATTRIBUTED', batchId: 'obj1', project: 'quota', reason: null }, reason: 'obj1.t1 is ESCALATED [review_rejected]: ...',
  evidence: [{ kind: 'task', ref: 'obj1.t1', detail: 'ESCALATED [review_rejected]' }], participants: [{ id: 'claude-engineering-lead', role: 'engineering_lead', note: 'chairs' }],
  decidedAt: null, decidedBy: null, decisionReason: null, sessionId: null,
};

test('a suggestion can only be a suggestion: anything else is rejected, never shown as a meeting', () => {
  assert.equal(suggestionsSchema.parse({ availability: 'CORRUPT', reason: 'guard missing', pending: 0, suggestions: [] }).availability, 'CORRUPT');
  const ok = suggestionsSchema.parse({ availability: 'AVAILABLE', reason: null, pending: 1, suggestions: [{ ...base, id: 's1', status: 'pending', createdAt: '2026-10-24T00:00:00.000Z' }] });
  assert.equal(ok.suggestions[0].kind, 'suggestion');
  assert.throws(() => suggestionsSchema.parse({ availability: 'AVAILABLE', reason: null, pending: 1, suggestions: [{ ...base, kind: 'meeting', id: 's1', status: 'pending', createdAt: '2026-10-24T00:00:00.000Z' }] }));
  assert.throws(() => suggestionsSchema.parse({ availability: 'AVAILABLE', reason: null, pending: 1, suggestions: [{ ...base, id: 's1', status: 'opened', createdAt: '2026-10-24T00:00:00.000Z' }] }));
});

test('pending suggestions come first, oldest first; scope follows persisted attribution only', () => {
  const items = suggestionsSchema.parse({ availability: 'AVAILABLE', reason: null, pending: 2, suggestions: [
    { ...base, id: 'dismissed', status: 'dismissed', createdAt: '2026-10-24T00:00:00.000Z', decidedAt: '2026-10-24T01:00:00.000Z', decidedBy: 'anvh2', decisionReason: 'known' },
    { ...base, id: 'newer', status: 'pending', createdAt: '2026-10-24T02:00:00.000Z' },
    { ...base, id: 'older', status: 'pending', createdAt: '2026-10-24T01:30:00.000Z', attribution: { status: 'UNATTRIBUTED', batchId: null, project: null, reason: 'x' } },
  ] }).suggestions;
  assert.deepEqual(orderSuggestions(items).map((s) => s.id), ['older', 'newer', 'dismissed']);
  assert.deepEqual(inScope(items, { project: 'quota', objective: '', unattributed: false }).map((s) => s.id), ['dismissed', 'newer']);
  assert.deepEqual(inScope(items, { project: '', objective: '', unattributed: true }).map((s) => s.id), ['older']);
});

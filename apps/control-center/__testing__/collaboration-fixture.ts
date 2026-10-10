import type { Collaboration } from '../src/collaboration-model.ts';

/** Synthetic records for tests ONLY. Never imported by production entrypoints. */
export const collaborationFixture: Collaboration = {
  availability: 'AVAILABLE', source: 'test-fixture', reason: null,
  threads: [{ id: 'thread-test', title: 'Synthetic parser review', objectiveId: 'B1', taskId: 'task-a',
    participants: [{ id: 'lead', name: 'Claude', role: 'Engineering Lead' }, { id: 'worker', name: 'Codex', role: 'Worker' }],
    messages: [
      { id: 'm1', threadId: 'thread-test', authorId: 'worker', at: '2026-10-10T01:00:00Z', type: 'PROPOSAL', text: 'Validate parser input before execution.', replyTo: null, references: [{ label: 'Evidence', url: '/observability' }], invocationId: 'test-call-1', traceUrl: '/observability', objectionState: null },
      { id: 'm2', threadId: 'thread-test', authorId: 'lead', at: '2026-10-10T01:01:00Z', type: 'OBJECTION', text: 'Cancellation coverage is still missing.', replyTo: 'm1', references: [], invocationId: null, traceUrl: null, objectionState: 'OPEN' },
      { id: 'm3', threadId: 'thread-test', authorId: 'lead', at: '2026-10-10T01:02:00Z', type: 'DECISION', text: 'Keep the review open pending evidence.', replyTo: 'm2', references: [], invocationId: null, traceUrl: null, objectionState: null },
    ] }],
  meetings: [{ id: 'meeting-test', title: 'Synthetic design meeting', threadId: 'thread-test', agenda: ['Review parser proposal'],
    participants: [{ id: 'lead', name: 'Claude', role: 'Chair' }, { id: 'worker', name: 'Codex', role: 'Proposer' }],
    startedAt: '2026-10-10T01:00:00Z', endedAt: null,
    rounds: [{ id: 'round-1', number: 1, state: 'PAUSED', messageIds: ['m1', 'm2', 'm3'] }], roundLimit: 2, invocationLimit: 4, invocationsUsed: null, budgetExhausted: null,
    agreements: [], disagreements: [{ text: 'Cancellation evidence remains unresolved.', messageIds: ['m2'] }],
    decisions: [{ text: 'Review remains open.', messageIds: ['m3'] }],
    actions: [{ id: 'action-test', text: 'Provide cancellation tests.', ownerId: 'worker', state: 'PENDING', messageIds: ['m3'] }],
    references: [{ label: 'Source trace', url: '/observability' }], usage: { inputTokens: null, outputTokens: null, source: 'unavailable', completeness: 'unavailable' },
  }],
};

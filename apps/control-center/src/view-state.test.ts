import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../src/integrations/control-center/__testing__/fixture.ts';
import { unknownUsage, type ModelCall } from '../../../src/integrations/control-center/contract.ts';
import { DEFAULT_VIEW, emptyReason, filterCalls, filteredUsage, filterMeetings, filterRuns, inScope, parseView, scopeQuery, serializeView } from './view-state.ts';
import { scopeIds } from './observations.ts';

test('view state round-trips through the URL, omits defaults, and rejects values it does not recognise', () => {
  const view = { ...DEFAULT_VIEW, section: 'runs' as const, project: 'eshop & co', objective: 'M5-ESHOP-2A', status: '__attention', updated: '24h' as const, mode: 'LIVE' as const };
  const search = serializeView(view);
  assert.deepEqual(parseView(search), view);
  assert.equal(serializeView(DEFAULT_VIEW), '');
  assert.equal(serializeView(parseView(search)), search, 'stable: equal views give equal links');
  const hostile = parseView('?section=admin&objective=..%2F..&updated=1y&mode=live&project=a%00b&decision=maybe&completeness=all');
  assert.deepEqual(
    [hostile.section, hostile.objective, hostile.updated, hostile.mode, hostile.project, hostile.decision, hostile.completeness],
    ['overview', '', '', '', '', '', ''],
  );
  // Unattributed is its own scope: it never carries a project or objective, so nothing is assigned to one.
  const unattributed = parseView('?scope=unattributed&project=proj&objective=B1');
  assert.deepEqual([unattributed.unattributed, unattributed.project, unattributed.objective], [true, '', '']);
  assert.equal(scopeQuery(unattributed), '');
  assert.equal(scopeQuery({ ...DEFAULT_VIEW, project: 'proj' }), '?project=proj');
  assert.equal(scopeQuery({ ...DEFAULT_VIEW, project: 'proj', objective: 'B1' }), '?project=proj&objectiveId=B1');
});

test('runs and usage filters narrow the scope; a filtered total never claims better coverage than its scope', (t) => {
  const f = fixture(); t.after(f.close);
  const now = 1_700_000_000_000;
  const snapshot = f.reader.snapshot({ project: 'proj' });
  assert.deepEqual(scopeIds(snapshot), ['B1', 'historical-smoke']);
  const tasks = snapshot.tasks.map((x, i) => ({ ...x, workerId: i === 0 ? 'w-1' : null, updatedAt: i === 0 ? now - 1000 : now - 90_000_000 }));
  assert.deepEqual(filterRuns(tasks, { status: '', provider: '', worker: 'w-1', updated: '' }, now).map((x) => x.id), [tasks[0]!.id]);
  assert.deepEqual(filterRuns(tasks, { status: '', provider: '', worker: '', updated: '24h' }, now).map((x) => x.id), [tasks[0]!.id]);
  assert.equal(filterRuns(tasks, { status: '', provider: 'codex', worker: '', updated: '' }, now).length, 0);
  const call = (id: string, objectiveId: string, provider: string, input: number | null, finishedAt: number): ModelCall => ({
    id, objectiveId, taskId: 'task-a', runId: 'r', workerId: 'w-1', provider, modelId: `${provider}-m`, attempt: 1, startedAt: finishedAt - 10, finishedAt, status: 'COMPLETED',
    usage: { ...unknownUsage(), inputTokens: input, outputTokens: input === null ? null : 1, latencyMs: 10, source: 'core.model-call', completeness: input === null ? 'partial' : 'complete' },
  });
  const calls = [call('a', 'B1', 'ollama', 10, now - 1000), call('b', 'historical-smoke', 'codex', 20, now - 90_000_000), call('c', 'B1', 'ollama', null, now - 2000)];
  assert.deepEqual(filterCalls(calls, { range: '24h', callProvider: '', model: '', callWorker: '', completeness: '' }, now).map((c) => c.id), ['a', 'c']);
  assert.deepEqual(filterCalls(calls, { range: '', callProvider: 'codex', model: '', callWorker: '', completeness: '' }, now).map((c) => c.id), ['b']);
  assert.deepEqual(filterCalls(calls, { range: '', callProvider: '', model: '', callWorker: '', completeness: 'partial' }, now).map((c) => c.id), ['c']);
  // A complete scope: the filtered sum is exact and complete.
  const complete = { ...snapshot, usage: { ...unknownUsage(), source: 'core.model-call' as const, completeness: 'complete' as const } };
  const both = filteredUsage(complete, [calls[0]!, calls[1]!]);
  assert.deepEqual([both.inputTokens, both.completeness], [30, 'complete']);
  // A partial scope: the same filtered set is never presented as complete.
  const partial = { ...complete, usage: { ...complete.usage, completeness: 'partial' as const } };
  assert.equal(filteredUsage(partial, [calls[0]!]).completeness, 'partial');
  // An unreported dimension stays unknown; it is never summed as zero.
  assert.equal(filteredUsage(complete, calls).inputTokens, null);
  // No scope: nothing is summed.
  assert.equal(filteredUsage(f.reader.snapshot(), calls).source, 'unavailable');
});

test('collaboration scope selects by persisted attribution only; unattributed records stay visible under their own scope', () => {
  const at = (project: string | null, batchId: string | null) => ({ attribution: { status: (project ? 'ATTRIBUTED' : 'UNATTRIBUTED') as 'ATTRIBUTED' | 'UNATTRIBUTED', batchId, project } });
  const items = [{ id: 'p1', ...at('proj', 'B1') }, { id: 'p2', ...at('proj', 'historical-smoke') }, { id: 'o', ...at('other', 'B9') }, { id: 'u', ...at(null, null) }];
  const ids = (v: Partial<typeof DEFAULT_VIEW>) => inScope(items, { ...DEFAULT_VIEW, ...v }).map((i) => i.id);
  assert.deepEqual(ids({ project: 'proj' }), ['p1', 'p2'], 'the unattributed record is not assigned to the selected project');
  assert.deepEqual(ids({ project: 'proj', objective: 'B1' }), ['p1']);
  assert.deepEqual(ids({ unattributed: true }), ['u']);
  assert.deepEqual(ids({}), ['p1', 'p2', 'o', 'u']);
  const meeting = (id: string, mode: 'LIVE' | 'SCRIPTED' | null, decisions: number, disagreements: number, participants: string[]) => ({
    id, ...at(null, null), participants: participants.map((p) => ({ id: p })), decisions: Array(decisions).fill(0), disagreements: Array(disagreements).fill(0), council: mode ? { mode } : null,
  });
  const meetings = [meeting('live', 'LIVE', 1, 0, ['architect']), meeting('scripted', 'SCRIPTED', 0, 1, ['lead']), meeting('plain', null, 0, 0, ['lead'])];
  const m = (v: Partial<typeof DEFAULT_VIEW>) => filterMeetings(meetings, { ...DEFAULT_VIEW, ...v }).map((x) => x.id);
  assert.deepEqual(m({ mode: 'LIVE' }), ['live']);
  assert.deepEqual(m({ mode: 'SCRIPTED' }), ['scripted'], 'a meeting without a verified council record has no mode');
  assert.deepEqual(m({ decision: 'recorded' }), ['live']);
  assert.deepEqual(m({ decision: 'none' }), ['scripted', 'plain']);
  assert.deepEqual(m({ decision: 'contested' }), ['scripted']);
  assert.deepEqual(m({ participant: 'lead' }), ['scripted', 'plain']);
});

test('empty states distinguish an unavailable source, no scope, no records, filtered out and telemetry not recorded', () => {
  assert.equal(emptyReason({ connected: false, scoped: true, inScope: 5, shown: 5 }), 'UNAVAILABLE');
  assert.equal(emptyReason({ connected: true, scoped: false, inScope: 0, shown: 0 }), 'NO_SCOPE');
  assert.equal(emptyReason({ connected: true, scoped: true, inScope: 0, shown: 0 }), 'NO_RECORDS');
  assert.equal(emptyReason({ connected: true, scoped: true, inScope: 3, shown: 0 }), 'FILTERED_OUT');
  assert.equal(emptyReason({ connected: true, scoped: true, inScope: 3, shown: 0, notRecorded: true }), 'NOT_RECORDED');
  assert.equal(emptyReason({ connected: true, scoped: true, inScope: 3, shown: 3 }), null);
});

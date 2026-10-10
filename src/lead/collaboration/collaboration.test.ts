import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ProviderDescriptor } from '../../runtime/execution/worker-provider.ts';
import type { MeetingRecord } from '../../runtime/collaboration/record.ts';
import { CollaborationError } from '../../runtime/collaboration/types.ts';
import { renderMeetingRecord } from './record-markdown.ts';
import { ENGINEERING_LEAD_ID, engineeringRoster } from './roster.ts';

const descriptor = (id: string, model: string): ProviderDescriptor => ({
  identity: { id, kind: id === 'ollama' ? 'local' : 'cloud', model },
  capabilities: { taskTypes: ['go'], editsFiles: 'directly', fileScope: 'os-sandbox', cancellation: 'process-group', usage: 'tokens', billing: 'unknown' },
  capacity: { resource: id, defaultPermits: 1 },
});

describe('M9 engineering roster', () => {
  it('derives identities from configured providers and operators, with fixed roles', () => {
    const dir = engineeringRoster({ workers: [descriptor('ollama', 'qwen3:8b'), descriptor('codex', 'UNKNOWN')], operators: ['anvh2'], extra: [{ id: 'reviewer-gemini', role: 'reviewer', provider: descriptor('gemini', 'gemini-3.5-flash-lite') }] });
    assert.deepEqual(dir.list().map((a) => [a.id, a.role, a.kind, a.provider ?? null, a.model ?? null]), [
      ['anvh2', 'operator', 'operator', null, null],
      [ENGINEERING_LEAD_ID, 'engineering_lead', 'lead', 'claude', 'UNKNOWN'],
      ['reviewer-gemini', 'reviewer', 'reviewer', 'gemini', 'gemini-3.5-flash-lite'],
      ['worker-codex', 'implementer', 'worker', 'codex', 'UNKNOWN'],
      ['worker-ollama', 'implementer', 'worker', 'ollama', 'qwen3:8b'],
    ]);
    assert.throws(() => engineeringRoster({ workers: [], operators: [ENGINEERING_LEAD_ID] }), (e: unknown) => e instanceof CollaborationError && e.code === 'duplicate');
    assert.throws(() => engineeringRoster({ workers: [], operators: ['bad id'] }), (e: unknown) => e instanceof CollaborationError && e.code === 'invalid');
  });
});

describe('M9 meeting record rendering', () => {
  it('renders the golden record with links and without claiming consensus that is not in the record', () => {
    const record = JSON.parse(readFileSync(fileURLToPath(new URL('../../runtime/collaboration/__testing__/meeting-record.fixture.json', import.meta.url)), 'utf8')) as MeetingRecord;
    const md = renderMeetingRecord(record);
    assert.match(md, /Outcome: \*\*decided\*\*/);
    assert.match(md, /CONTESTED, overruled objections m3/);
    assert.match(md, /\[9\/m3\] \*\*outstanding\*\* worker-codex on m2/);
    assert.match(md, /supported by reviewer \(not unanimous\)/);
    assert.match(md, /- \[ \] worker-codex: Add capacity/);
    assert.match(md, /grants no authority/);
    assert.doesNotMatch(md, /agreed by all|consensus/i);
  });
});

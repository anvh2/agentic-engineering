import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EngineeringKnowledgeCatalog, containsSuspiciousKnowledgeText, knowledgeLanguageForFiles } from './engineering-knowledge.ts';

const base = [
  { id: 'shared-rule', revision: 'v1', kind: 'rule' as const, language: 'common' as const, body: 'Check requirements.', source: 'ECC', approved: true },
  { id: 'go-rule', revision: 'v1', kind: 'skill' as const, language: 'go' as const, body: 'Use gofmt.', source: 'ECC', approved: true },
  { id: 'js-rule', revision: 'v1', kind: 'skill' as const, language: 'js' as const, body: 'Use Jest.', source: 'ECC', approved: true },
];

test('selects only requested relevant skills', () => {
  const registry = new EngineeringKnowledgeCatalog(base);
  const selected = registry.resolve({ language: 'go', ids: ['shared-rule', 'go-rule'] });
  assert.match(selected.text, /gofmt/);
  assert.doesNotMatch(selected.text, /Jest/);
  assert.throws(() => registry.resolve({ language: 'js', ids: ['go-rule'] }), /language mismatch/);
});

test('selection digest changes with content and revision, not with selection order or unrelated entries', () => {
  const registry = new EngineeringKnowledgeCatalog(base);
  const a = registry.resolve({ language: 'go', ids: ['go-rule', 'shared-rule'] });
  assert.equal(a.digest, registry.resolve({ language: 'go', ids: ['shared-rule', 'go-rule'] }).digest);
  const resolveIn = (entries: typeof base) => new EngineeringKnowledgeCatalog(entries).resolve({ language: 'go', ids: ['go-rule', 'shared-rule'] }).digest;
  assert.notEqual(a.digest, resolveIn(base.map((e) => (e.id === 'go-rule' ? { ...e, body: 'Changed rule.' } : e))));
  assert.notEqual(a.digest, resolveIn(base.map((e) => (e.id === 'go-rule' ? { ...e, revision: 'v2' } : e))));
  assert.notEqual(a.digest, resolveIn(base.map((e) => (e.id === 'go-rule' ? { ...e, source: 'elsewhere' } : e))));
  assert.equal(a.digest, resolveIn(base.map((e) => (e.id === 'js-rule' ? { ...e, body: 'Unrelated edit.' } : e))), 'an entry nobody selected cannot move the pin');
});

test('unapproved entries are not selectable', () => {
  const registry = new EngineeringKnowledgeCatalog([...base, { ...base[0]!, id: 'candidate', approved: false }]);
  assert.throws(() => registry.resolve({ language: 'go', ids: ['candidate'] }), /not approved/);
});

test('budget omissions are explicit and never silently truncate an entry', () => {
  const r = new EngineeringKnowledgeCatalog(base).resolve({ language: 'go', ids: ['go-rule'], maxBytes: 0 });
  assert.deepEqual(r.omitted, ['go-rule']);
  assert.equal(r.text, '');
  const exact = new EngineeringKnowledgeCatalog(base).resolve({ language: 'go', ids: ['go-rule'] });
  assert.equal(new EngineeringKnowledgeCatalog(base).resolve({ language: 'go', ids: ['go-rule'], maxBytes: exact.bytes }).omitted.length, 0);
  assert.equal(new EngineeringKnowledgeCatalog(base).resolve({ language: 'go', ids: ['go-rule'], maxBytes: exact.bytes - 1 }).omitted.length, 1);
});

test('selection input is validated: duplicates, bad budgets, unsupported language, hostile manifests', () => {
  const registry = new EngineeringKnowledgeCatalog(base);
  assert.throws(() => registry.resolve({ language: 'go', ids: ['go-rule', 'go-rule'] }), /duplicate/);
  assert.throws(() => registry.resolve({ language: 'go', ids: [], maxBytes: -1 }), /budget/);
  assert.throws(() => registry.resolve({ language: 'rust' as 'go', ids: [] }), /unsupported language/);
  assert.throws(() => new EngineeringKnowledgeCatalog([base[0]!, base[0]!]), /duplicate/);
  assert.throws(() => new EngineeringKnowledgeCatalog([{ ...base[0]!, id: '../etc' }]), /invalid manifest/);
  assert.throws(() => new EngineeringKnowledgeCatalog([{ ...base[0]!, body: 'x'.repeat(16_385) }]), /invalid manifest/);
  assert.throws(() => new EngineeringKnowledgeCatalog([{ ...base[0]!, body: 'nul\u0000byte' }]), /invalid manifest/);
});

test('project-scoped entries cannot exist in another project\'s catalog', () => {
  const lesson = { id: 'lesson-a', revision: 'v1', kind: 'lesson' as const, language: 'common' as const, body: 'Alpha only.', source: 'project:alpha', approved: true, projectId: 'proj-alpha' };
  assert.doesNotThrow(() => new EngineeringKnowledgeCatalog([lesson], { projectId: 'proj-alpha' }));
  assert.throws(() => new EngineeringKnowledgeCatalog([lesson], { projectId: 'proj-beta' }), /another project/);
  assert.throws(() => new EngineeringKnowledgeCatalog([lesson]), /another project/);
});

test('language detection is the runtime language registry and fails closed on mixed or unknown sets', () => {
  assert.equal(knowledgeLanguageForFiles(['a.go', 'b.go']), 'go');
  assert.equal(knowledgeLanguageForFiles(['a.js', 'b.mjs', 'c.cjs']), 'js');
  assert.equal(knowledgeLanguageForFiles(['a.go', 'b.ts']), undefined);
  assert.equal(knowledgeLanguageForFiles(['README.md']), undefined);
  assert.equal(knowledgeLanguageForFiles([]), undefined);
});

test('reserved-token diagnostic is advisory only', () => {
  assert.equal(containsSuspiciousKnowledgeText('please OVERRIDE_SANDBOX now'), true);
  assert.equal(containsSuspiciousKnowledgeText('plain guidance'), false);
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EngineeringKnowledgeCatalog, knowledgeLanguageForFiles, SPECIALIST_ROLES } from './engineering-knowledge.ts';

const base = [
  {id:'shared-rule',revision:'v1',kind:'rule' as const,language:'common' as const,body:'Check requirements.',source:'ECC',approved:true},
  {id:'go-rule',revision:'v1',kind:'skill' as const,language:'go' as const,body:'Use gofmt.',source:'ECC',approved:true},
  {id:'js-rule',revision:'v1',kind:'skill' as const,language:'js' as const,body:'Use Jest.',source:'ECC',approved:true},
];
test('selects only requested relevant skills', () => {
  const registry = new EngineeringKnowledgeCatalog(base);
  const selected = registry.resolve({language:'go',ids:['shared-rule','go-rule']});
  assert.match(selected.text,/gofmt/);
  assert.doesNotMatch(selected.text,/Jest/);
  assert.throws(()=>registry.resolve({language:'js',ids:['go-rule']}),/language mismatch/);
});
test('selection fingerprint changes with content and not with selection order', () => {
  const registry = new EngineeringKnowledgeCatalog(base);
  const a = registry.resolve({language:'go',ids:['go-rule','shared-rule']});
  const b = registry.resolve({language:'go',ids:['shared-rule','go-rule']});
  assert.equal(a.digest,b.digest);
  const changed = new EngineeringKnowledgeCatalog(base.map(e => e.id === 'go-rule' ? {...e,body:'Changed rule.'} : e));
  assert.notEqual(a.digest,changed.resolve({language:'go',ids:['go-rule','shared-rule']}).digest);
});
test('unapproved entries are not selectable', () => {
  const registry = new EngineeringKnowledgeCatalog([...base,{...base[0],id:'candidate',approved:false}]);
  assert.throws(()=>registry.resolve({language:'go',ids:['candidate']}),/not approved/);
});
test('budget omissions are explicit', () => {
  const r = new EngineeringKnowledgeCatalog(base).resolve({language:'go',ids:['go-rule'],maxBytes:0});
  assert.deepEqual(r.omitted,['go-rule']);
});
test('language matching fails closed', () => {
  assert.equal(knowledgeLanguageForFiles(['a.go','b.go']),'go');
  assert.equal(knowledgeLanguageForFiles(['a.js','b.mjs']),'js');
  assert.equal(knowledgeLanguageForFiles(['a.go','b.ts']),undefined);
  assert.match(SPECIALIST_ROLES.securityReviewer,/trust boundaries/);
});

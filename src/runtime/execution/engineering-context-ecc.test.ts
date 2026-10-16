import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EngineeringKnowledgeCatalog } from '../knowledge/engineering-knowledge.ts';
import { buildEngineeringContext, expectedEngineeringContext, verifyEngineeringContext } from './engineering-context.ts';

const catalog = new EngineeringKnowledgeCatalog([
  {id:'go-reviewed-pattern',revision:'v1',kind:'skill',language:'go',body:'Keep cancellation explicit.',source:'curated/ECC',approved:true},
]);

test('explicit guidance reaches exact worker context and changes fingerprint',()=>{
  const selected = catalog.resolve({language:'go',ids:['go-reviewed-pattern']});
  const initial = buildEngineeringContext(['src/service.go']);
  const injected = buildEngineeringContext(['src/service.go'],undefined,undefined,selected);
  assert.match(injected.text,/Keep cancellation explicit/);
  assert.notEqual(injected.fingerprint,initial.fingerprint);
  assert.equal(verifyEngineeringContext(injected).ok,true);
  assert.equal(expectedEngineeringContext({allowedFiles:['src/service.go']},undefined,selected)?.fingerprint,injected.fingerprint);
});

test('no guidance is injected for omitted opt-in content',()=>{
 const empty = catalog.resolve({language:'go',ids:[]});
 const original = buildEngineeringContext(['src/service.go']);
 const optional = buildEngineeringContext(['src/service.go'],undefined,undefined,empty);
 assert.equal(original.fingerprint,optional.fingerprint);
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EngineeringKnowledgeCatalog } from '../knowledge/engineering-knowledge.ts';
import { runCodingTask } from './coding-task-runner.ts';

const catalog = new EngineeringKnowledgeCatalog([
  {id:'rule-one',revision:'v1',kind:'rule',language:'go',body:'Verify package boundaries.',source:'curated',approved:true},
]);

const request = {
  taskId:'knowledge-test',objective:'Do a bounded task',allowedFiles:['service.go'],
  verificationCommands:[['go','test','./...']],
};

test('runner rejects unknown catalog before invoking worker',async()=>{
 let calls=0;
 const worker={async generate(){calls++;return {text:'PASS'};}};
 await assert.rejects(()=>runCodingTask({...request,knowledge:{ids:['rule-one'],catalogDigest:catalog.catalogDigest}},
  {repoRoot:'/nonexistent',worker}),/no trusted runtime catalog/);
 assert.equal(calls,0);
});

test('runner rejects wrong catalog revision before invoking worker',async()=>{
 let calls=0;
 const worker={async generate(){calls++;return {text:'PASS'};}};
 await assert.rejects(()=>runCodingTask({...request,knowledge:{ids:['rule-one'],catalogDigest:'0'.repeat(64)}},
  {repoRoot:'/nonexistent',worker,knowledgeCatalog:catalog}),/catalog revision mismatch/);
 assert.equal(calls,0);
});

test('runner rejects cross-language knowledge before invoking worker',async()=>{
 let calls=0;
 const worker={async generate(){calls++;return {text:'PASS'};}};
 const other = new EngineeringKnowledgeCatalog([{id:'js-rule',revision:'v1',kind:'skill',language:'js',body:'Scoped test.',source:'curated',approved:true}]);
 await assert.rejects(()=>runCodingTask({...request,knowledge:{ids:['js-rule'],catalogDigest:other.catalogDigest}},
  {repoRoot:'/nonexistent',worker,knowledgeCatalog:other}),/language mismatch/);
 assert.equal(calls,0);
});

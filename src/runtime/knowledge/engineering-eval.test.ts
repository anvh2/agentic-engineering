import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { summarizeTrials,chooseEvidenceBackedProvider,validateFixtures,type Trial } from './engineering-eval.ts';
const fixtureCommit='a'.repeat(40);
const t=(providerId:string,repetition:number,accepted:boolean,costUsd:number):Trial=>({
 fixtureId:'go-fix',fixtureCommit,providerId,repetition,accepted,independentReview:accepted,
 verifierPassed:accepted,securityViolation:false,elapsedMs:1000+repetition,attempts:1,inputTokens:200,outputTokens:50,costUsd,
});
test('evaluation accepts only independent runtime-verified outcomes',()=>{
 assert.throws(()=>summarizeTrials([{...t('qwen',0,true,0),verifierPassed:false}]),/independent evidence/);
 assert.throws(()=>summarizeTrials([t('qwen',0,true,0),t('qwen',0,true,0)]),/duplicate/);
});
test('provider ranking is gated by sample count and security, not claims',()=>{
 const results=summarizeTrials([t('qwen',0,true,0),t('qwen',1,false,0),t('codex',0,true,0.3),t('codex',1,true,0.3)]);
 assert.equal(chooseEvidenceBackedProvider(results,{minimumTrials:3,requireZeroSecurityViolations:true}),null);
 assert.equal(chooseEvidenceBackedProvider(results,{minimumTrials:2,requireZeroSecurityViolations:true}), 'codex');
 assert.equal(chooseEvidenceBackedProvider(results,{minimumTrials:2,requireZeroSecurityViolations:true,maxCostPerAcceptedUsd:0.1}),'qwen');
});
test('unknown costs remain unknown, not zero',()=>{
 const s=summarizeTrials([{...t('local',0,true,0),costUsd:null}])[0];
 assert.equal(s.costPerAcceptedUsd,null);
 assert.equal(s.totalCostUsd,null);
});
test('fixture definitions reject path traversal and duplicated IDs',()=>{
 const good={id:'go-case',commit:fixtureCommit,language:'go' as const,allowedFiles:['src/a.go'],expectedCriteria:['handles error']};
 validateFixtures([good]);
 assert.throws(()=>validateFixtures([good,good]),/invalid/);
 assert.throws(()=>validateFixtures([{...good,allowedFiles:['../etc/passwd']}]),/invalid/);
});

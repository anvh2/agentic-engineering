import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateEngineeringPlan,eligibleHarnesses } from './engineering-orchestration.ts';
const task=(id:string,deps:string[]=[])=>({id,objective:'Implement '+id,acceptanceCriteria:['test passes'],allowedFiles:['src/a.go'],risk:'low' as const,dependencies:deps});
test('planner sorts dependencies and rejects cycles',()=>{
 assert.deepEqual(validateEngineeringPlan([task('b',['a']),task('a')]).map(x=>x.id),['a','b']);
 assert.throws(()=>validateEngineeringPlan([task('a',['b']),task('b',['a'])]),/cycle/);
 assert.throws(()=>validateEngineeringPlan([task('a',['missing'])]),/unknown dependency/);
});
test('harness catalog cannot enable unsupported TypeScript worker delegation',()=>{
 const catalog=[{id:'qwen',supportedLanguages:['go','js','ts'] as ('go'|'js'|'ts')[],roles:['worker'] as const,available:true,isolatedExecution:true,supportsCancellation:true}];
 assert.deepEqual(eligibleHarnesses([task('a')],catalog,'go','worker'),['qwen']);
 assert.deepEqual(eligibleHarnesses([task('a')],catalog,'ts','worker'),[]);
});

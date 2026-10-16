import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { engineeringStatus } from './engineering-doctor.ts';
test('doctor does not claim evaluated capability without independent evidence',()=>{
 const r=engineeringStatus({entries:[],trials:[],configuredAdapters:['go','js'],hooksEnabled:false});
 assert.equal(r.providersWithEvidence,0);
 assert.ok(r.issues.some(x=>x.code==='no_eval_evidence'));
 assert.ok(r.issues.some(x=>x.code==='no_approved_knowledge'));
});
test('doctor flags unsupported adapter and unchecked active hooks',()=>{
 const r=engineeringStatus({entries:[],trials:[],configuredAdapters:['rust','ts'],hooksEnabled:true});
 assert.ok(r.issues.some(x=>x.code==='unknown_adapter'&&x.level==='error'));
 assert.ok(r.issues.some(x=>x.code==='hooks_unverified'));
});

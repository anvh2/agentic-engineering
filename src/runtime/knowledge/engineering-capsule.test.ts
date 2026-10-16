import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {newCapsule,appendCapsuleEvent,verifyCapsule,capsuleReceipt,verifyCapsuleReceipt} from './engineering-capsule.ts';
test('capsule has reproducible digest and offline receipt',()=>{
 const a=appendCapsuleEvent(appendCapsuleEvent(newCapsule('run-1'),'task',{id:'t'}),'verifier',{ok:true});
 const b=appendCapsuleEvent(appendCapsuleEvent(newCapsule('run-1'),'task',{id:'t'}),'verifier',{ok:true});
 assert.equal(a.rootHash,b.rootHash);
 assert.equal(verifyCapsule(a).ok,true);
 const receipt=capsuleReceipt(a);
 assert.equal(verifyCapsuleReceipt(a,receipt),true);
});
test('changed records, missing entries and root mismatch are rejected',()=>{
 const c=appendCapsuleEvent(newCapsule('run-2'),'tool',{command:'go test'});
 assert.equal(verifyCapsule({...c,entries:[{...c.entries[0]!,payload:{command:'sh'}}]}).ok,false);
 assert.equal(verifyCapsule({...c,entries:[]}).ok,false);
 assert.equal(verifyCapsuleReceipt(c,{...capsuleReceipt(c),entries:999}),false);
});

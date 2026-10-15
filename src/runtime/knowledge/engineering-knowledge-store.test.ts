import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { DurableEngineeringKnowledge } from './engineering-knowledge-store.ts';
import { normalizeSessionObservation, recordSessionObservation } from './engineering-continuity.ts';
import { proposeLesson } from './engineering-knowledge.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const authority = { async authorize(_digest:string){return {principalId:'lead',grantId:'grant-1'};} };
const deny = { async authorize(_digest:string){return undefined;} };
const candidate = () => proposeLesson({id:'lesson-1',projectId:'project-1',body:'Always verify runtime scope.',outcomes:[{
 taskId:'task-1',projectId:'project-1',status:'PASS',runtimeVerified:true,independentlyAccepted:true,evidenceHash:sha('accepted'),
}]});

test('knowledge promotion requires authenticated authority and is immutable',async()=>{
 const db = new DatabaseSync(':memory:');
 try {
  const store = new DurableEngineeringKnowledge(db);
  await assert.rejects(()=>store.promote(candidate(),deny),/not authorized/);
  assert.equal(store.activeCatalog().resolve({language:'go',ids:[]}).entries.length,0);
  await store.promote(candidate(),authority);
  const selection = store.activeCatalog().resolve({language:'go',ids:['lesson-1']});
  assert.match(selection.text,/runtime scope/);
  await assert.rejects(()=>store.promote(candidate(),authority),/already exists/);
  await store.revoke('lesson-1',authority);
  assert.throws(()=>store.activeCatalog().resolve({language:'go',ids:['lesson-1']}),/unknown entry/);
  await assert.rejects(()=>store.revoke('lesson-1',authority),/already revoked/);
 } finally {db.close();}
});

test('session observations are durable, repeatable and reject conflicting sequence',async()=>{
 const db = new DatabaseSync(':memory:');
 try {
  const store = new DurableEngineeringKnowledge(db);
  const obs = {sessionId:'session-1',taskId:'task-1',seq:1,event:'checkpoint' as const,stateRef:'task-state-1',stateDigest:sha('one')};
  assert.equal(await recordSessionObservation(store,obs),'written');
  assert.equal(await recordSessionObservation(store,obs),'exists');
  await assert.rejects(()=>recordSessionObservation(store,{...obs,stateDigest:sha('two')}),/conflict/);
  await assert.rejects(()=>store.recordOnce({...normalizeSessionObservation(obs),fingerprint:sha('fake')}),/mismatched/);
 } finally {db.close();}
});

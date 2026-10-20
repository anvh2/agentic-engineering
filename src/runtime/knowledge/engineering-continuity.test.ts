import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { acceptedAdrContext, normalizeSessionObservation, pinAdr, recordSessionObservation } from './engineering-continuity.ts';
import { createHash } from 'node:crypto';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const adr = {
 id:'ADR-0001',revision:'v1',status:'accepted' as const,context:'Choose isolation',decision:'Isolate worker execution',alternatives:['shared checkout'],consequences:'Requires workspace cleanup',sourceRef:'docs/adr/0001.md',
};
test('decision content and revision are pinned; proposed ADR is omitted',()=>{
 const one = pinAdr(adr);
 assert.notEqual(one.digest,pinAdr({...adr,revision:'v2'}).digest);
 const result = acceptedAdrContext([adr,{...adr,id:'ADR-0002',status:'proposed'}]);
 assert.match(result.text,/Isolate worker execution/);
 assert.doesNotMatch(result.text,/ADR-0002/);
 assert.throws(()=>acceptedAdrContext([adr,{...adr,revision:'v2'}]),/ambiguous/);
});
test('session observation fingerprint is deterministic',()=>{
 const input = {sessionId:'session-a',taskId:'task-a',seq:3,event:'before-compact' as const,stateRef:'checkpoint-3',stateDigest:sha('state')};
 assert.equal(normalizeSessionObservation(input).fingerprint,normalizeSessionObservation(input).fingerprint);
 assert.notEqual(normalizeSessionObservation(input).fingerprint,normalizeSessionObservation({...input,seq:4}).fingerprint);
 assert.throws(()=>normalizeSessionObservation({...input,stateDigest:'wrong'}));
});
test('session store adapter records immutable normalized events',async()=>{
 const written:string[]=[];
 const input = {sessionId:'session-a',taskId:'task-a',seq:0,event:'session-start' as const,stateRef:'checkpoint-0',stateDigest:sha('state')};
 const status=await recordSessionObservation({async recordOnce(e){written.push(e.fingerprint);return 'written';}},input);
 assert.equal(status,'written');
 assert.equal(written[0],normalizeSessionObservation(input).fingerprint);
});

test('re-normalizing an already normalized event preserves fingerprint',()=>{
 const event={sessionId:'s',taskId:'t',seq:3,event:'checkpoint' as const,stateRef:'state-3',stateDigest:sha('state')};
 const normalized=normalizeSessionObservation(event);
 assert.equal(normalizeSessionObservation(normalized).fingerprint,normalized.fingerprint);
});

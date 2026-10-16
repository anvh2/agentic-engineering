/** Offline-verifiable evidence capsule. Integrity is not authenticity. */
import { createHash } from 'node:crypto';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export interface CapsuleEvent { seq:number; kind:'task'|'tool'|'verifier'|'review'|'decision'; payload:unknown; previousHash:string|null; hash:string }
export interface Capsule { schema:'engineering-capsule/v1'; runId:string; entries:readonly CapsuleEvent[]; rootHash:string|null }
const canonical=(v:unknown):string=>JSON.stringify(v);
export function appendCapsuleEvent(c:Capsule,kind:CapsuleEvent['kind'],payload:unknown):Capsule{
 if(!c.runId.trim())throw new Error('capsule: missing run id');
 const seq=c.entries.length,previousHash=c.rootHash;
 const material={runId:c.runId,seq,kind,payload,previousHash};
 const event:CapsuleEvent={...material,hash:hash(canonical(material))};
 return Object.freeze({...c,entries:Object.freeze([...c.entries,Object.freeze(event)]),rootHash:event.hash});
}
export function newCapsule(runId:string):Capsule{
 if(!/^[a-zA-Z0-9_-]{1,120}$/.test(runId))throw new Error('capsule: invalid run id');
 return Object.freeze({schema:'engineering-capsule/v1',runId,entries:Object.freeze([]),rootHash:null});
}
export function verifyCapsule(c:Capsule):{ok:boolean;reason:string}{
 if(c.schema!=='engineering-capsule/v1'||!/^[a-zA-Z0-9_-]{1,120}$/.test(c.runId))return {ok:false,reason:'invalid metadata'};
 let prev:string|null=null;
 for(let i=0;i<c.entries.length;i++){
  const e=c.entries[i]!;
  if(e.seq!==i||e.previousHash!==prev||!['task','tool','verifier','review','decision'].includes(e.kind))return {ok:false,reason:'broken entry sequence'};
  const actual=hash(canonical({runId:c.runId,seq:e.seq,kind:e.kind,payload:e.payload,previousHash:e.previousHash}));
  if(actual!==e.hash)return {ok:false,reason:'entry digest mismatch'};
  prev=e.hash;
 }
 return prev===c.rootHash?{ok:true,reason:'verified'}:{ok:false,reason:'root mismatch'};
}
export interface EvidenceReceipt { schema:'engineering-receipt/v1'; runId:string; rootHash:string|null; entries:number; artifactDigest:string|null; receiptDigest:string }
export function capsuleReceipt(c:Capsule,artifactDigest:string|null=null):EvidenceReceipt{
 const verdict=verifyCapsule(c);if(!verdict.ok)throw new Error('capsule: cannot receipt invalid evidence');
 if(artifactDigest!==null&&!/^[a-f0-9]{64}$/.test(artifactDigest))throw new Error('capsule: invalid artifact digest');
 const body={schema:'engineering-receipt/v1' as const,runId:c.runId,rootHash:c.rootHash,entries:c.entries.length,artifactDigest};
 return {...body,receiptDigest:hash(canonical(body))};
}
export function verifyCapsuleReceipt(c:Capsule,r:EvidenceReceipt):boolean{
 try{const x=capsuleReceipt(c,r.artifactDigest);return JSON.stringify(x)===JSON.stringify(r);}catch{return false;}
}

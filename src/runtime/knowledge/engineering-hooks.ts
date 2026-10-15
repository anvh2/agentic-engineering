/**
 * Read-only lifecycle hook policy. It produces decisions; it never executes a shell,
 * starts a scheduler, grants permissions, or reads private transcripts.
 */
import { createHash } from 'node:crypto';
export type HookPhase='SessionStart'|'PreCompact'|'PreToolUse'|'PostToolUse'|'SessionEnd';
export type HookEvent=Readonly<{
  sessionId:string;seq:number;phase:HookPhase;taskId:string;
  tool?:string;relativePath?:string;outcome?:'ok'|'failed';
}>;
export type HookDecision=Readonly<{accepted:boolean;reason:string;eventFingerprint:string}>;
const phases=new Set<HookPhase>(['SessionStart','PreCompact','PreToolUse','PostToolUse','SessionEnd']);
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function safeRel(p:string):boolean {
 return !!p&&!p.startsWith('/')&&!p.includes('\\')&&!p.includes('\0')
  &&p.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
}
export function inspectHook(event:HookEvent, allow:{taskId:string;tools:readonly string[];paths:readonly string[]}):HookDecision {
 const fingerprint=sha(JSON.stringify(event));
 const fail=(reason:string):HookDecision=>Object.freeze({accepted:false,reason,eventFingerprint:fingerprint});
 if(!event.sessionId.trim()||!event.taskId.trim()||!Number.isSafeInteger(event.seq)||event.seq<0||!phases.has(event.phase))
  return fail('malformed hook');
 if(event.taskId!==allow.taskId)return fail('hook outside task scope');
 if(event.phase==='PreToolUse'||event.phase==='PostToolUse'){
   if(!event.tool||!allow.tools.includes(event.tool))return fail('tool outside allowlist');
   if(event.relativePath&&(!safeRel(event.relativePath)||!allow.paths.includes(event.relativePath)))
     return fail('path outside allowlist');
 }
 return Object.freeze({accepted:true,reason:'advisory lifecycle event accepted',eventFingerprint:fingerprint});
}
export type SessionSummary=Readonly<{
 taskId:string;checkpointDigest:string;completedSteps:readonly string[];
 pendingSteps:readonly string[];unverifiedClaims:readonly string[];
}>;
export function compactSession(summary:SessionSummary,maxBytes=4096):string {
 if(!/^[a-f0-9]{64}$/.test(summary.checkpointDigest)||!Number.isSafeInteger(maxBytes)||maxBytes<256||maxBytes>65536)
   throw new Error('hook: invalid checkpoint/budget');
 const output=JSON.stringify({
   taskId:summary.taskId,checkpointDigest:summary.checkpointDigest,
   completedSteps:summary.completedSteps,pendingSteps:summary.pendingSteps,
   unverifiedClaims:summary.unverifiedClaims,
 });
 if(Buffer.byteLength(output)>maxBytes)throw new Error('hook: context would truncate durable state');
 return output;
}

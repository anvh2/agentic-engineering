export interface KnowledgeTraceEvent {
  kind:string; runId?:string; agentId?:string; at?:string; documentId?:string;
  status?:string; reason?:string; sha256?:string; estimatedTokens?:number;
  inputTokens?:number; outputTokens?:number; cacheReadTokens?:number; cacheWriteTokens?:number;
}
export interface NativeTokenUsage {
  provider:string; scope?:string; inputTokens:number; outputTokens:number;
  cacheReadTokens?:number; cacheWriteTokens?:number;
}
export interface NativeKnowledgeResult {
  output:string; error:string; sessionId?:string; sessionReused?:boolean; commands?:{name:string;description:string}[]; acpUsage?:{inputTokens:number;outputTokens:number;cachedReadTokens?:number;cachedWriteTokens?:number;totalTokens:number}; acpContext?:{used:number;size:number;cost?:{amount:number;currency:string}}; runId?:string; estimatedContextTokens?:number;
  usage?:NativeTokenUsage; knowledgeEvents?:KnowledgeTraceEvent[];
}
export interface KnowledgeRun {
  runId:string; agentId:string; events:KnowledgeTraceEvent[];
  estimatedContextTokens?:number; usage?:NativeTokenUsage; error?:string;
}
export const knowledgeRuns:Record<string,KnowledgeRun>={};
export function subscribeKnowledgeEvents(update:(agentId:string)=>void){
 const rt=(window as unknown as {runtime?:{EventsOn:(name:string,cb:(event:KnowledgeTraceEvent)=>void)=>void}}).runtime;
 rt?.EventsOn("native-knowledge",event=>{
   if(!event.agentId||!event.runId)return;
   const id=event.agentId;
   let run=knowledgeRuns[id];
   if(!run||run.runId!==event.runId){run={runId:event.runId,agentId:id,events:[]};knowledgeRuns[id]=run}
   run.events.push(event);
   update(id);
 });
}
export function storeKnowledgeResult(agentId:string,result:NativeKnowledgeResult){
 const runId=result.runId;
 if(!runId)return;
 const previous=knowledgeRuns[agentId];
 knowledgeRuns[agentId]={
   runId,agentId,events:result.knowledgeEvents??(previous?.runId===runId?previous.events:[]),
   estimatedContextTokens:result.estimatedContextTokens,usage:result.usage,error:result.error
 };
}

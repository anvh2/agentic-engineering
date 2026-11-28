import type {ChatBlock} from "./chat-conversation";
import type {AppState,Agent} from "../types";
import {storeKnowledgeResult} from "./knowledge-trace";
import {runPrompt,consoles,stopPrompt} from "./harness-console";
export const profiles=(state:AppState)=>[...new Set(["alex","emma","noah",...Object.keys(state.agentProfiles??{})])].map(id=>({id,name:id[0].toUpperCase()+id.slice(1),handle:id,role:id==="alex"?"Architect":id==="emma"?"Developer":"Reviewer",harness:(id==="emma"?"Codex":"Claude") as Agent,model:"Default",...state.agentProfiles?.[id]}));
type Message={author:string;body:string;blocks?:ChatBlock[]};
export const conversations:Record<string,{repositoryDir?:string;messages:Message[];running:boolean;error:string;active?:{harness:Agent;name:string};cancelled?:boolean}>={};
export function conversation(id:string,projectId="all"){const key=JSON.stringify([projectId,id]);return conversations[key]??=( {messages:[],running:false,error:""});}
export async function sendAgentChat(state:AppState,id:string,prompt:string,update:()=>void,projectId="all"){
 const project=state.projects.find(p=>p.id===projectId);
 const linked=state.repos.filter(r=>project?.repos.includes(r.id));
 const projectRepositoryDir=(linked.find(r=>r.id===project?.defaultRepo)||linked[0])?.path??"";
 const c=conversation(id,projectId);if(c.running||!prompt.trim())return;
 const repositoryDir=c.repositoryDir??projectRepositoryDir;
 if(id==="group"){c.error="Group collaboration is temporarily disabled.";update();return;}
 const pack=state.knowledgePack;if(!pack){c.error="Connect knowledge first.";update();return;}
 const all=profiles(state);const mentions=[...prompt.matchAll(/@([\w-]+)/g)].map(m=>m[1].toLowerCase());
 const targets=id==="group"?all.filter(a=>!mentions.length||mentions.includes(a.handle)):all.filter(a=>a.id===id);
 if(!targets.length){c.error="No matching agent.";update();return;}
 c.running=true;c.cancelled=false;c.error="";c.messages.push({author:"You",body:prompt});update();
 try{for(const a of targets){
 if(c.cancelled)break;
 if(consoles[a.harness].running){c.error=a.name+": harness busy";continue;}
 c.active={harness:a.harness,name:a.name};
 const pending=runPrompt(a.harness,prompt,{request:{repositoryDir,agentId:a.id,root:pack.root,role:a.role,languages:state.agentLanguages?.[a.id]??[],assigned:state.agentKnowledge?.[a.id]??[],task:prompt},model:a.model,author:a.name,sessionKey:JSON.stringify([projectId,a.id])});
 update();const r=await pending;c.active=undefined;
 if(r)storeKnowledgeResult(a.id,r);
 if(r?.error)c.error=a.name+": "+r.error;
 if(r?.output||consoles[a.harness].blocks.length)c.messages.push({author:a.name,body:r?.output??"",blocks:structuredClone(consoles[a.harness].blocks)});
 update();
 }}finally{c.active=undefined;c.running=false;update();}
}

export async function stopAgentChat(id:string,projectId="all"){const c=conversation(id,projectId);c.cancelled=true;if(c.active)await stopPrompt(c.active.harness);}

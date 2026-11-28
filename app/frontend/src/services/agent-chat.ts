import type {AppState,Agent} from "../types";
import {knowledgeForAgent} from "./knowledge-source";
import {runPrompt,consoles,stopPrompt} from "./harness-console";
export const profiles=(state:AppState)=>["alex","emma","noah"].map(id=>({id,name:id[0].toUpperCase()+id.slice(1),handle:id,role:id==="alex"?"Architect":id==="emma"?"Developer":"Reviewer",harness:(id==="emma"?"Codex":"Claude") as Agent,model:"Default",...state.agentProfiles?.[id]}));
type Message={author:string;body:string};
export const conversations:Record<string,{messages:Message[];running:boolean;error:string;active?:{harness:Agent;name:string};cancelled?:boolean}>={};
export function conversation(id:string){return conversations[id]??=( {messages:[],running:false,error:""});}
export async function sendAgentChat(state:AppState,id:string,prompt:string,update:()=>void){
 const c=conversation(id);if(c.running||!prompt.trim())return;
 const pack=state.knowledgePack;if(!pack){c.error="Connect knowledge first.";update();return;}
 const all=profiles(state);const mentions=[...prompt.matchAll(/@([\w-]+)/g)].map(m=>m[1].toLowerCase());
 const targets=id==="group"?all.filter(a=>!mentions.length||mentions.includes(a.handle)):all.filter(a=>a.id===id);
 if(!targets.length){c.error="No matching agent.";update();return;}
 c.running=true;c.cancelled=false;c.error="";c.messages.push({author:"You",body:prompt});update();
 try{for(const a of targets){
 if(c.cancelled)break;
 if(consoles[a.harness].running){c.error=a.name+": harness busy";continue;}
 const entries=knowledgeForAgent(pack,a.role,state.agentKnowledge?.[a.id]??[]);
 c.active={harness:a.harness,name:a.name};
 const pending=runPrompt(a.harness,prompt,{root:pack.root,ids:entries.map(e=>e.id),model:a.model,author:a.name});
 update();const r=await pending;c.active=undefined;
 if(r?.error)c.error=a.name+": "+r.error;
 if(r?.output)c.messages.push({author:a.name,body:r.output});
 update();
 }}finally{c.active=undefined;c.running=false;update();}
}

export async function stopAgentChat(id:string){const c=conversation(id);c.cancelled=true;if(c.active)await stopPrompt(c.active.harness);}

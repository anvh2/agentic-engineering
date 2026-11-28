import type {AppState,Agent} from "../types";
import {knowledgeForAgent} from "./knowledge-source";
import {runPrompt,consoles} from "./harness-console";
export const profiles=(state:AppState)=>["alex","emma","noah"].map(id=>({id,name:id[0].toUpperCase()+id.slice(1),handle:id,role:id==="alex"?"Architect":id==="emma"?"Developer":"Reviewer",harness:(id==="emma"?"Codex":"Claude") as Agent,model:"Default",...state.agentProfiles?.[id]}));
type Message={author:string;body:string};
export const conversations:Record<string,{messages:Message[];running:boolean;error:string}>={};
export function conversation(id:string){return conversations[id]??=( {messages:[],running:false,error:""});}
export async function sendAgentChat(state:AppState,id:string,prompt:string,update:()=>void){
 const c=conversation(id);if(c.running||!prompt.trim())return;
 const pack=state.knowledgePack;if(!pack){c.error="Connect knowledge first.";update();return;}
 const all=profiles(state);const mentions=[...prompt.matchAll(/@([\w-]+)/g)].map(m=>m[1].toLowerCase());
 const targets=id==="group"?all.filter(a=>!mentions.length||mentions.includes(a.handle)):all.filter(a=>a.id===id);
 if(!targets.length){c.error="No matching agent.";update();return;}
 c.running=true;c.error="";c.messages.push({author:"You",body:prompt});update();
 try{for(const a of targets){
 if(consoles[a.harness].running){c.error=a.name+": harness busy";continue;}
 const entries=knowledgeForAgent(pack,a.role,state.agentKnowledge?.[a.id]??[]);
 const r=await runPrompt(a.harness,prompt,{root:pack.root,ids:entries.map(e=>e.id),model:a.model,author:a.name});
 if(r?.error)c.error=a.name+": "+r.error;
 if(r?.output)c.messages.push({author:a.name,body:r.output});
 update();
 }}finally{c.running=false;update();}
}

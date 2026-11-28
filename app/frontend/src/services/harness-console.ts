import {freshConversation,type ChatConversation} from "./chat-conversation";
import type { Agent } from "../types";
import { agentStatus } from "./agent-connection";
interface Result { output:string; error:string }
interface ConsoleBridge { RunAgentContextTest(name:string,path:string,model:string,root:string,ids:string[],prompt:string):Promise<Result>; BrowseRepository():Promise<string>; CurrentRepository():Promise<string>; RunPrompt(name:string,path:string,dir:string,prompt:string):Promise<Result>; RunIssuePrompt(name:string,path:string,dir:string,key:string,prompt:string):Promise<Result>; StopPrompt(name:string):Promise<void>; OpenTerminal(name:string,path:string,dir:string):Promise<void> }
const bridge=()=> (window as unknown as {go?:{main?:{HarnessConsole?:ConsoleBridge}}}).go?.main?.HarnessConsole;
interface ConsoleState extends ChatConversation {dir:string;prompt:string;output:string;running:boolean;error:string;activity:string}
const fresh=():ConsoleState=>({...freshConversation(),dir:"",prompt:"",output:"",running:false,error:"",activity:""});
export const consoles:Record<Agent,ConsoleState>={Claude:fresh(),Codex:fresh()};
export async function browseRepository(){return await bridge()?.BrowseRepository()||""}
export async function currentRepository(){return await bridge()?.CurrentRepository()||""}
export async function runPrompt(name:Agent,override?:string,context?:{root:string;ids:string[];model:string;author:string}){
 const c=consoles[name];if(c.running||!(override??c.prompt).trim())return;
 const prompt=override??c.prompt;if(override===undefined){c.prompt="";c.messages.push({author:"You",body:prompt});}c.running=true;c.error="";c.output="";c.activity="Starting native CLI…";
 try{const b=bridge();if(!b)throw Error("Native desktop required");const r=context?await b.RunAgentContextTest(name,agentStatus(name).path,context.model,context.root,context.ids,prompt):await b.RunPrompt(name,agentStatus(name).path,override===undefined?c.dir:"",prompt);c.output="";c.error=r.error;if(r.output&&override===undefined)c.messages.push({author:context?.author??name,body:r.output});return r}catch(e){c.error=String(e);return {output:"",error:c.error}}finally{c.running=false;c.activity=""}
}
export async function stopPrompt(name:Agent){await bridge()?.StopPrompt(name)}
export async function openTerminal(name:Agent){const b=bridge();if(!b)throw Error("Native desktop required");await b.OpenTerminal(name,agentStatus(name).path,consoles[name].dir)}

export function subscribeChat(update:(name:Agent)=>void){const rt=(window as unknown as {runtime?:{EventsOn:(event:string,cb:(e:{name:Agent;kind:string;body:string})=>void)=>void}}).runtime;rt?.EventsOn("native-chat",e=>{const c=consoles[e.name];if(!c?.running)return;if(e.kind==="text")c.output+=e.body;else c.activity=e.body;update(e.name)})}

export async function runIssuePrompt(name:Agent,dir:string,key:string,prompt:string){const c=consoles[name];if(c.running)return;c.running=true;c.output="";c.activity="Starting native issue execution…";try{const b=bridge();if(!b)throw Error("Native desktop required");return await b.RunIssuePrompt(name,agentStatus(name).path,dir,key,prompt)}finally{c.running=false;c.activity="";c.output=""}}

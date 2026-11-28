import type {NativeKnowledgeResult} from "./knowledge-trace";
import {freshConversation,type ChatConversation,type ChatBlock} from "./chat-conversation";
import type { Agent } from "../types";
import { agentStatus } from "./agent-connection";
interface Result extends NativeKnowledgeResult {}
interface ConsoleBridge { RunAgentContextChat(name:string,path:string,model:string,conversationKey:string,request:{repositoryDir?:string;agentId:string;root:string;role:string;languages:string[];assigned:string[];task:string},prompt:string):Promise<Result>; RunAgentContextTest(name:string,path:string,model:string,request:{repositoryDir?:string;agentId:string;root:string;role:string;languages:string[];assigned:string[];task:string},prompt:string):Promise<Result>; BrowseRepository():Promise<string>; CurrentRepository():Promise<string>; RunPrompt(name:string,path:string,dir:string,prompt:string):Promise<Result>; RunIssuePrompt(name:string,path:string,dir:string,key:string,prompt:string):Promise<Result>; StopPrompt(name:string):Promise<void>; OpenTerminal(name:string,path:string,dir:string):Promise<void> }
const bridge=()=> (window as unknown as {go?:{main?:{HarnessConsole?:ConsoleBridge}}}).go?.main?.HarnessConsole;
interface ConsoleState extends ChatConversation {dir:string;prompt:string;output:string;running:boolean;error:string;activity:string;blocks:ChatBlock[];acpContext?:NativeKnowledgeResult["acpContext"]}
const fresh=():ConsoleState=>({...freshConversation(),dir:"",prompt:"",output:"",running:false,error:"",activity:"",blocks:[]});
export const consoles:Record<Agent,ConsoleState>={Claude:fresh(),Codex:fresh()};
export async function browseRepository(){return await bridge()?.BrowseRepository()||""}
export async function currentRepository(){return await bridge()?.CurrentRepository()||""}
export async function runPrompt(name:Agent,override?:string,context?:{request:{repositoryDir?:string;agentId:string;root:string;role:string;languages:string[];assigned:string[];task:string};model:string;author:string;sessionKey?:string}){
 const c=consoles[name];if(c.running||!(override??c.prompt).trim())return;
 const prompt=override??c.prompt;if(override===undefined){c.prompt="";c.messages.push({author:"You",body:prompt});}c.running=true;c.error="";c.output="";c.blocks=[];c.activity="Connecting to agent…";c.acpContext=undefined;
 try{const b=bridge();if(!b)throw Error("Native desktop required");const r=context?(context.sessionKey?await b.RunAgentContextChat(name,agentStatus(name).path,context.model,context.sessionKey,context.request,prompt):await b.RunAgentContextTest(name,agentStatus(name).path,context.model,context.request,prompt)):await b.RunPrompt(name,agentStatus(name).path,override===undefined?c.dir:"",prompt);c.output="";c.error=r.error;if(r.output&&override===undefined)c.messages.push({author:context?.author??name,body:r.output,blocks:structuredClone(c.blocks)});return r}catch(e){c.error=String(e);return {output:"",error:c.error}}finally{c.running=false;c.activity=""}
}
export async function stopPrompt(name:Agent){await bridge()?.StopPrompt(name)}
export async function openTerminal(name:Agent){const b=bridge();if(!b)throw Error("Native desktop required");await b.OpenTerminal(name,agentStatus(name).path,consoles[name].dir)}

export function subscribeChat(update:(name:Agent)=>void){const rt=(window as unknown as {runtime?:{EventsOn:(event:string,cb:(e:{name:Agent;kind:string;body:string})=>void)=>void}}).runtime;rt?.EventsOn("native-chat",e=>{const c=consoles[e.name];if(!c?.running)return;if(e.kind==="acp-usage"){try{c.acpContext=JSON.parse(e.body)??undefined;}catch{return;}}else if(e.kind==="text"){c.output+=e.body;const last=c.blocks[c.blocks.length-1];if(last?.kind==="text")last.text+=e.body;else c.blocks.push({kind:"text",text:e.body});}else if(e.kind==="tool"){try{const tool=JSON.parse(e.body) as Extract<ChatBlock,{kind:"tool"}>;const old=c.blocks.find(b=>b.kind==="tool"&&b.id===tool.id);if(old?.kind==="tool"){Object.assign(old,{...tool,label:tool.label||old.label});}else c.blocks.push({...tool,kind:"tool"});}catch{return;}}else if(e.kind==="activity")c.activity=e.body;update(e.name)})}

export async function runIssuePrompt(name:Agent,dir:string,key:string,prompt:string){const c=consoles[name];if(c.running)return;c.running=true;c.output="";c.blocks=[];c.activity="Starting native issue execution…";try{const b=bridge();if(!b)throw Error("Native desktop required");return await b.RunIssuePrompt(name,agentStatus(name).path,dir,key,prompt)}finally{c.running=false;c.activity="";c.output=""}}

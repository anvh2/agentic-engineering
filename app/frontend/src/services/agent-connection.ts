import type { Agent } from "../types";
export interface AgentStatus { name: Agent; path:string; version:string; authentication:string; state:string; diagnostic:string }
type NativeBridge = { go?: { main?: { AgentConnection?: { ScanAgent(name:string,path:string):Promise<AgentStatus> } } } };
const bridge=()=> (window as unknown as NativeBridge).go?.main?.AgentConnection;
export const agentNames: Agent[]=["Claude","Codex"];
const statuses: Record<Agent,AgentStatus> = Object.fromEntries(agentNames.map(name=>[name,{name,path:"",version:"",authentication:"Unknown",state:"Not checked",diagnostic:""}])) as Record<Agent,AgentStatus>;
export const agentStatus=(name:Agent)=>statuses[name];
export function configuredPath(name:Agent):string { try{return localStorage.getItem("agent-path:"+name)||""}catch{return ""} }
export async function scanAgent(name:Agent,path=configuredPath(name)):Promise<void>{
 if(statuses[name].state==="Checking")return;
 statuses[name]={...statuses[name],state:"Checking"};
 try{
  const native=bridge();
  if(!native){statuses[name]={name,path:"",version:"",authentication:"Unknown",state:"Unavailable",diagnostic:"Open the native desktop app to discover CLIs."};return;}
  statuses[name]=await native.ScanAgent(name,path);
  try{localStorage.setItem("agent-path:"+name,path)}catch{/* optional preference */}
 }catch{statuses[name]={name,path:"",version:"",authentication:"Unknown",state:"Error",diagnostic:"Native diagnostic request failed."}}
}
export async function scanAgents(){await Promise.all(agentNames.map(name=>scanAgent(name)))}

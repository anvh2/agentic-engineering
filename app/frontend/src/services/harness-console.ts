import type { Agent } from "../types";
import { agentStatus } from "./agent-connection";
interface Result { output:string; error:string }
interface ConsoleBridge { RunPrompt(name:string,path:string,dir:string,prompt:string):Promise<Result>; StopPrompt(name:string):Promise<void>; OpenTerminal(name:string,path:string,dir:string):Promise<void> }
const bridge=()=> (window as unknown as {go?:{main?:{HarnessConsole?:ConsoleBridge}}}).go?.main?.HarnessConsole;
export const consoles:Record<Agent,{dir:string;prompt:string;output:string;running:boolean;error:string}>={Claude:{dir:"",prompt:"",output:"",running:false,error:""},Codex:{dir:"",prompt:"",output:"",running:false,error:""}};
export async function runPrompt(name:Agent){const c=consoles[name];if(c.running||!c.prompt.trim())return;c.running=true;c.error="";c.output="";try{const b=bridge();if(!b)throw Error("Native desktop required");const r=await b.RunPrompt(name,agentStatus(name).path,c.dir,c.prompt);c.output=r.output;c.error=r.error}catch(e){c.error=String(e)}finally{c.running=false}}
export async function stopPrompt(name:Agent){await bridge()?.StopPrompt(name)}
export async function openTerminal(name:Agent){const b=bridge();if(!b)throw Error("Native desktop required");await b.OpenTerminal(name,agentStatus(name).path,consoles[name].dir)}

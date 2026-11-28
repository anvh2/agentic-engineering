import {freshConversation} from "./chat-conversation";
import type { Agent } from "../types";
import { stopPrompt } from "./harness-console";
export const group={...freshConversation(),busy:false,active:[] as Agent[],error:"",draft:"",cancelled:false};
export async function groupSend(_message:string,update:()=>void,_workContext=""){group.error="Group collaboration is temporarily disabled.";update();}
export async function stopGroup(){group.cancelled=true;await Promise.allSettled(group.active.map(n=>stopPrompt(n)))}

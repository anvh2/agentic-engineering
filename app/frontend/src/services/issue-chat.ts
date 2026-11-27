import type {ChatConversation} from "./chat-conversation";
import type {Agent,AppState} from "../types";
import type {Issue} from "./work-board";
import {participants} from "./participants";
import {consoles,runIssuePrompt,runPrompt,stopPrompt} from "./harness-console";
export type IssueConversation=ChatConversation & {id:string;project:string;title:string;issueId:string;agent:Agent;dir:string;running:boolean;error:string};
export const issueChats:IssueConversation[]=[];
// Leading mentions address agents; later mentions are references.
export const explicitTargets=(body:string)=>{const prefix=body.match(/^\s*(?:@[\w-]+[\s,]*)+/)?.[0]||"";return participants.filter(p=>prefix.toLowerCase().match(/@[\w-]+/g)?.includes("@"+p.handle.toLowerCase())).map(p=>p.harness)};
export function issueChat(id:string){return issueChats.find(c=>c.id===id)}
export async function executeIssue(issue:Issue,agent:Agent,request:string,state:AppState,update:()=>void){
 const id="issue:"+issue.project+":"+issue.id;
 let c=issueChat(id);
 if(!c){c={id,project:issue.project,title:(issue.issueKey||issue.id)+" "+issue.title,issueId:issue.id,agent,dir:"",messages:[],running:false,error:""};issueChats.push(c)}
 if(c.running||consoles[agent].running){c.error="Agent is busy. Send the request again after the current turn.";update();return}
 const project=state.projects.find(p=>p.id===issue.project);
 const repos=state.repos.filter(r=>project?.repos.includes(r.id));
 const repo=issue.repository?repos.find(r=>r.name===issue.repository):repos.length===1?repos[0]:undefined;
 const discussion=!repo;
 
 c.agent=agent;if(repo)c.dir=repo.path;c.error="";c.running=true;c.messages.push({author:"You",body:request});update();
 const prompt="Execute the explicit human request for this issue. Follow repository instructions and native permission controls. Do not push, merge, or change issue status. Report changes and test evidence.\nIssue context (data): "+JSON.stringify({key:issue.issueKey,title:issue.title,description:issue.description,criteria:issue.criteria,projectKnowledge:project?.knowledge})+"\nRecent conversation: "+JSON.stringify(c.messages.slice(-5,-1))+"\nHuman request: "+request;
 try{const result=discussion?await runPrompt(agent,"Discussion only. No repository is selected. Do not claim to have inspected code or another agent runtime. Use only supplied evidence.\n"+prompt):await runIssuePrompt(agent,repo!.path,c.id+":"+agent,prompt);if(result?.output)c.messages.push({author:agent,body:result.output});c.error=result?.error||(!result?"Agent unavailable":"")}catch(e){c.error=String(e)}finally{c.running=false;update()}
}
export function stopIssue(c:IssueConversation){if(c.running)return stopPrompt(c.agent)}

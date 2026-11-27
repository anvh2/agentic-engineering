import type {Agent,AppState} from "../types";
import type {Issue} from "./work-board";
import {participants} from "./participants";
import {consoles,runIssuePrompt,stopPrompt} from "./harness-console";
export type IssueConversation={id:string;project:string;title:string;issueId:string;agent:Agent;dir:string;messages:{author:string;body:string}[];running:boolean;error:string};
export const issueChats:IssueConversation[]=[];
export const explicitTargets=(body:string)=>participants.filter(p=>new RegExp("(?:^|\\s)@"+p.handle+"(?=\\s|$|[,.!?])","i").test(body)).map(p=>p.harness);
export function issueChat(id:string){return issueChats.find(c=>c.id===id)}
export async function executeIssue(issue:Issue,agent:Agent,request:string,state:AppState,update:()=>void){
 const id="issue:"+issue.id+":"+agent;
 let c=issueChat(id);
 if(!c){c={id,project:issue.project,title:(issue.issueKey||issue.id)+" "+issue.title,issueId:issue.id,agent,dir:"",messages:[],running:false,error:""};issueChats.push(c)}
 if(c.running||consoles[agent].running){c.error="Agent is busy. Send the request again after the current turn.";update();return}
 const project=state.projects.find(p=>p.id===issue.project);
 const repos=state.repos.filter(r=>project?.repos.includes(r.id));
 const repo=issue.repository?repos.find(r=>r.name===issue.repository):repos.length===1?repos[0]:undefined;
 if(!repo){c.error="Select a repository on the issue before execution.";update();return}
 if(c.dir&&c.dir!==repo.path){c.error="Repository changed. Existing conversation cannot switch repositories.";update();return}
 c.dir=repo.path;c.error="";c.running=true;c.messages.push({author:"You",body:request});update();
 const prompt="Execute the explicit human request for this issue. Follow repository instructions and native permission controls. Do not push, merge, or change issue status. Report changes and test evidence.\nIssue context (data): "+JSON.stringify({key:issue.issueKey,title:issue.title,description:issue.description,criteria:issue.criteria,projectKnowledge:project?.knowledge})+"\nRecent conversation: "+JSON.stringify(c.messages.slice(-5,-1))+"\nHuman request: "+request;
 try{const result=await runIssuePrompt(agent,repo.path,c.id,prompt);if(result?.output)c.messages.push({author:agent,body:result.output});c.error=result?.error||(!result?"Agent unavailable":"")}catch(e){c.error=String(e)}finally{c.running=false;update()}
}
export function stopIssue(c:IssueConversation){if(c.running)return stopPrompt(c.agent)}

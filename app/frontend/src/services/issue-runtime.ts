// Native issue execution for the Working board. The Go runtime owns execution
// state; this module mirrors it, applies board status rules and sends the
// Director's actions.
import {AcceptIssue,CommentOnIssue,GetIssueExecution,ListIssueExecutions,StartIssue,StopIssue,SyncTeam} from "../wailsjs/go/main/IssueRuntime";
import {issues as model,main} from "../wailsjs/go/models";
import {EventsOn} from "../wailsjs/runtime/runtime";
import type {AppState} from "../types";
import {profiles} from "./agent-chat";
import {configuredPath} from "./agent-connection";
import {issues,saveIssue,type Issue} from "./work-board";

export type Execution=model.Execution;
export const nativeRuntime=()=>Boolean((window as unknown as {go?:{main?:{IssueRuntime?:unknown}}}).go?.main?.IssueRuntime);
const needsDesktop="Open the desktop app (wails dev) to execute issues.";

const executions=new Map<string,Execution>();
const notices=new Map<string,string>();
const listeners=new Set<()=>void>();
let version=0;
function publish(){version++;listeners.forEach(listener=>listener());}
export function subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)};}
export const revision=()=>version;
export const execution=(issueId:string)=>executions.get(issueId);
export const allExecutions=()=>[...executions.values()];
export const notice=(issueId:string)=>notices.get(issueId)??"";
function tell(issueId:string,text:string){notices.set(issueId,text);publish();}

const runningPhases=["preparing","implementing","reviewing","revising","responding","stopping","accepting"];
const assigned=(id?:string)=>Boolean(id)&&id!=="Unassigned";

/** Moves the board card only when the runtime phase actually changes. */
function applyPhase(next:Execution){
 const issue=issues().find(x=>x.id===next.issueId);
 if(!issue||issue.execPhase===next.phase)return;
 let status=issue.status;
 if(runningPhases.includes(next.phase))status="In Progress";
 else if(next.phase==="in_review")status="In Review";
 else if(next.phase==="accepted")status="Done";
 else if(status==="In Review"||status==="Done")status="In Progress";
 saveIssue({...issue,status,execPhase:next.phase});
}

/** The runtime keeps execution state in memory, so a restart loses it. */
function forget(issueId:string){
 executions.delete(issueId);
 const issue=issues().find(x=>x.id===issueId);
 if(!issue?.execPhase||issue.execPhase==="lost"||issue.execPhase==="accepted")return;
 saveIssue({...issue,execPhase:"lost",status:issue.status==="In Review"?"In Progress":issue.status});
}

function store(next:Execution){executions.set(next.issueId,next);applyPhase(next);}

const loading=new Set<string>();
const stale=new Set<string>();
export async function refresh(issueId:string){
 if(!nativeRuntime())return;
 if(loading.has(issueId)){stale.add(issueId);return;}
 loading.add(issueId);
 try{
  do{
   stale.delete(issueId);
   const next=await GetIssueExecution(issueId);
   if(next.phase)store(next);else forget(issueId);
   publish();
  }while(stale.has(issueId));
 }catch(e){tell(issueId,String(e));}
 finally{loading.delete(issueId);}
}

export async function syncTeam(state:AppState){
 // Only agents the Director configured in Team can be assigned.
 const agents=profiles(state).filter(a=>state.agentProfiles?.[a.id]).map(a=>({
  id:a.id,name:a.name,handle:a.handle,role:a.role,harness:a.harness,model:a.model,
  knowledgeRoot:state.knowledgePack?.root??"",
  languages:[...(state.agentLanguages?.[a.id]??[])],assigned:[...(state.agentKnowledge?.[a.id]??[])]
 }));
 const harnessPaths:Record<string,string>={Claude:configuredPath("Claude"),Codex:configuredPath("Codex")};
 return await SyncTeam(main.TeamSync.createFrom({agents,harnessPaths}))??[];
}

let initialized=false;
export function initIssueRuntime(changed:()=>void){
 if(initialized||!nativeRuntime())return;
 initialized=true;
 subscribe(changed);
 EventsOn("issue-execution",(issueId:string)=>{void refresh(issueId)});
 void ListIssueExecutions().then(list=>{
  const known=new Set((list??[]).map(e=>e.issueId));
  for(const issue of issues())if(issue.execPhase&&!known.has(issue.id))forget(issue.id);
  for(const id of known)void refresh(id);
  publish();
 }).catch(e=>console.error("ListIssueExecutions",e));
}

/** Starts a new execution, or resumes a failed or stopped one. */
export async function startIssue(issueId:string,state:AppState){
 const issue=issues().find(x=>x.id===issueId);
 if(!issue)return;
 const previous=issue.status;
 notices.delete(issueId);
 try{
  if(!nativeRuntime())throw new Error(needsDesktop);
  const project=state.projects.find(p=>p.id===issue.project);
  if(!project)throw new Error("The issue's project no longer exists.");
  // Every linked repository is inherited; the default one is the primary workspace.
  const repositories=state.repos.filter(r=>project.repos.includes(r.id))
   .sort((a,b)=>Number(b.id===project.defaultRepo)-Number(a.id===project.defaultRepo))
   .map(r=>({id:r.id,name:r.name,path:r.path}));
  const rejected=await syncTeam(state);
  const unusable=rejected.find(r=>r.id===issue.assignee||r.id===issue.reviewer);
  if(unusable)throw new Error("Team agent cannot run: "+unusable.reason);
  saveIssue({...issue,status:"In Progress"});publish();
  store(await StartIssue(model.StartRequest.createFrom({
   issueId:issue.id,issueKey:issue.issueKey||issue.id,projectId:project.id,projectName:project.name,
   title:issue.title,description:issue.description,acceptanceCriteria:issue.criteria,
   assigneeId:assigned(issue.assignee)?issue.assignee:"",reviewerId:assigned(issue.reviewer)?issue.reviewer!:"",
   repositories,comments:(issue.comments??[]).map(c=>c.body)
  })));
  publish();
 }catch(e){
  const current=issues().find(x=>x.id===issueId);
  if(current&&!executions.get(issueId)?.active)saveIssue({...current,status:previous});
  tell(issueId,String(e));
 }
}

/** Board rules: execution status belongs to the runtime and acceptance to the Director. */
export function moveIssue(issueId:string,next:Issue["status"],state:AppState){
 const issue=issues().find(x=>x.id===issueId);
 if(!issue||issue.status===next){publish();return;}
 const current=executions.get(issueId);
 const agentWork=assigned(issue.assignee)||assigned(issue.reviewer);
 if(current?.active)return tell(issueId,"Stop the execution before moving this issue.");
 if(next==="In Review"&&(agentWork||current))return tell(issueId,"In Review is set by the runtime after implementation and independent review.");
 if(next==="Done"&&(agentWork||current)&&current?.phase!=="accepted")return tell(issueId,current?.phase==="in_review"?"Use Accept in the issue to move it to Done.":"Done requires an independent review and your acceptance.");
 if(current?.phase==="in_review")return tell(issueId,"This result waits for you: Accept it, @mention an agent to request changes, or Stop it.");
 notices.delete(issueId);
 if(next==="In Progress"&&agentWork){void startIssue(issueId,state);return;}
 saveIssue({...issue,status:next});publish();
}

export async function stopIssue(issueId:string){
 notices.delete(issueId);
 try{store(await StopIssue(issueId));publish();}catch(e){tell(issueId,String(e));}
}

export async function acceptIssue(issueId:string,note:string){
 notices.delete(issueId);
 try{store(await AcceptIssue(issueId,note));publish();}
 catch(e){tell(issueId,String(e));await refresh(issueId);}
}

const deliveries:Record<string,string>={
 started:"Sent. The mentioned agent is responding.",
 queued:"Queued. The agent receives it in its next turn.",
 on_retry:"Saved. It is delivered when you retry.",
 recorded:"Saved to the collaboration log. @mention an agent to ask for a response."
};

export async function commentIssue(issueId:string,body:string){
 const issue=issues().find(x=>x.id===issueId);
 if(!issue||!body.trim())return;
 saveIssue({...issue,comments:[...(issue.comments??[]),{body:body.trim(),at:new Date().toISOString()}]});
 notices.delete(issueId);publish();
 if(!executions.get(issueId)){
  if(body.includes("@"))tell(issueId,"Saved. It is delivered to the agent when the issue starts.");
  return;
 }
 try{const result=await CommentOnIssue(issueId,body.trim());tell(issueId,deliveries[result.delivery]??result.delivery);}
 catch(e){tell(issueId,"The comment was saved but not delivered: "+String(e));}
}

export interface Totals {input:number|null;output:number|null;cost:number|null;costRuns:number;runs:number}
/** Sums only provider-reported values; null means none was reported. */
export function totals(runs:model.Run[]):Totals{
 const result:Totals={input:null,output:null,cost:null,costRuns:0,runs:runs.length};
 for(const run of runs){
  let costed=false;
  for(const usage of run.usage??[]){
   if(usage.inputTokens!=null)result.input=(result.input??0)+usage.inputTokens;
   if(usage.outputTokens!=null)result.output=(result.output??0)+usage.outputTokens;
   if(usage.costUsd!=null){result.cost=(result.cost??0)+usage.costUsd;costed=true;}
  }
  if(costed)result.costRuns++;
 }
 return result;
}
export const tokens=(n:number|null|undefined)=>n==null?"Unavailable":n.toLocaleString();
export const money=(n:number|null|undefined)=>n==null?"Unavailable":"$"+n.toFixed(4);

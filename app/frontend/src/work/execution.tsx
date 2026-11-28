// Live execution sections of the issue detail. Everything shown comes from the
// native runtime; values a harness did not report are shown as unavailable.
import React,{useState} from "react";
import {ChevronRight} from "lucide-react";
import {acceptIssue,money,startIssue,stopIssue,tokens,totals,type Execution} from "../services/issue-runtime";
import type {Issue} from "../services/work-board";
import type {AppState} from "../types";

const phaseLabels:Record<string,string>={preparing:"Preparing",implementing:"Implementing",reviewing:"Reviewing",revising:"Revising",responding:"Responding",stopping:"Stopping",accepting:"Accepting",in_review:"Ready for your review",accepted:"Accepted",stopped:"Stopped",failed:"Failed",lost:"Interrupted by restart"};
export const phaseLabel=(phase?:string)=>phase?phaseLabels[phase]??phase:"";
const time=(at?:string)=>at?new Date(at).toLocaleString():"";
const short=(commit?:string)=>commit?commit.slice(0,10):"";

export function ExecutionStatus({issue,run,state,notice}:{issue:Issue;run?:Execution;state:AppState;notice:string}){
 const [note,setNote]=useState("");
 const phase=run?.phase??(issue.execPhase==="lost"?"lost":"");
 const retry=phase==="failed"||phase==="stopped"||phase==="lost";
 const idle=!run&&!retry&&issue.status==="In Progress";
 return <div className="wk-run-status" data-phase={phase||"none"}>
  {phase?<div className="wk-status-line"><strong>{phaseLabel(phase)}</strong>{run&&<small>Attempt {run.attempt}</small>}</div>:<p className="wk-unavailable">Move the issue to In Progress to run the assignee and reviewer.</p>}
  {run?.active&&<small>{run.detail}</small>}
  {run?.error&&<p className="wk-error">{run.error}</p>}
  {phase==="lost"&&<p className="wk-unavailable">Execution state is held in memory and did not survive the restart. Retry starts a new run.</p>}
  {Boolean(run?.pendingComments)&&<small>{run!.pendingComments} comment(s) waiting for delivery</small>}
  {phase==="in_review"&&<input aria-label="Acceptance note" placeholder="Acceptance note (optional)" value={note} onChange={e=>setNote(e.target.value)}/>}
  <div className="wk-run-actions">
   {phase==="in_review"&&<button type="button" className="wk-primary" onClick={()=>void acceptIssue(issue.id,note)}>Accept</button>}
   {(run?.active||phase==="in_review")&&<button type="button" disabled={phase==="stopping"||phase==="accepting"} onClick={()=>void stopIssue(issue.id)}>Stop</button>}
   {(retry||idle)&&<button type="button" className="wk-primary" onClick={()=>void startIssue(issue.id,state)}>{retry?"Retry":"Run"}</button>}
  </div>
  {notice&&<p className="wk-notice" role="status">{notice}</p>}
 </div>;
}

export function AgentLog({run,duty,children}:{run?:Execution;duty:"assignee"|"reviewer";children:React.ReactNode}){
 const runs=(run?.runs??[]).filter(r=>r.duty===duty);
 const sum=totals(runs);
 const cost=sum.cost==null?"Unavailable":money(sum.cost)+(sum.costRuns<sum.runs?` (${sum.costRuns}/${sum.runs} runs)`:"");
 const latest=runs[runs.length-1];
 return <details className="wk-execution">
  <summary className="wk-execution-head">{children}{latest&&<small className="wk-run-state" data-state={latest.state}>{latest.state}</small>}<ChevronRight className="wk-disclosure" size={14}/></summary>
  <div className="wk-execution-body">
   <div className="wk-execution-metrics">{([["Input tokens",tokens(sum.input)],["Output tokens",tokens(sum.output)],["Est. cost",cost],["Runs",String(runs.length)]] as const).map(([label,value])=><div key={label}><small>{label}</small><div>{runs.length?value:"—"}</div></div>)}</div>
   {!runs.length&&<p className="wk-unavailable">No native run yet.</p>}
   {runs.map((r,i)=><details className="wk-run" key={r.turnId}>
    <summary><span>#{i+1} {r.purpose}</span><small className="wk-run-state" data-state={r.state}>{r.state}</small></summary>
    <small>{r.harness} · started {time(r.startedAt)}{r.endedAt?` · ${Math.max(0,Math.round((+new Date(r.endedAt)-+new Date(r.startedAt))/1000))}s`:""} · {r.events} events</small>
    {(r.usage??[]).length?r.usage.map((u,k)=><small key={k}>{u.model||"Model unavailable"}: {tokens(u.inputTokens)} in ({tokens(u.cacheRead)} cached) · {tokens(u.outputTokens)} out · {money(u.costUsd)}</small>):<small>Token usage and cost: Unavailable</small>}
    <small>Knowledge {r.knowledgeVersion||"Unavailable"} · Turn {r.turnId}</small>
    {r.nativeSessionId&&<small>Native session {r.nativeSessionId}</small>}
    {r.evidencePath&&<small>Events: {r.evidencePath} · SHA-256 {short(r.evidenceSha256)}</small>}
    {r.error&&<p className="wk-error">{r.error}</p>}
    {r.finalText&&<pre>{r.finalText}</pre>}
   </details>)}
  </div>
 </details>;
}

export function Evidence({run}:{run?:Execution}){
 const repositories=run?.repositories??[],commands=run?.commands??[],reviews=run?.reviews??[];
 const summary=run?.tasks?.[0]?.summary;
 return <details className="wk-evidence"><summary>Changes &amp; evidence<ChevronRight className="wk-disclosure" size={14}/></summary>
  {!run?<p className="wk-unavailable">Git diff and test evidence appear after the first run.</p>:<div className="wk-evidence-body">
   <h4>Git changes</h4>
   {repositories.map(r=><section key={r.path}>
    <strong>{r.name}</strong>
    {(r.files??[]).length?<>
     <small>Snapshot {short(r.snapshotCommit)} on base {short(r.baseCommit)}</small>
     <ul className="wk-files">{r.files.map(f=><li key={f.path}><span>{f.status} {f.path}</span><small>{f.added<0?"binary":`+${f.added} −${f.deleted}`}</small></li>)}</ul>
     <details><summary>Diff</summary><pre>{r.patch}</pre>{r.patchTruncated&&<small>Preview truncated. Full patch: {r.patchPath}</small>}</details>
     {run.phase==="accepted"&&<small>Apply: <code>git -C {r.path} cherry-pick {r.snapshotCommit}</code></small>}
    </>:<small>No change captured.</small>}
    <small>Assignee worktree: {r.assigneeDir||"not created"}</small>
   </section>)}
   <h4>Observed commands</h4>
   <small>From native harness events. Exit status is that of the whole shell command.</small>
   {!commands.some(c=>c.test)&&<p className="wk-unavailable">No test command observed.</p>}
   {commands.map((c,i)=><details className="wk-command" key={i}>
    <summary><span>{c.test&&<b>Test </b>}{c.agentName}: <code>{c.command}</code></span><small className="wk-run-state" data-state={c.failed?"failed":"succeeded"}>{c.background?"background":c.exitCode!=null?"exit "+c.exitCode:c.failed?"failed":"succeeded"}</small></summary>
    <pre>{c.output||"No output reported."}</pre>
   </details>)}
   <h4>Reported by assignee</h4>
   {summary?<pre>{summary}</pre>:<small>No submission yet.</small>}
   <h4>Independent review</h4>
   {reviews.length?reviews.map(r=><section key={r.id}><strong>{r.verdict==="approved"?"Approved":"Changes requested"} · @{r.reviewer}</strong><small>{time(r.created_at)}</small><pre>{r.summary}</pre><small>Reviewer verification</small><pre>{r.verification}</pre></section>):<small>No verdict yet.</small>}
  </div>}
 </details>;
}

type Item={at:string;key:string;actor:string;text:string;block:boolean};

export function Timeline({issue,run,tab}:{issue:Issue;run?:Execution;tab:string}){
 const names:Record<string,string>={human:"You",system:"System"};
 for(const a of run?[run.assignee,run.reviewer]:[])names[a.handle]=a.name;
 const name=(handle:string)=>names[handle]??handle;
 const created:Item={at:issue.createdAt??"",key:"created",actor:"You",text:"created this issue",block:false};
 const comments:Item[]=(issue.comments??[]).map((c,i)=>({at:c.at,key:"c"+i,actor:"You",text:c.body,block:true}));
 const activity:Item[]=(run?.activity??[]).filter(a=>a.kind!=="comment").map(a=>({at:a.at,key:"a"+a.seq,actor:a.actor,text:a.text,block:false}));
 const message=(m:Execution["messages"][number]):Item=>({at:m.at,key:"m"+m.seq,actor:`${name(m.from)} → ${m.to?name(m.to):"everyone"}`,text:m.body,block:true});
 const messages=run?.messages??[];
 let items:Item[];
 if(tab==="Activity")items=[created,...activity];
 else if(tab==="Comments")items=[...comments,...messages.filter(m=>m.to==="human").map(message)];
 else if(tab==="Collaboration")items=messages.map(message);
 else items=[created,...comments,...activity,...messages.filter(m=>m.from!=="human").map(message)];
 items.sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0));
 if(!items.length)return <p className="wk-unavailable">{tab==="Collaboration"?"No agent messages yet.":"No comments yet."}</p>;
 return <div className="wk-timeline">{items.map(item=>item.block?
  <div className="wk-message" key={item.key}><span className="wk-avatar">{item.actor[0]}</span><div><small>{item.actor} · {time(item.at)}</small><p>{item.text}</p></div></div>:
  <div className="wk-activity" key={item.key}><span className="wk-avatar">{item.actor[0]}</span><span><b>{item.actor}</b> {item.text}</span><time>{time(item.at)}</time></div>)}</div>;
}

import React, {useRef,useState} from "react";
import * as Select from "@radix-ui/react-select";
import {ArrowLeft,ArrowUp,Check,ChevronDown,Circle,Plus,X} from "lucide-react";
import type {ViewContext} from "../view-context";
import {issues,statuses,projectPrefix,migrateIssueKeys,type Issue} from "../services/work-board";
import "./work.css";

type Option={value:string;label:string};
function Property({id,label,initial,options}:{id:string;label:string;initial:string;options:Option[]}){
 const [value,setValue]=useState(initial||"__none");
 const field=useRef<HTMLInputElement>(null);
 return <div className="wk-property"><span>{label}</span><input ref={field} type="hidden" id={id} defaultValue={initial}/>
 <Select.Root value={value} onValueChange={v=>{setValue(v);if(field.current){field.current.value=v==="__none"?"":v;field.current.dispatchEvent(new Event("change",{bubbles:true}));}}}>
 <Select.Trigger className="wk-select" aria-label={label}><Select.Value/><Select.Icon><ChevronDown size={13}/></Select.Icon></Select.Trigger>
 <Select.Portal><Select.Content className="wk-menu" position="popper" sideOffset={5}><Select.Viewport>{options.map(o=><Select.Item key={o.value||"__none"} value={o.value||"__none"} className="wk-option"><Select.ItemText>{o.label}</Select.ItemText><Select.ItemIndicator><Check size={14}/></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal>
 </Select.Root></div>
}
const options=(xs:readonly string[])=>xs.map(x=>({value:x,label:x}));
function TextArea({id,value,placeholder,rows=1}:{id:string;value:string;placeholder:string;rows?:number}){
 const resize=(el:HTMLTextAreaElement|null)=>{if(el){el.style.height="auto";el.style.height=el.scrollHeight+"px"}};
 return <textarea id={id} aria-label={placeholder} placeholder={placeholder} defaultValue={value} rows={rows} ref={resize} onInput={e=>resize(e.currentTarget)}/>;
}
export function Work({ctx}:{ctx:ViewContext}){
 const project=ctx.state.projects.find(p=>p.id===ctx.nav.projectFilter);
 if(!project)return <div className="wk-empty">Select a project to view its issues.</div>;
 migrateIssueKeys(project.id,project.name);
 const all=issues().filter(x=>x.project===project.id),issue=all.find(x=>x.id===ctx.nav.detail),creating=ctx.nav.detail.startsWith("new-issue:");
 const properties=(i?:Issue)=><><Property id="issue-status" label="Status" initial={i?.status||ctx.nav.detail.split(":")[1]||"Todo"} options={options(statuses)}/><Property id="issue-assignee" label="Assignee" initial={i?.assignee||"Unassigned"} options={options(["Unassigned","Claude","Codex"])}/><Property id="issue-repo" label="Repository" initial={i?.repository||""} options={[{value:"",label:"No repository"},...options(ctx.state.repos.filter(r=>project.repos.includes(r.id)).map(r=>r.name))]}/></>;
 const fields=(i?:Issue)=><><input className="wk-title" id="issue-title" aria-label="Issue title" placeholder="Issue title" defaultValue={i?.title||""}/><TextArea id="issue-description" value={i?.description||""} placeholder="Add description..." rows={i?1:4}/><details className="wk-criteria" open={!!i?.criteria}><summary>{i?.criteria?"Acceptance criteria":"+ Add acceptance criteria"}</summary><TextArea id="issue-criteria" value={i?.criteria||""} placeholder="Acceptance criteria"/></details></>;
 return <section className="wk-shell">{issue?<><header className="wk-toolbar mc-detail-toolbar"><button data-board-close aria-label="Back to issues"><ArrowLeft size={16}/></button><span>{issue.issueKey||issue.id}</span><strong>{issue.title}</strong></header><div className="wk-detail"><article className="wk-document">{fields(issue)}<hr/><h3>Activity</h3><div className="wk-activity"><span className="wk-avatar">Y</span><span>You created this issue</span><time>{issue.createdAt?new Date(issue.createdAt).toLocaleString():"Date unavailable"}</time></div>{(issue.comments||[]).map((m,i)=><div className="wk-message" key={i}><span className="wk-avatar">Y</span><div><small>You · {new Date(m.at).toLocaleString()}</small><p>{m.body}</p></div></div>)}<div className="wk-composer"><textarea id="issue-comment" rows={2} placeholder="Leave a comment..."/><button data-board-comment aria-label="Send comment"><ArrowUp size={16}/></button></div></article><aside className="wk-properties"><h3>Properties</h3>{properties(issue)}<small className="mc-save-status" role="status"/></aside></div></>:<><header className="wk-toolbar"><strong>All issues</strong><span>{all.length}</span><div className="wk-spacer"/><button data-board-prefix>{projectPrefix(project.id,project.name)}</button><button data-board-new="Todo"><Plus size={15}/> New issue</button></header><div className="wk-board">{statuses.map(status=>{const rows=all.filter(x=>x.status===status);return <section className="wk-column" key={status}><header><Circle size={13}/><strong>{status}</strong><span>{rows.length}</span><div className="wk-spacer"/><button data-board-new={status} aria-label={"Create issue in "+status}><Plus size={15}/></button></header>{rows.length?rows.map(x=><button className="wk-card" data-board-id={x.id} key={x.id}><small>{x.issueKey||x.id}</small><strong>{x.title}</strong><span>{x.assignee}</span></button>):<p>No issues</p>}</section>})}</div></>}{creating&&<div className="wk-overlay"><section className="wk-modal" role="dialog" aria-modal="true" aria-label="Create issue"><header><span>{project.name} › Create manually</span><button data-board-close aria-label="Close"><X size={17}/></button></header><div className="wk-modal-body">{fields()}{properties()}</div><footer><button data-board-close>Cancel</button><button className="wk-primary" data-board-save>Create issue</button></footer></section></div>}</section>;
}

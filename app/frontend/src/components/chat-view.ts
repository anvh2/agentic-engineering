import {escapeHTML} from "./primitives";
import type {ChatMessage,ChatBlock} from "../services/chat-conversation";
import type {Agent} from "../types";
function renderBlocks(body:string,blocks:ChatBlock[]=[]){
 return blocks.length?blocks.map(b=>b.kind==="text"?'<div class="group-body">'+escapeHTML(b.text)+'</div>':'<details data-tool-id="'+escapeHTML(b.id)+'" style="margin:6px 0;color:var(--subtle)"><summary style="cursor:pointer;font-size:12px;overflow-wrap:anywhere">'+(b.status==="completed"?"✓":b.status==="failed"?"×":"◌")+' '+escapeHTML(b.label||"Tool call")+' · '+escapeHTML(b.status)+'</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto;font-size:11px">'+escapeHTML(b.output||"No output reported")+'</pre></details>').join(""):'<div class="group-body">'+escapeHTML(body)+'</div>';
}
export function renderMessage(m:ChatMessage,live?:{agent:Agent;activity:string;blocks?:ChatBlock[]}){
 const cls=m.author==="You"?"human":m.author==="Claude"?"claude":"codex";
 return '<article class="group-message '+cls+'"><span class="group-avatar">'+escapeHTML(m.author[0]||"?")+'</span><div class="group-message-content"><header>'+escapeHTML(m.author)+'</header><div '+(live?'data-chat-live="'+live.agent+'"':'')+'>'+renderBlocks(m.body,live?.blocks??m.blocks)+'</div>'+(live?'<small data-chat-activity="'+live.agent+'" role="status">◌ '+escapeHTML(live.activity||"Working…")+'</small>':'')+'</div></article>';
}
export function renderChatView(o:{title?:string;subtitle?:string;messages:ChatMessage[];live?:{agent:Agent;author?:string;body:string;activity:string;blocks?:ChatBlock[]}[];error?:string;errorActions?:string;welcome?:string;composer:string}){
 return `<section class="direct-chat group-chat">${o.title?`<div class="group-header" style="display:flex;align-items:center;gap:12px;padding:12px 20px"><span class="group-avatar" style="background:#31594e;width:36px;height:36px;display:grid;place-items:center;border-radius:9px">${escapeHTML(o.title[0]||"?")}</span><div style="display:flex;flex-direction:column;gap:3px"><strong>${escapeHTML(o.title)}</strong><small>${escapeHTML(o.subtitle||"")}</small></div></div>`:""}<div class="chat-transcript" aria-live="polite">${o.messages.length?o.messages.map(m=>renderMessage(m)).join(""):o.welcome||""}${(o.live||[]).map(l=>renderMessage({author:l.author??l.agent,body:l.body},l)).join("")}${o.error?`<div class="chat-error" role="alert">${escapeHTML(o.error)}${o.errorActions||""}</div>`:""}</div>${o.composer}</section>`;
}
export function updateChatStream(root:HTMLElement,agent:Agent,body:string,activity:string,blocks:ChatBlock[]=[]){
 const t=root.querySelector<HTMLElement>('[data-chat-live="'+agent+'"]'),a=root.querySelector('[data-chat-activity="'+agent+'"]');
 const transcript=t?.closest(".chat-transcript");
 const follow=transcript?transcript.scrollHeight-transcript.scrollTop-transcript.clientHeight<80:false;
 if(t){const open=new Set(Array.from(t.querySelectorAll<HTMLDetailsElement>("details[open]")).map(d=>d.dataset.toolId));t.innerHTML=renderBlocks(body,blocks);t.querySelectorAll<HTMLDetailsElement>("details").forEach(d=>{d.open=open.has(d.dataset.toolId);});}
 if(a)a.textContent="◌ "+(activity||"Working…");
 if(transcript&&follow)transcript.scrollTop=transcript.scrollHeight;
}

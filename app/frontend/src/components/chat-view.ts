import {escapeHTML} from "./primitives";
import type {ChatMessage} from "../services/chat-conversation";
import type {Agent} from "../types";
export function renderMessage(m:ChatMessage,live?:{agent:Agent;activity:string}){
 const cls=m.author==="You"?"human":m.author==="Claude"?"claude":"codex";
 return `<article class="group-message ${cls}"><span class="group-avatar">${escapeHTML(m.author[0]||"?")}</span><div class="group-message-content"><header>${escapeHTML(m.author)}${live?" · Responding…":""}</header><div class="group-body" ${live?`data-chat-live="${live.agent}"`:""}>${escapeHTML(m.body)}</div>${live?`<small data-chat-activity="${live.agent}">${escapeHTML(live.activity)}</small>`:""}</div></article>`;
}
export function renderChatView(o:{title?:string;subtitle?:string;messages:ChatMessage[];live?:{agent:Agent;author?:string;body:string;activity:string}[];error?:string;errorActions?:string;welcome?:string;composer:string}){
 return `<section class="direct-chat group-chat">${o.title?`<div class="group-header"><strong>${escapeHTML(o.title)}</strong><small>${escapeHTML(o.subtitle||"")}</small></div>`:""}<div class="chat-transcript" aria-live="polite">${o.messages.length?o.messages.map(m=>renderMessage(m)).join(""):o.welcome||""}${(o.live||[]).map(l=>renderMessage({author:l.author??l.agent,body:l.body},l)).join("")}${o.error?`<div class="chat-error" role="alert">${escapeHTML(o.error)}${o.errorActions||""}</div>`:""}</div>${o.composer}</section>`;
}
export function updateChatStream(root:HTMLElement,agent:Agent,body:string,activity:string){const t=root.querySelector(`[data-chat-live="${agent}"]`),a=root.querySelector(`[data-chat-activity="${agent}"]`);if(t)t.textContent=body;if(a)a.textContent=activity}

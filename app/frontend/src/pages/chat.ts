import {profiles,conversation} from "../services/agent-chat";
import {renderChatView} from "../components/chat-view";
import {renderChatComposer} from "../components/chat-composer";
import {escapeHTML} from "../components/primitives";
import {consoles} from "../services/harness-console";
import type { ViewContext } from "../view-context";
import { renderConsole } from "../components/harness-console";
export function renderSessionMonitor(ctx:ViewContext):string {
 const id=ctx.nav.detail.slice(6),c=conversation(id,ctx.nav.projectFilter);
 const a=profiles(ctx.state).find(a=>a.id===id);
 if(!a)return "";
 const live=c.active?consoles[c.active.harness]:undefined;
 const w=live?live.acpContext:c.lastResult?.acpContext;
 const u=live?undefined:c.lastResult?.acpUsage;
 const pct=w&&w.size>0?Math.max(0,Math.min(100,Math.round(w.used/w.size*100))):undefined;
 const status=c.running?"Running":c.lastResult?.sessionId?"Last session":"Not initialized";
 const line=(label:string,value:string)=>'<div style="display:flex;justify-content:space-between;gap:12px"><span>'+escapeHTML(label)+'</span><span>'+escapeHTML(value)+'</span></div>';
 return '<details id="agent-session-monitor" style="border:1px solid #80808044;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:12px"><summary style="cursor:pointer">Session monitor · '+status+' · '+(pct===undefined?"Context unavailable":pct+"% context used")+'</summary><div style="display:grid;gap:6px;padding-top:8px">'+(pct===undefined?"":'<progress style="width:100%" max="100" value="'+pct+'"></progress>')+line("Provider",a.harness)+line("Model preference",a.model)+line("Context",w?w.used.toLocaleString()+" / "+w.size.toLocaleString():"Unavailable")+line("Input / output",u?u.inputTokens.toLocaleString()+" / "+u.outputTokens.toLocaleString():"Unavailable")+line("Reported cost",w?.cost?String(w.cost.amount)+" "+w.cost.currency:"Unavailable")+line("Last session ID",c.lastResult?.sessionId??"Unavailable")+'</div></details>';
}
export function renderChat(ctx:ViewContext):string {
 if(ctx.nav.detail.startsWith("agent:")){
 const id=ctx.nav.detail.slice(6),c=conversation(id,ctx.nav.projectFilter),a=profiles(ctx.state).find(a=>a.id===id);
 const title=id==="group"?"Group":a?.name||"Agent";
 return renderChatView({title,subtitle:id==="group"?profiles(ctx.state).map(a=>a.name).join(" · "):a?.role+" · "+a?.harness,messages:c.messages,live:c.active?[{agent:c.active.harness,author:c.active.name,body:consoles[c.active.harness].output,blocks:consoles[c.active.harness].blocks,activity:consoles[c.active.harness].activity||"Waiting for native CLI…"}]:[],error:c.error,composer:renderChatComposer({id:"agent-chat-prompt",placeholder:"Message "+title+"…",running:c.running,disabled:c.running,send:"data-agent-send",stop:"data-agent-stop",hint:"Enter to send · Shift+Enter for a new line"}).replace('<div class="chat-bottom">','<div class="chat-bottom">'+renderSessionMonitor(ctx))});
 }
 return renderConsole(ctx.nav.detail==="Claude"?"Claude":"Codex",ctx);
}

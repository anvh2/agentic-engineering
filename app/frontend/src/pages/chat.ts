import {profiles,conversation} from "../services/agent-chat";
import {renderChatView} from "../components/chat-view";
import {renderChatComposer} from "../components/chat-composer";
import {issueChat} from "../services/issue-chat";
import {escapeHTML} from "../components/primitives";
import {consoles} from "../services/harness-console";
import type { ViewContext } from "../view-context";
import { renderConsole } from "../components/harness-console";
export function renderChat(ctx:ViewContext):string {
 if(ctx.nav.detail.startsWith("agent:")){
 const id=ctx.nav.detail.slice(6),c=conversation(id,ctx.nav.projectFilter),a=profiles(ctx.state).find(a=>a.id===id);
 const title=id==="group"?"Group":a?.name||"Agent";
 return renderChatView({title,subtitle:id==="group"?profiles(ctx.state).map(a=>a.name).join(" · "):a?.role+" · "+a?.harness,messages:c.messages,live:c.active?[{agent:c.active.harness,author:c.active.name,body:consoles[c.active.harness].output,blocks:consoles[c.active.harness].blocks,activity:consoles[c.active.harness].activity||"Waiting for native CLI…"}]:[],error:c.error,composer:renderChatComposer({id:"agent-chat-prompt",placeholder:"Message "+title+"…",running:c.running,disabled:c.running,send:"data-agent-send",stop:"data-agent-stop",hint:"Enter to send · Shift+Enter for a new line"})});
 }
 const c=issueChat(ctx.nav.detail);if(c&&c.project===ctx.nav.projectFilter)return renderChatView({title:c.title,subtitle:c.running?"Running · "+c.agent:c.error?"Failed":c.messages.some(m=>m.author!=="You")?"Completed":"Starting",messages:c.messages,live:c.running?[{agent:c.agent,body:consoles[c.agent].output,blocks:consoles[c.agent].blocks,activity:consoles[c.agent].activity}]:[],error:c.error,errorActions:(c.dir?'<div>Repository: '+escapeHTML(c.dir)+'</div><button data-issue-repair-repo>Choose local repository</button>':'')+' <button data-issue-retry>Retry</button>',composer:renderChatComposer({id:"issue-chat-prompt",placeholder:"Message @claude or @codex…",running:c.running,send:"data-issue-send",stop:"data-issue-stop",mentions:true,hint:"Enter to send · Shift+Enter for a new line"})});
 return renderConsole(ctx.nav.detail==="Claude"?"Claude":"Codex",ctx);
}

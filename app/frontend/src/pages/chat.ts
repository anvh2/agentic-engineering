import {renderChatComposer} from "../components/chat-composer";
import {issueChat} from "../services/issue-chat";
import {escapeHTML} from "../components/primitives";
import {consoles} from "../services/harness-console";
import type { ViewContext } from "../view-context";
import { renderConsole } from "../components/harness-console";
export function renderChat(ctx:ViewContext):string {
 const c=issueChat(ctx.nav.detail);if(c&&c.project===ctx.nav.projectFilter)return '<section class="direct-chat"><div class="group-header"><strong>'+escapeHTML(c.title)+'</strong><small>'+escapeHTML(c.running?"Running · "+c.agent:c.error?"Failed":c.messages.some(m=>m.author!=="You")?"Completed":"Starting")+'</small></div><div class="chat-transcript">'+c.messages.map(m=>'<article class="group-message '+(m.author==="You"?"human":m.author.toLowerCase())+'"><span class="group-avatar">'+escapeHTML(m.author[0])+'</span><div class="group-message-content"><header>'+escapeHTML(m.author)+'</header><div class="group-body">'+escapeHTML(m.body)+'</div></div></article>').join("")+(c.running?'<div id="issue-live">'+escapeHTML(consoles[c.agent].output)+'</div><small id="issue-live-activity">'+escapeHTML(consoles[c.agent].activity)+'</small>':'')+(c.error?'<div class="chat-error">'+escapeHTML(c.error)+(c.dir?'<div>Repository: '+escapeHTML(c.dir)+'</div><button data-issue-repair-repo>Choose local repository</button>':'')+' <button data-issue-retry>Retry</button></div>':'')+'</div>'+renderChatComposer({id:"issue-chat-prompt",placeholder:"Message @claude or @codex…",running:c.running,send:"data-issue-send",stop:"data-issue-stop",mentions:true,hint:"Enter to send · Shift+Enter for a new line"})+'</section>';
 return renderConsole(ctx.nav.detail==="Claude"?"Claude":"Codex",ctx);
}

import {issueChat} from "../services/issue-chat";
import {escapeHTML} from "../components/primitives";
import {consoles} from "../services/harness-console";
import type { ViewContext } from "../view-context";
import { renderConsole } from "../components/harness-console";
export function renderChat(ctx:ViewContext):string {
 const c=issueChat(ctx.nav.detail);if(c&&c.project===ctx.nav.projectFilter)return '<section class="direct-chat"><div class="group-header"><strong>'+escapeHTML(c.title)+'</strong><small>'+escapeHTML(c.agent)+'</small></div><div class="chat-transcript">'+c.messages.map(m=>'<article class="group-message '+(m.author==="You"?"human":m.author.toLowerCase())+'"><span class="group-avatar">'+escapeHTML(m.author[0])+'</span><div class="group-message-content"><header>'+escapeHTML(m.author)+'</header><div class="group-body">'+escapeHTML(m.body)+'</div></div></article>').join("")+(c.running?'<div id="issue-live">'+escapeHTML(consoles[c.agent].output)+'</div><small id="issue-live-activity">'+escapeHTML(consoles[c.agent].activity)+'</small>':'')+(c.error?'<div class="chat-error">'+escapeHTML(c.error)+'</div>':'')+'</div><div class="chat-bottom"><div class="chat-composer"><textarea id="issue-chat-prompt" placeholder="Message agent…" '+(c.running?'disabled':'')+'></textarea><div class="chat-toolbar">'+(c.running?'<button data-issue-stop>Stop</button>':'<button data-issue-send>Send</button>')+'</div></div></div></section>';
 return renderConsole(ctx.nav.detail==="Claude"?"Claude":"Codex",ctx);
}

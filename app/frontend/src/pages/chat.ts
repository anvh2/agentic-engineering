import type { ViewContext } from "../view-context";
import type { Agent } from "../types";
import { heading, escapeHTML, pill } from "../components/primitives";
import { agentNames, agentStatus } from "../services/agent-connection";
import { consoles } from "../services/harness-console";
import { renderConsole } from "../components/harness-console";

export function renderChat(ctx:ViewContext):string {
 const name=ctx.nav.detail==="Claude"?"Claude":"Codex" as Agent;
 return heading("Chat","Direct native harness interaction")+ `<div class="chat-layout"><div class="chat-list"><small>HARNESSES</small>${agentNames.map(h=>`<button class="chat-entry ${name===h?"selected":""}" data-chat-harness="${h}"><b>${h==="Claude"?"Claude Code":"Codex"}</b><span>${pill(agentStatus(h).state)} ${consoles[h].running?"· Running":""}</span></button>`).join("")}</div><section class="panel chat-main"><div class="between"><b>${name==="Claude"?"Claude Code":"Codex"}</b>${pill(agentStatus(name).state)}</div>${renderConsole(name)}</section></div>`;
}

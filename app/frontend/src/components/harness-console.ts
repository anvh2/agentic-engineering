import {renderChatView} from "./chat-view";
import {renderChatComposer} from "./chat-composer";
import type { Agent } from "../types";
import { escapeHTML } from "./primitives";
import { consoles } from "../services/harness-console";
import { agentStatus } from "../services/agent-connection";
import type { ViewContext } from "../view-context";
export function renderConsole(name:Agent,ctx:ViewContext){
 const c=consoles[name],disabled=c.running||agentStatus(name).state!=="Connected";
 const label=name==="Claude"?"Claude":"Codex";
 return renderChatView({messages:c.messages,live:c.running?[{agent:name,body:c.output,activity:c.activity}]:[],error:c.error,welcome:`<div class="chat-welcome"><span class="chat-avatar ${name.toLowerCase()}">${name[0]}</span><h2>Chat with ${label}</h2><p class="muted">Ask a question or attach a local repository.</p></div>`,composer:renderChatComposer({id:"console-prompt",placeholder:"Message "+label+"…",draft:c.prompt,running:c.running,disabled,send:`data-run-prompt="${name}"`,stop:`data-stop-prompt="${name}"`,toolbar:`<details class="chat-context"><summary title="${escapeHTML(c.dir||"No repository selected")}">⌘ ${escapeHTML(c.dir?c.dir.split("/").filter(Boolean).pop()||c.dir:"Add repository")}</summary><div class="chat-context-menu"><button data-browse-repo ${c.running?"disabled":""}>Choose local folder…</button><button data-current-repo ${c.running?"disabled":""}>Use current repository</button><input id="console-dir" value="${escapeHTML(c.dir)}" placeholder="Local path" ${c.running?"disabled":""}><button data-clear-repo ${c.running?"disabled":""}>Remove repository</button></div></details><button data-review-prompt ${disabled?"disabled":""}>Review</button><button data-terminal="${name}" ${disabled?"disabled":""}>Terminal</button>`,hint:"Independent prompts · Review mode · Enter to send"})});
}

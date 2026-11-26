import type { Agent } from "../types";
import { escapeHTML } from "./primitives";
import { consoles } from "../services/harness-console";
import { agentStatus } from "../services/agent-connection";
export function renderConsole(name:Agent){
 const c=consoles[name],disabled=c.running||agentStatus(name).state!=="Connected";
 return `<div class="harness-console"><div class="chat-directory"><small>Repository</small><input id="console-dir" ${c.running?"disabled":""} value="${escapeHTML(c.dir)}" placeholder="Absolute working directory"></div><div class="chat-transcript" aria-live="polite">${c.turns.length?c.turns.map(t=>`<div class="chat-turn ${t.role}"><small>${t.role==="user"?"You":name}</small>${escapeHTML(t.body)}</div>`).join(""):'<div class="work-empty"><h2>Start a native prompt</h2><p class="muted">Choose a repository and send a message.</p></div>'}${c.running?'<p class="muted">Waiting for native CLI…</p>':""}${c.error?`<p class="note">${escapeHTML(c.error)}</p>`:""}</div><div class="chat-composer"><textarea id="console-prompt" rows="3" placeholder="Message the harness…" ${c.running?"disabled":""}>${escapeHTML(c.prompt)}</textarea><div class="right"><button data-terminal="${name}" ${disabled?"disabled":""}>Open Terminal</button>${c.running?`<button data-stop-prompt="${name}">Stop</button>`:`<button class="primary" data-run-prompt="${name}" ${disabled?"disabled":""}>Send ↑</button>`}</div></div><small>Independent native prompts · History is display only · Account usage applies</small></div>`;
}

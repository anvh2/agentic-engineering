import type { ViewContext } from "../view-context";
import { escapeHTML, pill, action, heading, panel, line } from "../components/primitives";
import { agentNames, agentStatus, configuredPath } from "../services/agent-connection";
export function renderTeam(ctx:ViewContext):string {
 const {state,nav,tabs,options}=ctx;
 if(nav.tab==="Roles")return heading("Team","Native agents and reusable role knowledge")+tabs(["Agents","Roles"])+`<div class="between space"><select id="role-select">${options(Object.keys(state.roles),nav.roleSelected)}</select>${action("+ New role",'data-open="role"')}</div>`+panel("Base knowledge",`<textarea id="role-knowledge" class="editor">${escapeHTML(state.roles[nav.roleSelected])}</textarea><div class="right">${action("Save role","data-save-role",true)}</div>`);
 return heading("Team","Discover and connect native agents",action("Rescan all","data-rescan"))+tabs(["Agents","Roles"])+agentNames.map(name=>{
 const s=agentStatus(name);
 return panel(name==="Claude"?"Claude Code":"Codex CLI",line("Connection",pill(s.state))+line("Executable",escapeHTML(s.path||"Not detected"))+line("Version",escapeHTML(s.version||"Unknown"))+line("Authentication",escapeHTML(s.authentication))+line("MCP","Not verified")+ `<label for="agent-path-${name}">Executable override (optional)</label><input id="agent-path-${name}" value="${escapeHTML(configuredPath(name))}" placeholder="Automatic discovery"><div class="right"><button data-check-agent="${name}" ${s.state==="Checking"?"disabled":""}>Test connection</button></div><p class="note">${escapeHTML(s.diagnostic)}${s.state==="Login required"?` Sign in using the native ${name==="Claude"?"claude":"codex login"} command in Terminal, then rescan.`:""}</p>`);
 }).join("");
}

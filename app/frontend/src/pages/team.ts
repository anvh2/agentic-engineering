import type { ViewContext } from "../view-context";
import { escapeHTML, pill, action, heading, panel, line } from "../components/primitives";
import { agentNames, agentStatus, configuredPath } from "../services/agent-connection";
export function renderTeam(ctx:ViewContext):string {
 const {state,nav,tabs,options}=ctx;
 if(nav.tab==="Roles")return heading("Team","Native harnesses and reusable role knowledge")+tabs(["Harnesses","Roles"])+`<div class="between space"><select id="role-select">${options(Object.keys(state.roles),nav.roleSelected)}</select>${action("+ New role",'data-open="role"')}</div>`+panel("Base knowledge",`<textarea id="role-knowledge" class="editor">${escapeHTML(state.roles[nav.roleSelected])}</textarea><div class="right">${action("Save role","data-save-role",true)}</div>`);
 return heading("Team","Native execution environments",action("Rescan all","data-rescan"))+tabs(["Harnesses","Roles"])+agentNames.map(name=>{
 const s=agentStatus(name), expanded=nav.detail===name;
 return `<section class="panel harness-panel"><button class="harness-row" data-harness="${name}" aria-expanded="${expanded}"><span><b>${name==="Claude"?"Claude Code":"Codex CLI"}</b><small>${escapeHTML(s.version||"Native CLI")}</small></span><span>${pill(s.state)} <span aria-hidden="true">${expanded?"⌃":"⌄"}</span></span></button>${expanded? `<div class="harness-detail">`+line("Executable",escapeHTML(s.path||"Not detected"))+line("Authentication",escapeHTML(s.authentication))+line("MCP","Not verified")+ `<label for="agent-path-${name}">Executable override (optional)</label><input id="agent-path-${name}" value="${escapeHTML(configuredPath(name))}" placeholder="Automatic discovery"><div class="right"><button data-check-agent="${name}" ${s.state==="Checking"?"disabled":""}>Test connection</button></div><p class="note">${escapeHTML(s.diagnostic)}</p>`+ "</div>":""}</section>`;
 }).join("");
}

import type { ViewContext } from "../view-context";
import { escapeHTML, cash, sum, pill, action, heading, panel, line } from "../components/primitives";
export function renderTeam(ctx: ViewContext): string {
  const {state,nav,getObjective,getProject,visibleObjectives,visibleSessions,tabs,projectOptions,roleOptions,options,table,objectiveList,repos,conversation,decisionList,projectKnowledge,editor} = ctx;
  const {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent} = nav;
  const objectives=visibleObjectives(),sessions=visibleSessions();
  const selectedObjective=getObjective(detail),selectedProject=getProject(detail),selectedSession=state.sessions.find(s=>s.id===detail);
  return heading("Team","Native agents and reusable role knowledge")+tabs(["Agents","Roles"])+(tab==="Roles"?`<div class="between space"><select id="role-select">${options(Object.keys(state.roles),roleSelected)}</select>${action("+ New role",'data-open="role"')}</div>`+panel("Base knowledge",`<p class="muted">Loaded when the role is assigned to a session.</p><textarea id="role-knowledge" class="editor">${escapeHTML(state.roles[roleSelected])}</textarea><div class="right">${action("Save role","data-save-role",true)}</div>`):["Claude","Codex"].map((a)=>panel(a,line("Runtime",a==="Claude"?"Claude Code":"Codex CLI")+line("Native tools, skills and permissions",pill("Preserved by design"))+line("MCP collaboration",pill("Not connected")))).join(""));
}

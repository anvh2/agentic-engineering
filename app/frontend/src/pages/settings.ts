import type { ViewContext } from "../view-context";
import { escapeHTML, cash, sum, pill, action, heading, panel, line } from "../components/primitives";
export function renderSettings(ctx: ViewContext): string {
  const {state,nav,getObjective,getProject,visibleObjectives,visibleSessions,tabs,projectOptions,roleOptions,options,table,objectiveList,repos,conversation,decisionList,projectKnowledge,editor} = ctx;
  const {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent} = nav;
  const objectives=visibleObjectives(),sessions=visibleSessions();
  const selectedObjective=getObjective(detail),selectedProject=getProject(detail),selectedSession=state.sessions.find(s=>s.id===detail);
  return heading("Settings","Local-first desktop preferences")+panel("Architecture",line("Backend","Go + Wails")+line("Data","UI demo in localStorage")+line("Embedded MCP","Planned; not connected")+line("Claude / Codex CLI","Not connected"))+panel("Budget",`<label>Estimated budget per objective (USD)</label><input type="number" min="0" id="budget" value="${state.settings.budget}">${action("Save","data-save-budget",true)}`);
}

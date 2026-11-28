import type { ViewContext } from "../view-context";
import { escapeHTML, cash, sum, pill, action, heading, panel, line } from "../components/primitives";
export function renderSessions(ctx: ViewContext): string {
  const {state,nav,getObjective,getProject,visibleObjectives,visibleSessions,tabs,projectOptions,roleOptions,options,table,objectiveList,repos,conversation,decisionList,projectKnowledge,editor} = ctx;
  const {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent} = nav;
  const objectives=visibleObjectives(),sessions=visibleSessions();
  const selectedObjective=getObjective(detail),selectedProject=getProject(detail),selectedSession=state.sessions.find(s=>s.id===detail);
  return selectedSession?heading(selectedSession.id+" · "+selectedSession.agent,selectedSession.task,action("All sessions","data-back"))+tabs(["Timeline","Context","Usage"])+(tab==="Context"?panel("Knowledge bootstrap",line("Global Engineering DNA",pill("Demo"))+line(selectedSession.role+" role",pill("Demo"))+line("Project / Task context",pill("Demo"))+`<pre>${escapeHTML(selectedSession.context||"Unavailable")}</pre>`):tab==="Usage"?panel("Usage",line("Tokens",Number(selectedSession.tokens).toLocaleString())+line("API-equivalent cost",cash(selectedSession.cost))+line("Actual billing","Unavailable")):panel("Session timeline",line("Status",pill(selectedSession.status))+line("Role",escapeHTML(selectedSession.role))+line("Runtime","Not connected"))):heading("Sessions","Native session history (illustrative)")+panel("Sessions",table(sessions));
}

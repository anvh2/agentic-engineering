import type { ViewContext } from "../view-context";
import { escapeHTML, cash, sum, pill, action, heading, panel, line } from "../components/primitives";
export function renderUsageCost(ctx: ViewContext): string {
  const {state,nav,getObjective,getProject,visibleObjectives,visibleSessions,tabs,projectOptions,roleOptions,options,table,objectiveList,repos,conversation,decisionList,projectKnowledge,editor} = ctx;
  const {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent} = nav;
  const objectives=visibleObjectives(),sessions=visibleSessions();
  const selectedObjective=getObjective(detail),selectedProject=getProject(detail),selectedSession=state.sessions.find(s=>s.id===detail);
  {const selected=sessions.filter((s)=>usageAgent==="All"||s.agent===usageAgent);return heading("Usage & Cost","Illustrative API-equivalent estimates",`<select id="agent-filter">${options(["All","Claude","Codex"],usageAgent)}</select>`)+`<div class="metrics"><div class="metric"><small>Tokens</small><strong>${sum(selected,"tokens").toLocaleString()}</strong></div><div class="metric"><small>Estimated cost</small><strong>${cash(sum(selected,"cost"))}</strong></div></div>`+panel("By objective",objectives.map((o)=>line(escapeHTML(o.title),cash(sum(selected.filter((s)=>s.objective===o.id),"cost")))).join(""))+panel("Sessions",table(selected))+`<p class="note">Actual subscription billing is unavailable. Shared repositories do not duplicate cost.</p>`}
}

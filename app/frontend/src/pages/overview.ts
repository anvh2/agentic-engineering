import type { ViewContext } from "../view-context";
import { escapeHTML, cash, sum, pill, action, heading, panel, line } from "../components/primitives";
export function renderOverview(ctx: ViewContext): string {
  const {state,nav,getObjective,getProject,visibleObjectives,visibleSessions,tabs,projectOptions,roleOptions,options,table,objectiveList,repos,conversation,decisionList,projectKnowledge,editor} = ctx;
  const {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent} = nav;
  const objectives=visibleObjectives(),sessions=visibleSessions();
  const selectedObjective=getObjective(detail),selectedProject=getProject(detail),selectedSession=state.sessions.find(s=>s.id===detail);
  return heading("Overview",(projectFilter==="all"?"All projects":getProject(projectFilter)?.name)+" · Demo data",action("+ New objective",'data-open="objective"',true))+`<div class="metrics">${[["Objectives",objectives.length],["Sessions",sessions.length],["Total tokens",(sum(sessions,"tokens")/1e6).toFixed(2)+"M"],["Estimated cost",cash(sum(sessions,"cost"))]].map(([n,v])=>`<div class="metric"><small>${n}</small><strong>${v}</strong></div>`).join("")}</div><div class="columns">${panel("Agents",["Claude","Codex"].map((a)=>line(`<span class="avatar ${a==="Codex"?"codex":""}">${a[0]}</span> <b>${a}</b>`,pill("Not connected"))).join(""))}${panel("Cost by objective",objectives.map((o)=>line(escapeHTML(o.title),cash(sum(sessions.filter((s)=>s.objective===o.id),"cost")))).join(""))}</div>${panel("Objectives",objectiveList(objectives))}${panel("Recent sessions",table(sessions.slice(0,5)))}`;
}

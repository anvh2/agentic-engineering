import type { ViewContext } from "../view-context";
import { escapeHTML, cash, sum, pill, action, heading, panel, line } from "../components/primitives";
export function renderCollaboration(ctx: ViewContext): string {
  const {state,nav,getObjective,getProject,visibleObjectives,visibleSessions,tabs,projectOptions,roleOptions,options,table,objectiveList,repos,conversation,decisionList,projectKnowledge,editor} = ctx;
  const {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent} = nav;
  const objectives=visibleObjectives(),sessions=visibleSessions();
  const selectedObjective=getObjective(detail),selectedProject=getProject(detail),selectedSession=state.sessions.find(s=>s.id===detail);
  return heading("Collaboration","Agent conversations and human feedback",`<select id="discussion-select">${objectives.map((o)=>`<option value="${o.id}" ${o.id===discussion?"selected":""}>${escapeHTML(o.title)}</option>`).join("")}</select>`)+(objectives.length?conversation(objectives.find((o)=>o.id===discussion)?.id||objectives[0].id):panel("Discussion","No objective selected."));
}

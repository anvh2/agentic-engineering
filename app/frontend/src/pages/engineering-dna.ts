import type { ViewContext } from "../view-context";
import { escapeHTML, cash, sum, pill, action, heading, panel, line } from "../components/primitives";
export function renderEngineeringDNA(ctx: ViewContext): string {
  const {state,nav,getObjective,getProject,visibleObjectives,visibleSessions,tabs,projectOptions,roleOptions,options,table,objectiveList,repos,conversation,decisionList,projectKnowledge,editor} = ctx;
  const {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent} = nav;
  const objectives=visibleObjectives(),sessions=visibleSessions();
  const selectedObjective=getObjective(detail),selectedProject=getProject(detail),selectedSession=state.sessions.find(s=>s.id===detail);
  return heading("Engineering DNA","Human-owned knowledge and skills")+tabs(["Knowledge","Skills"])+(tab==="Skills"?panel("Skills",["Go engineering","Debugging","Testing","Security","System design"].map((s)=>line(escapeHTML(s),pill("On demand"))).join("")):editor(state.knowledge,"global"));
}

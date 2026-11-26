import type { ViewContext } from "../view-context";
import { escapeHTML, cash, sum, pill, action, heading, panel, line } from "../components/primitives";
export function renderProjects(ctx: ViewContext): string {
  const {state,nav,getObjective,getProject,visibleObjectives,visibleSessions,tabs,projectOptions,roleOptions,options,table,objectiveList,repos,conversation,decisionList,projectKnowledge,editor} = ctx;
  const {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent} = nav;
  const objectives=visibleObjectives(),sessions=visibleSessions();
  const selectedObjective=getObjective(detail),selectedProject=getProject(detail),selectedSession=state.sessions.find(s=>s.id===detail);
  return selectedProject?heading(selectedProject.name,selectedProject.description,action("All projects","data-back"))+tabs(["Overview","Repositories","Knowledge"])+(tab==="Knowledge"?editor(projectKnowledge(selectedProject),selectedProject.id):panel("Repositories",repos(selectedProject.repos,tab==="Repositories")+(tab==="Repositories"?action("+ Link repository",'data-open="repo"'):""))+panel("Objectives",objectiveList(state.objectives.filter((o)=>o.project===selectedProject.id)))):heading("Projects","Project context and shared repositories",action("+ New project",'data-open="project"',true))+state.projects.map((p)=>`<section class="panel clickable" data-project="${escapeHTML(p.id)}"><h2>${escapeHTML(p.name)}</h2><small>${escapeHTML(p.description)}</small><p>${p.repos.map((id)=>escapeHTML(state.repos.find((r)=>r.id===id)?.name)).join(" · ")}</p></section>`).join("");
}

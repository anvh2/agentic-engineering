import type { Agent } from "./types";
import type { ViewContext } from "./view-context";
import { demoStore } from "./services/demo-store";
import { renderLayout } from "./components/layout";
export function mountController(root: HTMLElement, ctx: ViewContext) {
  const {state,nav,getObjective,getProject}=ctx;
  let {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent}=nav;
  const persist=()=>{try{demoStore.save(state)}catch{window.alert("Could not save demo data.");}};
  const render=()=>{Object.assign(nav,{page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent});renderLayout(root,ctx);docSelected=nav.docSelected;};
  const value=(id: string)=>document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#"+id)?.value?.trim()||"";
  root.addEventListener("click",(event)=>{
    if (!(event.target instanceof Element)) return;
    const el=event.target.closest<HTMLElement>("button,[data-objective],[data-project],[data-session]");
    if(!el)return;
    const data=el.dataset, objective=getObjective(detail), project=getProject(detail);
    if(data.page){page=data.page;detail="";tab="";}
    else if(data.objective){page="Objectives";detail=data.objective;tab="";}
    else if(data.project){page="Projects";detail=data.project;tab="";}
    else if(data.session){page="Sessions";detail=data.session;tab="";}
    else if("back" in data){detail="";tab="";}
    else if(data.tab)tab=data.tab;
    else if(data.open)modal=data.open;
    else if("cancel" in data)modal="";
    else if("create" in data){
      const name=value("new-name"),id=crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if(modal!=="repo"&&!name){window.alert("Name is required.");return;}
      if(modal==="repo"&&!value("new-repo")&&!name){window.alert("Select a repository or enter a path.");return;}
      if(modal==="objective"&&!getProject(value("new-project"))){window.alert("Create or select a project first.");return;}
      if(modal==="project"){state.projects.push({id,name,description:value("new-description"),repos:[],knowledge:{}});page="Projects";detail=id;}
      else if(modal==="objective"){const pid=value("new-project");const key="OBJ-"+id;state.objectives.push({id:key,project:pid,title:name,description:value("new-description"),criteria:value("new-criteria"),status:"Planned",repos:[...(getProject(pid)?.repos||[])],assignments:{Claude:value("new-Claude"),Codex:value("new-Codex")},tasks:[]});page="Objectives";projectFilter=pid;detail=key;}
      else if(modal==="repo"&&project){let repoID=value("new-repo");if(!repoID&&name){let repo=state.repos.find((r)=>r.path===name);if(!repo){repo={id,name:name.split("/").filter(Boolean).pop()||name,path:name};state.repos.push(repo)}repoID=repo.id;}if(repoID&&!project.repos.includes(repoID))project.repos.push(repoID);}
      else if(modal==="task"&&objective)objective.tasks.push({text:name,done:false});
      else if(modal==="role"){if(Object.hasOwn(state.roles,name)){window.alert("Role already exists.");return;}
      if(["__proto__","constructor","prototype"].includes(name)){window.alert("Invalid role name.");return;}state.roles[name]=value("new-description");roleSelected=name;}
      modal="";
    }
    else if(data.unlink&&project)project.repos=project.repos.filter((id)=>id!==data.unlink);
    else if(data.send){const message=value("message");if(!message)return;state.messages.push({objective:data.send,agent:"You",body:message});}
    else if(data.decision){const d=state.decisions.find((d)=>d.id===data.decision);if(d && data.result)d.status=data.result;}
    else if(data.doc)docSelected=data.doc;
    else if(data.saveKnowledge){const target=data.saveKnowledge==="global"?state.knowledge:getProject(data.saveKnowledge)?.knowledge;if(target && !["__proto__","constructor","prototype"].includes(docSelected))target[docSelected]=value("knowledge-editor");}
    else if("saveRole" in data)state.roles[roleSelected]=value("role-knowledge");
    else if("simulate" in data && objective){if(state.sessions.some((s)=>s.objective===objective.id&&s.status==="Running"))return;for(const [agent,role] of Object.entries(objective.assignments as Record<string, string>)){if(role==="Not assigned")continue;state.sessions.push({id:"S-"+Date.now()+"-"+agent,objective:objective.id,agent,role,task:objective.title,status:"Running",tokens:0,cost:0,context:state.roles[role]||""});}if(Object.values(objective.assignments).some(role=>role!=="Not assigned")) objective.status="In progress";}
    else if("saveBudget" in data)state.settings.budget=Math.max(0,Number(value("budget"))||0);
    else return;
    persist();render();
  });
  root.addEventListener("change",(event)=>{
    const el=event.target as HTMLInputElement,data=el.dataset,objective=getObjective(detail);
    if(el.id==="project-filter"){projectFilter=el.value;detail="";tab="";}
    else if(el.id==="discussion-select")discussion=el.value;
    else if(el.id==="role-select")roleSelected=el.value;
    else if(el.id==="agent-filter")usageAgent=el.value;
    else if(data.agent&&objective)objective.assignments[data.agent as Agent]=el.value;
    else if(data.task!==undefined&&objective){const task=objective.tasks[Number(data.task)];if(task)task.done=el.checked;}
    else return;
    persist();render();
  });

  render();
}

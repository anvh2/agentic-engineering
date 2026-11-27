import { saveIssue,statuses,issues,boardContext,nextIssueKey,projectPrefix,setProjectPrefix } from "./services/work-board";
import { mountMentions } from "./components/mentions";
import { group,groupSend,stopGroup } from "./services/collaboration";
import { consoles, runPrompt, stopPrompt, openTerminal, currentRepository, browseRepository, subscribeChat } from "./services/harness-console";
import { scanAgent, scanAgents } from "./services/agent-connection";
import type { Agent } from "./types";
import type { ViewContext } from "./view-context";
import { demoStore } from "./services/demo-store";
import { renderLayout } from "./components/layout";
export function mountController(root: HTMLElement, ctx: ViewContext) {
  mountMentions(root);
  const {state,nav,getObjective,getProject}=ctx;
  let {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent}=nav;
  const persist=()=>{try{demoStore.save(state)}catch{window.alert("Could not save demo data.");}};
  const render=()=>{Object.assign(nav,{page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent});renderLayout(root,ctx);docSelected=nav.docSelected;};
  subscribeChat(name=>{if(page==="Collaboration"&&group.active.includes(name)){const t=root.querySelector("#group-live-"+name),a=root.querySelector("#group-activity-"+name);if(t)t.textContent=consoles[name].output;if(a)a.textContent=consoles[name].activity;return;}if(page!=="Chat"||(detail||"Codex")!==name)return;const t=root.querySelector("#live-chat-text"),a=root.querySelector("#live-chat-activity");if(t)t.textContent=consoles[name].output;if(a)a.textContent=consoles[name].activity;});
  const value=(id: string)=>document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#"+id)?.value?.trim()||"";
  root.addEventListener("click",(event)=>{
    if (!(event.target instanceof Element)) return;
    const el=event.target.closest<HTMLElement>("button,[data-objective],[data-project],[data-session]");
    if(!el)return;
    const data=el.dataset, objective=getObjective(detail), project=getProject(detail);
    if("boardPrefix" in data){const p=getProject(projectFilter);if(p){const v=window.prompt("Issue prefix (new issues only)",projectPrefix(p.id,p.name));if(v!==null){try{setProjectPrefix(p.id,v);render()}catch(e){window.alert(String(e))}}}return;}
    if("boardNew" in data){detail="new-issue:"+(statuses.find(s=>s===data.boardNew)||"Todo");render();return;}
    if(data.boardId){detail=data.boardId;render();return;}
    if("boardClose" in data){detail="";render();return;}
    if("boardComment" in data){const issue=issues().find(x=>x.id===detail&&x.project===projectFilter),body=value("issue-comment").trim();if(issue&&body){saveIssue({...issue,comments:[...(issue.comments||[]),{body,at:new Date().toISOString()}]});render()}return;}
    if("boardSave" in data){const title=value("issue-title"),status=statuses.find(s=>s===value("issue-status"));if(!title||!status||!getProject(projectFilter))return;const existing=issues().find(x=>x.id===detail&&x.project===projectFilter);try{saveIssue({id:existing?.id||crypto.randomUUID(),issueKey:existing?.issueKey||nextIssueKey(projectFilter,getProject(projectFilter)!.name),project:projectFilter,createdAt:existing?.createdAt||new Date().toISOString(),comments:existing?.comments||[],title,description:value("issue-description"),criteria:value("issue-criteria"),status,assignee:value("issue-assignee"),repository:value("issue-repo")});detail="";render()}catch(e){window.alert(String(e))}return;}
    if("groupStart" in data||"groupSend" in data){void groupSend("groupStart" in data?"Hello Claude and Codex! Please introduce yourselves and greet each other.":value("group-prompt"),()=>{if(page==="Collaboration")render()},boardContext(projectFilter));return;}
    if("groupStop" in data){void stopGroup();return;}
    if(data.switchProject){projectFilter=data.switchProject;detail="";tab="";render();return;}
    if("clearRepo" in data){consoles[detail==="Claude"?"Claude":"Codex"].dir="";render();return;}
    if("browseRepo" in data){const name=detail==="Claude"?"Claude":"Codex";void browseRepository().then(dir=>{if(dir){consoles[name].dir=dir;if(page==="Chat")render();}}).catch(e=>{consoles[name].error=String(e);render()});return;}
    if("currentRepo" in data){const name=detail==="Claude"?"Claude":"Codex";void currentRepository().then(dir=>{if(!dir){window.alert("No Git repository found in the app working directory. Enter the local path.");return;}consoles[name].dir=dir;if(page==="Chat")render();}).catch(e=>window.alert(String(e)));return;}
    if("reviewPrompt" in data){const c=consoles[detail==="Claude"?"Claude":"Codex"];if(!c.dir.trim()){window.alert("Select a real repository directory before reviewing code.");return;}c.prompt="Review this repository without modifying files. Inspect the current branch, architecture, correctness, security, maintainability and tests. Report prioritized findings with file references and distinguish verified evidence from assumptions.";render();return;}
    if(data.chatHarness){page="Chat";detail=data.chatHarness;render();return;}
    if(data.harness){detail=detail===data.harness?"":data.harness;render();return;}
    if(data.runPrompt||data.stopPrompt||data.terminal){
      if(group.busy){window.alert("Finish the group conversation first.");return;}
      const name=(data.runPrompt||data.stopPrompt||data.terminal) as Agent;
      const c=consoles[name];c.dir=value("console-dir");if(!c.running)c.prompt=value("console-prompt");
      if(data.terminal&&!c.dir){window.alert("Choose a working directory first.");return;}
      const pending=data.runPrompt?runPrompt(name):data.stopPrompt?stopPrompt(name):openTerminal(name);
      render();void pending.catch(e=>{c.error=String(e)}).finally(()=>{if(page==="Chat"&&(detail||"Codex")===name&&!modal)render()});return;
    }
    if("rescan" in data || data.checkAgent){
      const pending=data.checkAgent ? scanAgent(data.checkAgent as Agent,value("agent-path-"+data.checkAgent)) : scanAgents();
      render(); void pending.then(()=>{if(page==="Team" && tab!=="Roles" && !modal)render();else if(page==="Overview"&&!modal)render();});return;
    }
    if(data.page){page=data.page;detail=page==="Chat"?"Codex":"";tab="";}
    else if(data.objective){page="Objectives";detail=data.objective;tab="";}
    else if(data.project){page="Projects";detail=data.project;tab="";}
    else if(data.session){page="Sessions";detail=data.session;tab="";}
    else if("back" in data){detail="";tab="";}
    else if(data.tab){tab=data.tab;detail="";}
    else if(data.open)modal=data.open;
    else if("cancel" in data)modal="";
    else if("create" in data){
      const name=value("new-name"),id=crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if(modal!=="repo"&&!name){window.alert("Name is required.");return;}
      if(modal==="repo"&&!value("new-repo")&&!name){window.alert("Select a repository or enter a path.");return;}
      if(modal==="objective"&&!getProject(value("new-project"))){window.alert("Create or select a project first.");return;}
      if(modal==="project"){state.projects.push({id,name,description:value("new-description"),repos:[],knowledge:{}});page="Projects";projectFilter=id;detail=id;}
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
  document.addEventListener("pointerdown",event=>{const menu=root.querySelector<HTMLDetailsElement>(".project-switcher[open]");if(menu&&event.target instanceof Node&&!menu.contains(event.target))menu.open=false;});
  root.addEventListener("keydown",event=>{if(event.key==="Escape"){const menu=root.querySelector<HTMLDetailsElement>(".project-switcher[open]");if(menu){menu.open=false;menu.querySelector("summary")?.focus();}}});
  root.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing&&event.target instanceof HTMLTextAreaElement&&["console-prompt","group-prompt"].includes(event.target.id)){event.preventDefault();root.querySelector<HTMLButtonElement>(event.target.id==="group-prompt"?"[data-group-send]":"[data-run-prompt]")?.click();}});
  root.addEventListener("input",(event)=>{if(event.target instanceof HTMLTextAreaElement&&event.target.id==="group-prompt"){group.draft=event.target.value;return;}if(page!=="Chat"||!(event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement))return;const c=consoles[detail==="Claude"?"Claude":"Codex"];if(c.running)return;if(event.target.id==="console-dir")c.dir=event.target.value;if(event.target.id==="console-prompt")c.prompt=event.target.value;});
  root.addEventListener("change",(event)=>{const field=event.target;if(page==="Objectives"&&(field instanceof HTMLInputElement||field instanceof HTMLTextAreaElement||field instanceof HTMLSelectElement)){const issue=issues().find(x=>x.id===detail&&x.project===projectFilter);const keys={"issue-title":"title","issue-description":"description","issue-criteria":"criteria","issue-status":"status","issue-assignee":"assignee","issue-repo":"repository"} as const;const key=keys[field.id as keyof typeof keys];if(issue&&key){const status=root.querySelector<HTMLElement>(".mc-save-status");try{if(key==="title"&&!field.value.trim())throw new Error("Title is required");if(key==="status"&&!statuses.some(s=>s===field.value))throw new Error("Invalid status");saveIssue({...issue,[key]:field.value});if(status)status.textContent="Saved";if(key==="title"){const heading=root.querySelector(".mc-detail-toolbar strong");if(heading)heading.textContent=field.value}}catch(e){if(status)status.textContent=String(e);field.value=issue[key]}return;}}

    const el=event.target as HTMLInputElement,data=el.dataset,objective=getObjective(detail);
    if(el.id==="chat-repository"){consoles[detail==="Claude"?"Claude":"Codex"].dir=el.value;render();return;}
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
  void scanAgents().then(()=>{if((page==="Overview"||page==="Chat"||page==="Team"&&tab!=="Roles")&&!modal)render();});
}

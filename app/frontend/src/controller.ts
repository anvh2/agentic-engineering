import {profiles,sendAgentChat,stopAgentChat} from "./services/agent-chat";
import {updateChatStream} from "./components/chat-view";
import {executeIssue,explicitTargets,issueChat,stopIssue} from "./services/issue-chat";
import { saveIssue,statuses,priorities,issues,boardContext,nextIssueKey,projectPrefix,setProjectPrefix } from "./services/work-board";
import { mountMentions } from "./components/mentions";
import { group,stopGroup } from "./services/collaboration";
import { consoles, runPrompt, stopPrompt, openTerminal, currentRepository, browseRepository, subscribeChat } from "./services/harness-console";
import { scanAgent, scanAgents } from "./services/agent-connection";
import type { Agent } from "./types";
import type { ViewContext } from "./view-context";
import { demoStore } from "./services/demo-store";
import { renderLayout } from "./components/layout";
import { syncKnowledge,listKnowledgeRefs,importKnowledgeJSON,readKnowledgeEntry,knowledgeApplicable } from "./services/knowledge-source";
import { subscribeKnowledgeEvents,storeKnowledgeResult } from "./services/knowledge-trace";
export function mountController(root: HTMLElement, ctx: ViewContext) {
  mountMentions(root);
  const {state,nav,getObjective,getProject}=ctx;
  let {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent}=nav;
  const persist=()=>{try{demoStore.save(state)}catch{window.alert("Could not save demo data.");}};
  const render=()=>{Object.assign(nav,{page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent});renderLayout(root,ctx);docSelected=nav.docSelected;};
  subscribeKnowledgeEvents(agentId=>{if(page==="Team"&&detail===agentId)render()});
  subscribeChat(name=>{if(page==="Chat"||page==="Collaboration")updateChatStream(root,name,consoles[name].output,consoles[name].activity)});
  const updateIssue=()=>{if(page==="Chat"||page==="Objectives")render()};
  const launch=(issue:import("./services/work-board").Issue,agent:Agent,request:string)=>{void executeIssue(issue,agent,request,state,updateIssue)};
  const startAssigned=(issue:import("./services/work-board").Issue)=>{if(issue.assignee==="Claude"||issue.assignee==="Codex")launch(issue,issue.assignee,"Implement this issue and report evidence.")};
  root.addEventListener("issue-start",((e:CustomEvent)=>{startAssigned(e.detail)}) as EventListener);
  const value=(id: string)=>document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#"+id)?.value?.trim()||"";
  root.addEventListener("click",async (event)=>{
    if (!(event.target instanceof Element)) return;
    const el=event.target.closest<HTMLElement>("button,[data-objective],[data-project],[data-session]");
    if(!el)return;
    const data=el.dataset, objective=getObjective(detail), project=getProject(detail);
    if("agentNew" in data){detail="new-agent";render();return;}
    if("agentCreate" in data){
      const name=value("new-agent-name"),handle=value("new-agent-handle").replace(/^@/,"").toLowerCase(),role=value("new-agent-role"),harness=value("new-agent-harness");
      const status=root.querySelector<HTMLElement>("[data-profile-status]");
      if(!name||name.length>80||!role||!/^[a-z][a-z0-9_-]{0,39}$/.test(handle)||profiles(state).some(a=>a.handle===handle)|| (harness!=="Claude"&&harness!=="Codex")){if(status)status.textContent="Enter a name, unique valid handle, role and harness.";return;}
      const id=crypto.randomUUID();state.agentProfiles??={};state.agentProfiles[id]={name,handle,role,harness,model:value("new-agent-model")||"Default"};
      detail=id;tab="Knowledge Graph 0";persist();render();return;
    }
    if(data.profileSave){
      const id=data.profileSave,handle=value("profile-handle").trim().replace(/^@/,"").toLowerCase();
      const status=root.querySelector<HTMLElement>("[data-profile-status]");
      const duplicate=profiles(state).some(other=>other.id!==id&&other.handle===handle);
      if(!/^[a-z][a-z0-9_-]{0,39}$/.test(handle)||duplicate){if(status)status.textContent="Invalid or duplicate handle";return;}
      const harness=value("profile-harness");if(harness!=="Claude"&&harness!=="Codex")return;
      state.agentProfiles??={};
      state.agentProfiles[id]={...state.agentProfiles[id],handle,role:value("profile-role"),harness,model:value("profile-model").trim()||"Default"};
      persist();render();return;
    }
    if(data.profileChat){
      const id=data.profileChat;
      const profile=profiles(state).find(a=>a.id===id);if(!profile)return;
      if(consoles[profile.harness as Agent].running){window.alert("Harness already running");return;}
      page="Chat";detail="agent:"+id;tab="";render();return;
    }
    if(data.knowledgeImportMode){
      const mode=data.knowledgeImportMode;
      root.querySelectorAll<HTMLElement>("[data-knowledge-pane]").forEach(p=>{p.hidden=p.dataset.knowledgePane!==mode});
      root.querySelectorAll<HTMLButtonElement>("[data-knowledge-import-mode]").forEach(btn=>btn.setAttribute("aria-pressed",String(btn.dataset.knowledgeImportMode===mode)));
      return;
    }
    if("knowledgeRefs" in data){
      const status=root.querySelector<HTMLElement>("[data-knowledge-source-status]");
      const repository=value("knowledge-github-url");
      if(status)status.textContent="Discovering GitHub branches and tags...";
      try{
        const refs=await listKnowledgeRefs(repository);
        const choice=root.querySelector<HTMLSelectElement>("#knowledge-discovered-ref");
        if(choice){
          choice.replaceChildren();
          const original=document.createElement("option");original.value="";original.textContent="Use ref from URL (default main)";choice.add(original);
          for(const ref of refs){const opt=document.createElement("option");opt.value=ref.name;opt.textContent=ref.kind+" · "+ref.name;choice.add(opt);}
          choice.dataset.forUrl=repository;
          choice.hidden=false;
        }
        if(status)status.textContent=refs.length+" branches/tags found. Choose a ref or use the ref from the URL.";
      }catch(e){if(status)status.textContent=String(e instanceof Error?e.message:e);}
      return;
    }
    if("knowledgeSync" in data || "knowledgeJson" in data){
      const status=root.querySelector<HTMLElement>("[data-knowledge-source-status]");
      const isJSON="knowledgeJson" in data;
      const url=value("knowledge-github-url");
      const selected=root.querySelector<HTMLSelectElement>("#knowledge-discovered-ref");
      const selectedRef=selected?.dataset.forUrl===url?selected.value:"";
      const json=value("knowledge-json-input");
      if(status)status.textContent=isJSON?"Validating JSON knowledge pack...":"Syncing GitHub knowledge pack...";
      try{
        const pack=isJSON?await importKnowledgeJSON(json):await syncKnowledge(url,selectedRef);
        state.knowledgePack=pack;
        const valid=new Set(pack.entries.map(e=>e.id));
        state.agentKnowledge=Object.fromEntries(Object.entries(state.agentKnowledge??{}).map(([agent,ids])=>[agent,ids.filter(id=>valid.has(id))]));
        persist();render();
        const output=root.querySelector<HTMLElement>("[data-knowledge-source-status]");
        if(output)output.textContent=pack.entries.length+" documents imported from "+pack.id+" v"+pack.version;
      }catch(e){if(status)status.textContent=String(e instanceof Error?e.message:e);}
      return;
    }
    if(data.knowledgeRead){
      const viewer=root.querySelector<HTMLElement>("[data-knowledge-reader]");
      const documentBody=viewer?.querySelector<HTMLElement>("[data-knowledge-document-body]");
      const documentTitle=viewer?.querySelector<HTMLElement>("[data-knowledge-document-title]");
      const pack=state.knowledgePack;
      const entry=pack?.entries.find(e=>e.id===data.knowledgeRead);
      if(!viewer||!documentBody||!documentTitle||!pack||!entry)return;
      viewer.hidden=false;documentTitle.textContent=entry.path;documentBody.textContent="Reading...";
      try{documentBody.textContent=await readKnowledgeEntry(pack,entry.id)}
      catch(e){documentBody.textContent=String(e instanceof Error?e.message:e)}
      return;
    }
    if(data.assignmentOpen){
      const picker=Array.from(root.querySelectorAll<HTMLDetailsElement>("[data-assignment-picker]")).find(p=>p.dataset.assignmentPicker===data.assignmentOpen);
      if(picker){picker.hidden=!picker.hidden;picker.open=!picker.hidden;}return;
    }
    if("assignmentDone" in data){
      if(page!=="Team"||!profiles(state).some(a=>a.id===detail))return;
      const picker=el.closest("details");if(!picker)return;
      const choices=Array.from(picker.querySelectorAll<HTMLInputElement>("[data-assignment-doc]"));
      const keys=new Set(choices.map(c=>c.dataset.assignmentDoc));
      state.agentKnowledge??={};
      const valid=new Set(state.knowledgePack?.entries.map(e=>e.id)??[]);
      state.agentKnowledge[detail]=[...new Set([...(state.agentKnowledge[detail]??[]).filter(k=>!keys.has(k)&&valid.has(k)),...choices.filter(c=>c.checked).map(c=>c.dataset.assignmentDoc!).filter(k=>valid.has(k))])];
      const scroll=root.querySelector<HTMLElement>(".team-properties")?.scrollTop??0;
      const selectedView=/^Knowledge (Graph|Timeline|Context) [0-6]$/.exec(tab)?.[1]||"Graph";
      tab="Knowledge "+selectedView+" 0";
      persist();render();
      const panel=root.querySelector<HTMLElement>(".team-properties");if(panel)panel.scrollTop=scroll;
      return;
    }
    if("issueRepairRepo" in data){const ic=issueChat(detail);if(!ic||ic.running)return;const issue=issues().find(x=>x.id===ic.issueId&&x.project===ic.project);const project=getProject(ic.project);const repos=state.repos.filter(r=>project?.repos.includes(r.id));const repo=issue?.repository?repos.find(r=>r.name===issue.repository):repos.length===1?repos[0]:undefined;if(!repo)return;void browseRepository().then(dir=>{if(!dir)return;repo.path=dir;persist();ic.dir=dir;ic.error="Repository path updated. Retry the request.";render()}).catch(e=>{ic.error=String(e);render()});return;}
    if("issueRetry" in data){const ic=issueChat(detail);const issue=issues().find(x=>x.id===ic?.issueId&&x.project===projectFilter);const last=ic?.messages.filter(m=>m.author==="You").slice(-1)[0];if(ic&&issue&&last&&!ic.running)launch(issue,ic.agent,last.body);return;}
    if(data.issueChat){page="Chat";detail=data.issueChat;render();return;}
    if("issueSend" in data){const ic=issueChat(detail),body=value("issue-chat-prompt");const issue=issues().find(x=>x.id===ic?.issueId&&x.project===projectFilter);if(ic&&issue&&body){const targets=explicitTargets(body);launch(issue,targets[0]||ic.agent,body);}return;}
    if("issueStop" in data){const ic=issueChat(detail);if(ic)void stopIssue(ic);return;}
    if("boardPrefix" in data){const p=getProject(projectFilter);if(p){const v=window.prompt("Issue prefix (new issues only)",projectPrefix(p.id,p.name));if(v!==null){try{setProjectPrefix(p.id,v);render()}catch(e){window.alert(String(e))}}}return;}
    if(data.boardView){page="Objectives";tab=data.boardView;detail="";render();return;}
    if("boardNew" in data){detail="new-issue:"+(statuses.find(s=>s===data.boardNew)||"Todo");render();return;}
    if(data.boardId){detail=data.boardId;render();return;}
    if("boardClose" in data){detail="";render();return;}
    if("boardComment" in data){const issue=issues().find(x=>x.id===detail&&x.project===projectFilter),body=value("issue-comment").trim();if(issue&&body){saveIssue({...issue,comments:[...(issue.comments||[]),{body,at:new Date().toISOString()}]});render();const targets=explicitTargets(body);if(targets.length&&body.replace(/@[\w-]+/g,"").trim()){page="Chat";detail="issue:"+issue.project+":"+issue.id;void (async()=>{for(const agent of new Set(targets))await executeIssue(issue,agent,body,state,updateIssue)})()}}return;}
    if("boardSave" in data){const title=value("issue-title"),status=statuses.find(s=>s===value("issue-status"));if(!title||!status||!getProject(projectFilter))return;const existing=issues().find(x=>x.id===detail&&x.project===projectFilter);try{saveIssue({id:existing?.id||crypto.randomUUID(),issueKey:existing?.issueKey||nextIssueKey(projectFilter,getProject(projectFilter)!.name),project:projectFilter,createdAt:existing?.createdAt||new Date().toISOString(),comments:existing?.comments||[],title,description:value("issue-description"),criteria:value("issue-criteria"),status,assignee:value("issue-assignee"),repository:value("issue-repo"),priority:priorities.find(p=>p===value("issue-priority"))||"No priority"});detail="";render()}catch(e){window.alert(String(e))}return;}
    if("groupStart" in data||"groupSend" in data){return;}
    if("groupStop" in data){void stopGroup();return;}
    if(data.switchProject){projectFilter=data.switchProject;detail="";tab="";render();return;}
    if("clearRepo" in data){consoles[detail==="Claude"?"Claude":"Codex"].dir="";render();return;}
    if("browseRepo" in data){const name=detail==="Claude"?"Claude":"Codex";void browseRepository().then(dir=>{if(dir){consoles[name].dir=dir;if(page==="Chat")render();}}).catch(e=>{consoles[name].error=String(e);render()});return;}
    if("currentRepo" in data){const name=detail==="Claude"?"Claude":"Codex";void currentRepository().then(dir=>{if(!dir){window.alert("No Git repository found in the app working directory. Enter the local path.");return;}consoles[name].dir=dir;if(page==="Chat")render();}).catch(e=>window.alert(String(e)));return;}
    if("reviewPrompt" in data){const c=consoles[detail==="Claude"?"Claude":"Codex"];if(!c.dir.trim()){window.alert("Select a real repository directory before reviewing code.");return;}c.prompt="Review this repository without modifying files. Inspect the current branch, architecture, correctness, security, maintainability and tests. Report prioritized findings with file references and distinguish verified evidence from assumptions.";render();return;}
    if(data.agentChat){if(!profiles(state).some(a=>a.id===data.agentChat))return;page="Chat";detail="agent:"+data.agentChat;tab="";render();return;}
    if("agentSend" in data){const id=detail.slice(6);void sendAgentChat(state,id,value("agent-chat-prompt"),()=>{if(page==="Chat"&&detail==="agent:"+id)render()});return;}
    if("agentStop" in data){void stopAgentChat(detail.slice(6));return;}
    if(data.chatHarness){page="Chat";tab="";detail=data.chatHarness;render();return;}
    if(data.harness){detail=detail===data.harness?"":data.harness;if(page==="Team"&&profiles(state).some(a=>a.id===data.harness)){tab="Knowledge Graph 0";}render();return;}
    if(data.runPrompt||data.stopPrompt||data.terminal){
      if(group.busy){window.alert("Finish the group conversation first.");return;}
      const name=(data.runPrompt||data.stopPrompt||data.terminal) as Agent;
      const c=consoles[name];c.dir=value("console-dir");if(!c.running)c.prompt=value("console-prompt");
      if(data.terminal&&!c.dir){window.alert("Choose a working directory first.");return;}
      const id=page==="Chat"&&tab.startsWith("Agent:")?tab.slice(6):"";
      const profile=id?(state.agentProfiles?.[id]??{role:id==="alex"?"Architect":id==="emma"?"Developer":"Reviewer",model:"Default",handle:id}):undefined;
      const pack=state.knowledgePack;
      if(data.runPrompt&&profile&&!pack){window.alert("Connect knowledge first");return;}
      const context=profile&&pack?{request:{agentId:id,root:pack.root,role:profile.role,languages:state.agentLanguages?.[id]??[],assigned:state.agentKnowledge?.[id]??[],task:c.prompt},model:profile.model,author:profile.handle}:undefined;
      const pending=data.runPrompt?runPrompt(name,undefined,context):data.stopPrompt?stopPrompt(name):openTerminal(name);
      render();void pending.then(result=>{if(context&&result&&"runId" in result)storeKnowledgeResult(id,result)}).catch(e=>{c.error=String(e)}).finally(()=>{if(page==="Chat"&&(detail||"Codex")===name&&!modal)render()});return;
    }
    if("rescan" in data || data.checkAgent){
      const pending=data.checkAgent ? scanAgent(data.checkAgent as Agent,value("agent-path-"+data.checkAgent)) : scanAgents();
      render(); void pending.then(()=>{if(page==="Team" && tab!=="Roles" && !modal)render();else if(page==="Overview"&&!modal)render();});return;
    }
    if(data.page){page=data.page==="Collaboration"?"Chat":data.page;detail=page==="Chat"?"agent:"+profiles(state)[0].id:"";tab="";}
    else if(data.objective){page="Objectives";detail=data.objective;tab="";}
    else if(data.project){page="Projects";detail=data.project;tab="";}
    else if(data.session){page="Sessions";detail=data.session;tab="";}
    else if("back" in data){detail="";tab="";}
    else if(data.tab){const view=/^Knowledge (Graph|Timeline|Context) [0-6]$/.exec(data.tab);if(view){const phase=/^Knowledge (Graph|Timeline|Context) ([0-6])$/.exec(tab)?.[2]||"0";tab="Knowledge "+view[1]+" "+phase;}else{tab=data.tab;detail="";}}
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
  root.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing&&event.target instanceof HTMLTextAreaElement&&["console-prompt","group-prompt","issue-chat-prompt","agent-chat-prompt"].includes(event.target.id)){event.preventDefault();root.querySelector<HTMLButtonElement>(event.target.id==="agent-chat-prompt"?"[data-agent-send]":event.target.id==="group-prompt"?"[data-group-send]":event.target.id==="issue-chat-prompt"?"[data-issue-send]":"[data-run-prompt]")?.click();}});
  root.addEventListener("input",(event)=>{if(event.target instanceof HTMLTextAreaElement&&event.target.id==="group-prompt"){group.draft=event.target.value;return;}if(page!=="Chat"||!(event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement))return;const c=consoles[detail==="Claude"?"Claude":"Codex"];if(c.running)return;if(event.target.id==="console-dir")c.dir=event.target.value;if(event.target.id==="console-prompt")c.prompt=event.target.value;});
  root.addEventListener("change",(event)=>{const field=event.target;if(page==="Objectives"&&(field instanceof HTMLInputElement||field instanceof HTMLTextAreaElement||field instanceof HTMLSelectElement)){const issue=issues().find(x=>x.id===detail&&x.project===projectFilter);const keys={"issue-title":"title","issue-description":"description","issue-criteria":"criteria","issue-status":"status","issue-assignee":"assignee","issue-repo":"repository","issue-priority":"priority"} as const;const key=keys[field.id as keyof typeof keys];if(issue&&key){const status=root.querySelector<HTMLElement>(".mc-save-status");try{if(key==="title"&&!field.value.trim())throw new Error("Title is required");if(key==="status"&&!statuses.some(s=>s===field.value))throw new Error("Invalid status");const next={...issue,[key]:field.value};saveIssue(next);if(key==="status"&&issue.status!=="In Progress"&&field.value==="In Progress")queueMicrotask(()=>startAssigned(next));if(status)status.textContent="";if(key==="title"){const heading=root.querySelector(".mc-detail-toolbar strong");if(heading)heading.textContent=field.value}}catch(e){if(status)status.textContent=String(e);field.value=issue[key]||""}return;}}

    const el=event.target as HTMLInputElement,data=el.dataset,objective=getObjective(detail);
    if(el instanceof HTMLInputElement&&el.dataset.agentLanguage!==undefined&&page==="Team"){
      const agent=profiles(state).find(a=>a.id===detail);
      const pack=state.knowledgePack;
      if(!agent||!pack)return;
      const lang=el.dataset.agentLanguage.toLowerCase();
      state.agentLanguages??={};
      const next=new Set(state.agentLanguages[detail]??[]);
      if(el.checked)next.add(lang);else next.delete(lang);
      state.agentLanguages[detail]=[...next];
      state.agentKnowledge??={};
      state.agentKnowledge[detail]=(state.agentKnowledge[detail]??[]).filter(id=>{
        const entry=pack.entries.find(e=>e.id===id);
        return entry&&knowledgeApplicable(entry,agent.role,state.agentLanguages![detail]);
      });
      const scroll=root.querySelector<HTMLElement>(".team-properties")?.scrollTop??0;
      persist();render();
      const panel=root.querySelector<HTMLElement>(".team-properties");if(panel)panel.scrollTop=scroll;
      return;
    }
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

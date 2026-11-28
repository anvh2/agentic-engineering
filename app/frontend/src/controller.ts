import {updateChatStream} from "./components/chat-view";
import {executeIssue,explicitTargets,issueChat,stopIssue} from "./services/issue-chat";
import { saveIssue,statuses,priorities,issues,boardContext,nextIssueKey,projectPrefix,setProjectPrefix } from "./services/work-board";
import { mountMentions } from "./components/mentions";
import { group,groupSend,stopGroup } from "./services/collaboration";
import { consoles, runPrompt, stopPrompt, openTerminal, currentRepository, browseRepository, subscribeChat } from "./services/harness-console";
import { scanAgent, scanAgents } from "./services/agent-connection";
import type { Agent } from "./types";
import type { ViewContext } from "./view-context";
import { demoStore } from "./services/demo-store";
import { renderLayout } from "./components/layout";
import { syncKnowledge,loadKnowledgeDirectory,readKnowledgeEntry,knowledgeForAgent } from "./services/knowledge-source";
export function mountController(root: HTMLElement, ctx: ViewContext) {
  mountMentions(root);
  const {state,nav,getObjective,getProject}=ctx;
  let {page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent}=nav;
  let knowledgeTimer: number | undefined;
  let knowledgeCompletedAt = 0;
  const stopKnowledgePlayback=()=>{if(knowledgeTimer!==undefined){window.clearInterval(knowledgeTimer);knowledgeTimer=undefined;knowledgeCompletedAt=0;}};
  const persist=()=>{try{demoStore.save(state)}catch{window.alert("Could not save demo data.");}};
  const render=()=>{Object.assign(nav,{page,projectFilter,detail,tab,modal,roleSelected,docSelected,discussion,usageAgent});renderLayout(root,ctx);docSelected=nav.docSelected;syncKnowledgePlayback();};
  const syncKnowledgePlayback=()=>{
    if(page!=="Team"||!["alex","emma","noah"].includes(detail)||tab==="Roles"||tab==="Harnesses"){stopKnowledgePlayback();return;}
    if(knowledgeTimer!==undefined)return;
    knowledgeTimer=window.setInterval(()=>{
      if(page!=="Team"||!["alex","emma","noah"].includes(detail)||tab==="Roles"||tab==="Harnesses"){stopKnowledgePlayback();return;}
      const match=/^Knowledge (Graph|Timeline|Context) ([0-6])$/.exec(tab);
      const view=match?.[1]||"Graph",phase=Number(match?.[2]||0);
      const preview=root.querySelector<HTMLElement>("[data-knowledge-preview]");
      if(!preview){stopKnowledgePlayback();return;}
      if(phase===6){
        if(!knowledgeCompletedAt){
          preview.querySelectorAll(".knowledge-flow-active,.knowledge-node-active").forEach(el=>{
            el.classList.remove("knowledge-flow-active","knowledge-node-active");
            if(el.hasAttribute("data-knowledge-edge"))el.setAttribute("stroke-dasharray","none");
          });
          const status=preview.querySelector("[data-knowledge-phase]");
          if(status)status.textContent="Completed";
          knowledgeCompletedAt=Date.now();
        }
        if(Date.now()-knowledgeCompletedAt<8000)return;
      }
      const next=(phase+1)%7;
      knowledgeCompletedAt=0;
      const entries=JSON.parse(preview.dataset.knowledgeEntries||"[]") as Array<{phase:number;tokens:number;kind:string}>;
      const loaded=entries.filter(e=>e.phase<=next),total=loaded.reduce((sum,e)=>sum+e.tokens,0);
      tab="Knowledge "+view+" "+next;nav.tab=tab;
      const setText=(selector:string,value:string)=>{const el=preview.querySelector(selector);if(el)el.textContent=value;};
      setText("[data-knowledge-phase]",["Waiting","Bootstrap","Repository discovery","Planning","Implementation","Debugging","Verification"][next]);
      setText("[data-knowledge-count]",loaded.length+" / "+entries.length);
      setText("[data-knowledge-total]",total.toLocaleString());
      setText("[data-knowledge-total-svg]",total.toLocaleString()+" est. tokens");
      preview.querySelectorAll("[data-knowledge-edge],[data-knowledge-node]").forEach(el=>{
        const edge=el.hasAttribute("data-knowledge-edge");
        const p=Number(el.getAttribute(edge?"data-knowledge-edge":"data-knowledge-node"));
        el.setAttribute("stroke",p<=next?"#79a98e":"var(--edge)");
        if(!edge)el.setAttribute("fill",p<=next?"#25332d":"var(--raised)");
        if(edge)el.setAttribute("stroke-dasharray",p<=next?"none":"4 4");
        el.classList.toggle(edge?"knowledge-flow-active":"knowledge-node-active",p===next);
      });
      preview.querySelectorAll("[data-knowledge-label],[data-knowledge-status]").forEach(el=>{
        const label=el.hasAttribute("data-knowledge-label");
        const p=Number(el.getAttribute(label?"data-knowledge-label":"data-knowledge-status"));
        el.textContent=p<=next?(label?"Loaded · "+el.getAttribute("data-tokens")+" tokens":"Loaded"):p===99?(next===6?"Skipped · Not relevant":"Not selected"):"Available";
      });
      for(const kind of ["DNA","Role","Standard","Skill","Reference"]){
        const n=loaded.filter(e=>e.kind===kind).reduce((sum,e)=>sum+e.tokens,0);
        setText('[data-knowledge-category="'+kind+'"]',n.toLocaleString()+" tokens");
        const bar=preview.querySelector<HTMLElement>('[data-knowledge-bar="'+kind+'"]');
        if(bar)bar.style.width=(total?100*n/total:0)+"%";
      }
    },1500);
  };
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
    if(data.profileSave){
      const id=data.profileSave,handle=value("profile-handle").trim().replace(/^@/,"").toLowerCase();
      const status=root.querySelector<HTMLElement>("[data-profile-status]");
      const duplicate=["alex","emma","noah"].some(other=>other!==id&&(state.agentProfiles?.[other]?.handle??other)===handle);
      if(!/^[a-z][a-z0-9_-]{0,39}$/.test(handle)||duplicate){if(status)status.textContent="Invalid or duplicate handle";return;}
      const harness=value("profile-harness");if(harness!=="Claude"&&harness!=="Codex")return;
      state.agentProfiles??={};
      state.agentProfiles[id]={handle,role:value("profile-role"),harness,model:value("profile-model").trim()||"Default"};
      persist();render();return;
    }
    if(data.profileTest){
      const id=data.profileTest;
      const output=root.querySelector<HTMLElement>("[data-profile-test-result]");
      if(!output)return;
      const profile=state.agentProfiles?.[id]??{role:id==="alex"?"Architect":id==="emma"?"Developer":"Reviewer",harness:id==="emma"?"Codex":"Claude",model:"Default"};
      const pack=state.knowledgePack;
      const prompt=value("profile-test-prompt").trim();
      if(!pack||!prompt){output.textContent="Connect knowledge and enter a test message first.";return;}
      const entries=knowledgeForAgent(pack,profile.role,state.agentKnowledge?.[id]??[]);
      const bridge=(window as unknown as {go?:{main?:{HarnessConsole?:{RunAgentContextTest(name:string,path:string,model:string,root:string,ids:string[],prompt:string):Promise<{output:string;error:string}>}}}}).go?.main?.HarnessConsole;
      if(!bridge){output.textContent="Open the native desktop app.";return;}
      const button=root.querySelector<HTMLButtonElement>("[data-profile-test]");if(button)button.disabled=true;
      output.textContent="Reading selected files and running native harness...";
      try{const result=await bridge.RunAgentContextTest(profile.harness,localStorage.getItem("agent-path:"+profile.harness)||"",profile.model,pack.root,entries.map(e=>e.id),prompt);output.textContent=(result.error?"Error: "+result.error:"Native run completed. Context sent:\n"+entries.map(e=>e.id).join("\n"))+"\n\n"+result.output;}
      catch(e){output.textContent=String(e)}finally{if(button)button.disabled=false}
      return;
    }
    if("knowledgeSync" in data || "knowledgeLocal" in data){
      const status=root.querySelector<HTMLElement>("[data-knowledge-source-status]");
      if(status)status.textContent="Reading knowledge source...";
      const ref=value("knowledge-github-ref")||"main";
      const directory=value("knowledge-local-path");
      try{
        const pack="knowledgeSync" in data?await syncKnowledge(ref):await loadKnowledgeDirectory(directory);
        state.knowledgePack=pack;
        const valid=new Set(pack.entries.map(e=>e.id));
        state.agentKnowledge=Object.fromEntries(Object.entries(state.agentKnowledge??{}).map(([agent,ids])=>[agent,ids.filter(id=>valid.has(id))]));
        persist();render();
        const output=root.querySelector<HTMLElement>("[data-knowledge-source-status]");
        if(output)output.textContent=pack.entries.length+" documents linked from "+pack.id+" v"+pack.version;
      }catch(e){
        if(status)status.textContent=String(e instanceof Error?e.message:e);
      }
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
      if(page!=="Team"||!["alex","emma","noah"].includes(detail))return;
      const picker=el.closest("details");if(!picker)return;
      const choices=Array.from(picker.querySelectorAll<HTMLInputElement>("[data-assignment-doc]"));
      const keys=new Set(choices.map(c=>c.dataset.assignmentDoc));
      state.agentKnowledge??={};
      const valid=new Set(state.knowledgePack?.entries.map(e=>e.id)??[]);
      state.agentKnowledge[detail]=[...new Set([...(state.agentKnowledge[detail]??[]).filter(k=>!keys.has(k)&&valid.has(k)),...choices.filter(c=>c.checked).map(c=>c.dataset.assignmentDoc!).filter(k=>valid.has(k))])];
      const scroll=root.querySelector<HTMLElement>(".team-properties")?.scrollTop??0;
      const selectedView=/^Knowledge (Graph|Timeline|Context) [0-6]$/.exec(tab)?.[1]||"Graph";
      tab="Knowledge "+selectedView+" 0";
      stopKnowledgePlayback();persist();render();
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
    if("groupStart" in data||"groupSend" in data){void groupSend("groupStart" in data?"Hello Claude and Codex! Please introduce yourselves and greet each other.":value("group-prompt"),()=>{if(page==="Collaboration")render()},boardContext(projectFilter));return;}
    if("groupStop" in data){void stopGroup();return;}
    if(data.switchProject){projectFilter=data.switchProject;detail="";tab="";render();return;}
    if("clearRepo" in data){consoles[detail==="Claude"?"Claude":"Codex"].dir="";render();return;}
    if("browseRepo" in data){const name=detail==="Claude"?"Claude":"Codex";void browseRepository().then(dir=>{if(dir){consoles[name].dir=dir;if(page==="Chat")render();}}).catch(e=>{consoles[name].error=String(e);render()});return;}
    if("currentRepo" in data){const name=detail==="Claude"?"Claude":"Codex";void currentRepository().then(dir=>{if(!dir){window.alert("No Git repository found in the app working directory. Enter the local path.");return;}consoles[name].dir=dir;if(page==="Chat")render();}).catch(e=>window.alert(String(e)));return;}
    if("reviewPrompt" in data){const c=consoles[detail==="Claude"?"Claude":"Codex"];if(!c.dir.trim()){window.alert("Select a real repository directory before reviewing code.");return;}c.prompt="Review this repository without modifying files. Inspect the current branch, architecture, correctness, security, maintainability and tests. Report prioritized findings with file references and distinguish verified evidence from assumptions.";render();return;}
    if(data.chatHarness){page="Chat";detail=data.chatHarness;render();return;}
    if(data.harness){detail=detail===data.harness?"":data.harness;if(page==="Team"&&["alex","emma","noah"].includes(data.harness)){tab="Knowledge Graph 0";stopKnowledgePlayback();}render();return;}
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
  root.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing&&event.target instanceof HTMLTextAreaElement&&["console-prompt","group-prompt","issue-chat-prompt"].includes(event.target.id)){event.preventDefault();root.querySelector<HTMLButtonElement>(event.target.id==="group-prompt"?"[data-group-send]":event.target.id==="issue-chat-prompt"?"[data-issue-send]":"[data-run-prompt]")?.click();}});
  root.addEventListener("input",(event)=>{if(event.target instanceof HTMLTextAreaElement&&event.target.id==="group-prompt"){group.draft=event.target.value;return;}if(page!=="Chat"||!(event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement))return;const c=consoles[detail==="Claude"?"Claude":"Codex"];if(c.running)return;if(event.target.id==="console-dir")c.dir=event.target.value;if(event.target.id==="console-prompt")c.prompt=event.target.value;});
  root.addEventListener("change",(event)=>{const field=event.target;if(page==="Objectives"&&(field instanceof HTMLInputElement||field instanceof HTMLTextAreaElement||field instanceof HTMLSelectElement)){const issue=issues().find(x=>x.id===detail&&x.project===projectFilter);const keys={"issue-title":"title","issue-description":"description","issue-criteria":"criteria","issue-status":"status","issue-assignee":"assignee","issue-repo":"repository","issue-priority":"priority"} as const;const key=keys[field.id as keyof typeof keys];if(issue&&key){const status=root.querySelector<HTMLElement>(".mc-save-status");try{if(key==="title"&&!field.value.trim())throw new Error("Title is required");if(key==="status"&&!statuses.some(s=>s===field.value))throw new Error("Invalid status");const next={...issue,[key]:field.value};saveIssue(next);if(key==="status"&&issue.status!=="In Progress"&&field.value==="In Progress")queueMicrotask(()=>startAssigned(next));if(status)status.textContent="";if(key==="title"){const heading=root.querySelector(".mc-detail-toolbar strong");if(heading)heading.textContent=field.value}}catch(e){if(status)status.textContent=String(e);field.value=issue[key]||""}return;}}

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

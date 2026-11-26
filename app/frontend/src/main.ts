function desktopUI() {
  const $ = (selector) => document.querySelector(selector);
  const root = $("#root");
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const starter = {
    projects:[{id:"p1",name:"Agentic Engineering",description:"Personal AI engineering environment",repos:["r1","r4"],knowledge:{}},{id:"p2",name:"Nexora OS",description:"AI-native operating system",repos:["r2","r4"],knowledge:{}},{id:"p3",name:"CloudFarm",description:"Software-first farm and compute platform",repos:["r3"],knowledge:{}}],
    repos:[{id:"r1",name:"agentic-engineering",path:"~/dev/agentic-engineering"},{id:"r2",name:"nexora-os",path:"~/dev/nexora-os"},{id:"r3",name:"cloudfarm",path:"~/dev/cloudfarm"},{id:"r4",name:"shared-go-kit",path:"~/dev/shared-go-kit"}],
    roles:{Developer:"# Developer\n\nUnderstand requirements before implementation.\nPrefer simple, idiomatic, maintainable code.\nVerify correctness, regressions and acceptance criteria.\nPreserve native agent tools, skills and permissions.",Reviewer:"# Reviewer\n\nPrioritize correctness, security, maintainability and actionable findings.\nDistinguish defects from preferences.",Architect:"# Architect\n\nEvaluate constraints, alternatives, trade-offs and evidence.\nPrefer the simplest viable architecture.",Researcher:"# Researcher\n\nPrefer primary sources. Separate verified facts from assumptions."},
    knowledge:{"Engineering principles":"# Engineering Principles\n\nSimplicity first. Evidence over assumptions. Preserve native harnesses.","Working methodology":"# Working Methodology\n\nDiscover → design → implement → verify.","Feedback & lessons":"# Feedback & Lessons\n\nHuman-approved calibration only."},
    objectives:[{id:"AE-001",project:"p1",title:"Collaboration foundation",description:"Prove Claude and Codex can exchange messages through embedded MCP.",criteria:"Both native agents collaborate on a verified objective.",status:"In progress",repos:["r1"],assignments:{Claude:"Developer",Codex:"Developer"},tasks:[{text:"Define collaboration contract",done:true},{text:"Implement embedded MCP",done:false},{text:"Verify native agent integration",done:false}]},{id:"AE-002",project:"p1",title:"Usage tracking",description:"Capture native usage and estimated costs.",criteria:"Attribute usage to sessions and objectives.",status:"Planned",repos:["r1"],assignments:{Claude:"Developer",Codex:"Reviewer"},tasks:[]}],
    sessions:[{id:"S-001",objective:"AE-001",agent:"Claude",role:"Developer",task:"Define collaboration contract",status:"Completed",tokens:672000,cost:1.84,context:"Developer knowledge loaded (illustrative)"},{id:"S-002",objective:"AE-001",agent:"Codex",role:"Developer",task:"Design collaboration contract",status:"Completed",tokens:409000,cost:1.26,context:"Developer knowledge loaded (illustrative)"}],
    messages:[{objective:"AE-001",agent:"Claude",body:"Propose embedded MCP and SQLite persistence."},{objective:"AE-001",agent:"Codex",body:"Agreed. Keep the Go core in-process."}],
    decisions:[{id:"ADR-001",objective:"AE-001",name:"Embedded MCP",reason:"Extend native Claude and Codex without replacing their harnesses.",status:"Proposed"},{id:"ADR-002",objective:"AE-001",name:"Local-first Go application",reason:"Single process, SQLite, no external broker.",status:"Accepted"}],
    settings:{budget:10,approval:true}
  };
  let state;
  try { state = JSON.parse(localStorage.getItem("agentic-v2-app-demo")) || starter; } catch { state = starter; }
  let page="Overview", projectFilter="all", detail="", tab="", modal="", roleSelected="Developer", docSelected="Engineering principles", discussion="AE-001", usageAgent="All";
  const pages=["Overview","Projects","Objectives","Collaboration","Sessions","Decisions","Engineering DNA","Team","Usage & Cost","Settings"];
  const icons=["▦","▱","◎","▤","⌘","▧","◇","♧","▥","⚙"];
  const persist=()=>{try{localStorage.setItem("agentic-v2-app-demo",JSON.stringify(state))}catch {}};
  const getObjective=(id)=>state.objectives.find((o)=>o.id===id);
  const getProject=(id)=>state.projects.find((p)=>p.id===id);
  const visibleObjectives=()=>state.objectives.filter((o)=>projectFilter==="all"||o.project===projectFilter);
  const visibleSessions=()=>state.sessions.filter((s)=>visibleObjectives().some((o)=>o.id===s.objective));
  const cash=(n)=>"$"+Number(n||0).toFixed(2);
  const sum=(records,key)=>records.reduce((n,r)=>n+Number(r[key]||0),0);
  const pill=(name)=>`<span class="pill">${escapeHTML(name)}</span>`;
  const action=(text,attr,primary=false)=>`<button class="${primary?"primary":""}" ${attr}>${escapeHTML(text)}</button>`;
  const heading=(title,subtitle,actions="")=>`<div class="heading"><div><h1>${escapeHTML(title)}</h1><small>${escapeHTML(subtitle)}</small></div><div class="heading-actions">${actions}</div></div>`;
  const panel=(title,body)=>`<section class="panel"><h2>${escapeHTML(title)}</h2>${body}</section>`;
  const line=(left,right="")=>`<div class="line between"><span>${left}</span><span>${right}</span></div>`;
  const tabs=(list)=>`<div class="tabs">${list.map((t)=>`<button data-tab="${escapeHTML(t)}" class="${(tab||list[0])===t?"active":""}">${escapeHTML(t)}</button>`).join("")}</div>`;
  const projectOptions=(value,all=false)=>(all?'<option value="all">All projects</option>':"")+state.projects.map((p)=>`<option value="${escapeHTML(p.id)}" ${p.id===value?"selected":""}>${escapeHTML(p.name)}</option>`).join("");
  const roleOptions=(value)=>["Not assigned",...Object.keys(state.roles)].map((r)=>`<option ${r===value?"selected":""}>${escapeHTML(r)}</option>`).join("");
  const options=(values,current)=>values.map((v)=>`<option ${v===current?"selected":""}>${escapeHTML(v)}</option>`).join("");
  const table=(records)=>`<div class="overflow"><table><thead><tr><th>Session</th><th>Agent / Role</th><th>Tokens</th><th>Cost</th><th>Status</th></tr></thead><tbody>${records.map((s)=>`<tr data-session="${escapeHTML(s.id)}"><td>${escapeHTML(s.task)}<small>${escapeHTML(s.id)}</small></td><td>${escapeHTML(s.agent)}<small>${escapeHTML(s.role)}</small></td><td>${Number(s.tokens).toLocaleString()}</td><td>${cash(s.cost)}</td><td>${pill(s.status)}</td></tr>`).join("")}</tbody></table></div>`;
  const objectiveList=(list)=>list.length?list.map((o)=>`<div class="objective line" data-objective="${escapeHTML(o.id)}"><div class="between"><span><small class="mono">${escapeHTML(o.id)}</small> &nbsp; ${escapeHTML(o.title)}</span>${pill(o.status)}</div><small>${o.tasks.length} tasks · ${state.sessions.filter((s)=>s.objective===o.id).length} sessions</small><div class="progress"><i style="width:${o.tasks.length?100*o.tasks.filter((t)=>t.done).length/o.tasks.length:0}%"></i></div></div>`).join(""):'<p class="muted">No objectives yet.</p>';
  const repos=(ids,allowUnlink=false)=>ids.length?ids.map((id)=>{const r=state.repos.find((r)=>r.id===id);if(!r)return "";return line(`<div><b>${escapeHTML(r.name)}</b><small>${escapeHTML(r.path)}</small></div>`,`${state.projects.filter((p)=>p.repos.includes(id)).length>1?pill("Shared"):""} ${allowUnlink?action("Unlink",`data-unlink="${escapeHTML(id)}"`):""}`)}).join(""):'<p class="muted">No repositories linked.</p>';
  const conversation=(id)=>panel("Discussion",state.messages.filter((m)=>m.objective===id).map((m)=>`<div class="message line"><span class="avatar ${m.agent==="Codex"?"codex":""}">${escapeHTML(m.agent[0])}</span><div><b>${escapeHTML(m.agent)}</b><p>${escapeHTML(m.body)}</p></div></div>`).join("")+`<textarea id="message" placeholder="Add feedback to this objective…"></textarea><div class="right">${action("Send message",`data-send="${escapeHTML(id)}"`,true)}</div><p class="note">Demo timeline only. No agent process is running.</p>`);
  const decisionList=(id?: string)=>state.decisions.filter((d)=>id?d.objective===id:visibleObjectives().some((o)=>o.id===d.objective)).map((d)=>panel(d.name,line(`<small>${escapeHTML(d.id)}</small>`,pill(d.status))+`<p>${escapeHTML(d.reason)}</p>`+(d.status==="Proposed"?`${action("Accept",`data-decision="${d.id}" data-result="Accepted"`)} ${action("Reject",`data-decision="${d.id}" data-result="Rejected"`)}`:""))).join("");
  const projectKnowledge=(p)=>({"Governance":"Human owns direction and knowledge.","Requirements":"Flexible roles, shared repositories, native harness preservation.","Architecture":"Go application, embedded MCP, SQLite.",...p.knowledge});
  const editor=(documents,kind)=>{if(!(docSelected in documents))docSelected=Object.keys(documents)[0];return panel("Knowledge",`<div class="chips">${Object.keys(documents).map((name)=>action(name,`data-doc="${escapeHTML(name)}"`)).join("")}</div><h3>${escapeHTML(docSelected)}</h3><textarea id="knowledge-editor" class="editor">${escapeHTML(documents[docSelected])}</textarea><div class="right">${action("Save knowledge",`data-save-knowledge="${escapeHTML(kind)}"`,true)}</div>`)};
  function view() {
    const objectives=visibleObjectives(),sessions=visibleSessions();
    const selectedObjective=getObjective(detail),selectedProject=getProject(detail),selectedSession=state.sessions.find((s)=>s.id===detail);
    switch(page){
    case "Overview":return heading("Overview",projectFilter==="all"?"Your personal engineering workspace":getProject(projectFilter)?.name,action("+ New objective",'data-open="objective"',true))+`<div class="metrics">${[["Objectives",objectives.length],["Sessions",sessions.length],["Total tokens",(sum(sessions,"tokens")/1e6).toFixed(2)+"M"],["Estimated cost",cash(sum(sessions,"cost"))]].map(([n,v])=>`<div class="metric"><small>${n}</small><strong>${v}</strong></div>`).join("")}</div><div class="columns">${panel("Agents",["Claude","Codex"].map((a)=>line(`<span class="avatar ${a==="Codex"?"codex":""}">${a[0]}</span> <b>${a}</b>`,pill("Not connected"))).join(""))}${panel("Cost by objective",objectives.map((o)=>line(escapeHTML(o.title),cash(sum(sessions.filter((s)=>s.objective===o.id),"cost")))).join(""))}</div>${panel("Objectives",objectiveList(objectives))}${panel("Recent sessions",table(sessions.slice(0,5)))}`;
    case "Projects":return selectedProject?heading(selectedProject.name,selectedProject.description,action("All projects","data-back"))+tabs(["Overview","Repositories","Knowledge"])+(tab==="Knowledge"?editor(projectKnowledge(selectedProject),selectedProject.id):panel("Repositories",repos(selectedProject.repos,tab==="Repositories")+(tab==="Repositories"?action("+ Link repository",'data-open="repo"'):""))+panel("Objectives",objectiveList(state.objectives.filter((o)=>o.project===selectedProject.id)))):heading("Projects","Project context and shared repositories",action("+ New project",'data-open="project"',true))+state.projects.map((p)=>`<section class="panel clickable" data-project="${escapeHTML(p.id)}"><h2>${escapeHTML(p.name)}</h2><small>${escapeHTML(p.description)}</small><p>${p.repos.map((id)=>escapeHTML(state.repos.find((r)=>r.id===id)?.name)).join(" · ")}</p></section>`).join("");
    case "Objectives":return selectedObjective?heading(selectedObjective.title,selectedObjective.id,action("All objectives","data-back"))+tabs(["Overview","Tasks","Collaboration","Sessions","Decisions"])+(tab==="Tasks"?panel("Tasks",selectedObjective.tasks.map((t,i)=>`<label class="line"><input type="checkbox" data-task="${i}" ${t.done?"checked":""}> ${escapeHTML(t.text)}</label>`).join("")+action("+ Add task",'data-open="task"')):tab==="Collaboration"?conversation(selectedObjective.id):tab==="Sessions"?panel("Sessions",table(state.sessions.filter((s)=>s.objective===selectedObjective.id))):tab==="Decisions"?decisionList(selectedObjective.id):panel("Objective",`${pill(selectedObjective.status)}<p>${escapeHTML(selectedObjective.description)}</p><h3>Acceptance criteria</h3><p>${escapeHTML(selectedObjective.criteria)}</p>`)+panel("Agent assignments",["Claude","Codex"].map((a)=>line(`<b>${a}</b>`,`<select data-agent="${a}">${roleOptions(selectedObjective.assignments[a])}</select>`)).join("")+"<p class='note'>Role knowledge loads before agent execution. Native harnesses are preserved.</p>")+panel("Repository scope",repos(selectedObjective.repos))+action("Simulate session start","data-simulate",true)):heading("Objectives","Engineering outcomes and responsibilities",action("+ New objective",'data-open="objective"',true))+panel("Objectives",objectiveList(objectives));
    case "Collaboration":return heading("Collaboration","Agent conversations and human feedback",`<select id="discussion-select">${objectives.map((o)=>`<option value="${o.id}" ${o.id===discussion?"selected":""}>${escapeHTML(o.title)}</option>`).join("")}</select>`)+(objectives.length?conversation(objectives.find((o)=>o.id===discussion)?.id||objectives[0].id):panel("Discussion","No objective selected."));
    case "Sessions":return selectedSession?heading(selectedSession.id+" · "+selectedSession.agent,selectedSession.task,action("All sessions","data-back"))+tabs(["Timeline","Context","Usage"])+(tab==="Context"?panel("Knowledge bootstrap",line("Global Engineering DNA",pill("Demo"))+line(selectedSession.role+" role",pill("Demo"))+line("Project / Task context",pill("Demo"))+`<pre>${escapeHTML(selectedSession.context||state.roles[selectedSession.role]||"Unavailable")}</pre>`):tab==="Usage"?panel("Usage",line("Tokens",Number(selectedSession.tokens).toLocaleString())+line("API-equivalent cost",cash(selectedSession.cost))+line("Actual billing","Unavailable")):panel("Session timeline",line("Status",pill(selectedSession.status))+line("Role",escapeHTML(selectedSession.role))+line("Runtime","Not connected"))):heading("Sessions","Native session history (illustrative)")+panel("Sessions",table(sessions));
    case "Decisions":return heading("Decisions","Technical trade-offs and audit trail")+decisionList();
    case "Engineering DNA":return heading("Engineering DNA","Human-owned knowledge and skills")+tabs(["Knowledge","Skills"])+(tab==="Skills"?panel("Skills",["Go engineering","Debugging","Testing","Security","System design"].map((s)=>line(escapeHTML(s),pill("On demand"))).join("")):editor(state.knowledge,"global"));
    case "Team":return heading("Team","Native agents and reusable role knowledge")+tabs(["Agents","Roles"])+(tab==="Roles"?`<div class="between space"><select id="role-select">${options(Object.keys(state.roles),roleSelected)}</select>${action("+ New role",'data-open="role"')}</div>`+panel("Base knowledge",`<p class="muted">Loaded when the role is assigned to a session.</p><textarea id="role-knowledge" class="editor">${escapeHTML(state.roles[roleSelected])}</textarea><div class="right">${action("Save role","data-save-role",true)}</div>`):["Claude","Codex"].map((a)=>panel(a,line("Runtime",a==="Claude"?"Claude Code":"Codex CLI")+line("Native tools, skills and permissions",pill("Preserved by design"))+line("MCP collaboration",pill("Not connected")))).join(""));
    case "Usage & Cost":{const selected=sessions.filter((s)=>usageAgent==="All"||s.agent===usageAgent);return heading("Usage & Cost","Illustrative API-equivalent estimates",`<select id="agent-filter">${options(["All","Claude","Codex"],usageAgent)}</select>`)+`<div class="metrics"><div class="metric"><small>Tokens</small><strong>${sum(selected,"tokens").toLocaleString()}</strong></div><div class="metric"><small>Estimated cost</small><strong>${cash(sum(selected,"cost"))}</strong></div></div>`+panel("By objective",objectives.map((o)=>line(escapeHTML(o.title),cash(sum(selected.filter((s)=>s.objective===o.id),"cost")))).join(""))+panel("Sessions",table(selected))+`<p class="note">Actual subscription billing is unavailable. Shared repositories do not duplicate cost.</p>`}
    default:return heading("Settings","Local-first desktop preferences")+panel("Architecture",line("Backend","Go + Wails")+line("Data","UI demo in localStorage")+line("Embedded MCP","Planned; not connected")+line("Claude / Codex CLI","Not connected"))+panel("Budget",`<label>Estimated budget per objective (USD)</label><input type="number" min="0" id="budget" value="${state.settings.budget}">${action("Save","data-save-budget",true)}`);
    }
  }
  function dialog() {
    let body="";
    if(modal==="objective") body=`<label>Project</label><select id="new-project">${projectOptions(projectFilter==="all"?state.projects[0].id:projectFilter)}</select><label>Name</label><input id="new-name"><label>Description</label><textarea id="new-description"></textarea><label>Acceptance criteria</label><textarea id="new-criteria"></textarea>${["Claude","Codex"].map((a)=>`<label>${a} role</label><select id="new-${a}">${roleOptions("Developer")}</select>`).join("")}`;
    else if(modal==="project")body='<label>Name</label><input id="new-name"><label>Description</label><textarea id="new-description"></textarea>';
    else if(modal==="repo")body=`<label>Existing repository</label><select id="new-repo"><option value="">Add local repository path</option>${state.repos.map((r)=>`<option value="${r.id}">${escapeHTML(r.name)}</option>`).join("")}</select><label>Local path</label><input id="new-name">`;
    else body='<label>Name</label><input id="new-name">'+(modal==="role"?'<label>Base knowledge</label><textarea id="new-description"></textarea>':"");
    return `<div class="overlay"><div class="dialog"><h2>${escapeHTML("New "+modal)}</h2>${body}<div class="right space">${action("Cancel","data-cancel")}${action("Save","data-create",true)}</div></div></div>`;
  }
  function render() {
    root.innerHTML=`<div class="windowbar"><div class="traffic"><i></i><i></i><i></i></div><span>Agentic Engineering — Workspace</span></div><div class="layout"><aside><div class="brand"><span class="logo">ae</span><b>Agentic<br>Engineering</b></div><select id="project-filter">${projectOptions(projectFilter,true)}</select>${pages.map((name,index)=>`${index===0||index===6?`<div class="nav-title">${index===0?"WORKSPACE":"ENGINEERING"}</div>`:""}<button class="nav ${name===page?"active":""}" data-page="${escapeHTML(name)}"><span class="nav-icon">${icons[index]}</span>${escapeHTML(name)}</button>`).join("")}<div class="sidebar-foot">RUNTIMES · NOT CONNECTED<br>Claude Code · Codex</div></aside><main>${view()}<footer>Agentic Engineering v2 · UI demo · No agent processes started</footer></main></div>${modal?dialog():""}`;
  }
  const value=(id)=>$("#"+id)?.value?.trim()||"";
  root.addEventListener("click",(event)=>{
    const el=event.target.closest("button,[data-objective],[data-project],[data-session]");
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
      const name=value("new-name"),id=String(Date.now());
      if(modal!=="repo"&&!name)return;
      if(modal==="project"){state.projects.push({id,name,description:value("new-description"),repos:[],knowledge:{}});page="Projects";detail=id;}
      else if(modal==="objective"){const pid=value("new-project");const key="OBJ-"+id;state.objectives.push({id:key,project:pid,title:name,description:value("new-description"),criteria:value("new-criteria"),status:"Planned",repos:[...(getProject(pid)?.repos||[])],assignments:{Claude:value("new-Claude"),Codex:value("new-Codex")},tasks:[]});page="Objectives";projectFilter=pid;detail=key;}
      else if(modal==="repo"&&project){let repoID=value("new-repo");if(!repoID&&name){let repo=state.repos.find((r)=>r.path===name);if(!repo){repo={id,name:name.split("/").filter(Boolean).pop()||name,path:name};state.repos.push(repo)}repoID=repo.id;}if(repoID&&!project.repos.includes(repoID))project.repos.push(repoID);}
      else if(modal==="task"&&objective)objective.tasks.push({text:name,done:false});
      else if(modal==="role"){if(state.roles[name])return;state.roles[name]=value("new-description");roleSelected=name;}
      modal="";
    }
    else if(data.unlink&&project)project.repos=project.repos.filter((id)=>id!==data.unlink);
    else if(data.send){const message=value("message");if(!message)return;state.messages.push({objective:data.send,agent:"You",body:message});}
    else if(data.decision){const d=state.decisions.find((d)=>d.id===data.decision);if(d)d.status=data.result;}
    else if(data.doc)docSelected=data.doc;
    else if(data.saveKnowledge){const target=data.saveKnowledge==="global"?state.knowledge:getProject(data.saveKnowledge)?.knowledge;if(target)target[docSelected]=value("knowledge-editor");}
    else if("saveRole" in data)state.roles[roleSelected]=value("role-knowledge");
    else if("simulate" in data && objective){if(state.sessions.some((s)=>s.objective===objective.id&&s.status==="Running"))return;for(const [agent,role] of Object.entries(objective.assignments as Record<string, string>)){if(role==="Not assigned")continue;state.sessions.push({id:"S-"+Date.now()+"-"+agent,objective:objective.id,agent,role,task:objective.title,status:"Running",tokens:0,cost:0,context:state.roles[role]||""});}objective.status="In progress";}
    else if("saveBudget" in data)state.settings.budget=Math.max(0,Number(value("budget"))||0);
    else return;
    persist();render();
  });
  root.addEventListener("change",(event)=>{
    const el=event.target,data=el.dataset,objective=getObjective(detail);
    if(el.id==="project-filter"){projectFilter=el.value;detail="";tab="";}
    else if(el.id==="discussion-select")discussion=el.value;
    else if(el.id==="role-select")roleSelected=el.value;
    else if(el.id==="agent-filter")usageAgent=el.value;
    else if(data.agent&&objective)objective.assignments[data.agent]=el.value;
    else if(data.task!==undefined&&objective)objective.tasks[Number(data.task)].done=el.checked;
    else return;
    persist();render();
  });
  render();
}
desktopUI();

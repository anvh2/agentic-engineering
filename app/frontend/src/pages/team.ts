import { profiles } from "../services/agent-chat";
import type { ViewContext } from "../view-context";
import { escapeHTML, pill, action, heading, panel, line } from "../components/primitives";
import { agentNames, agentStatus, configuredPath } from "../services/agent-connection";
import { knowledgeForAgent, knowledgeDisplayName, knowledgeRoleName, knowledgeApplicable } from "../services/knowledge-source";
import {knowledgeRuns} from "../services/knowledge-trace";
function renderHarnesses(ctx:ViewContext):string {
 const {state,nav,tabs,options}=ctx;
 if(nav.tab==="Roles")return heading("Team","Native harnesses and reusable role knowledge")+tabs(["Agents","Roles","Harnesses"])+`<div class="between space"><select id="role-select">${options(Object.keys(state.roles),nav.roleSelected)}</select>${action("+ New role",'data-open="role"')}</div>`+panel("Base knowledge",`<textarea id="role-knowledge" class="editor">${escapeHTML(state.roles[nav.roleSelected])}</textarea><div class="right">${action("Save role","data-save-role",true)}</div>`);
 return heading("Team","Native execution environments",action("Rescan all","data-rescan"))+tabs(["Agents","Roles","Harnesses"])+agentNames.map(name=>{
 const s=agentStatus(name), expanded=nav.detail===name;
 return `<section class="panel harness-panel"><button class="harness-row" data-harness="${name}" aria-expanded="${expanded}"><span><b>${name==="Claude"?"Claude Code":"Codex CLI"}</b><small>${escapeHTML(s.version||"Native CLI")}</small></span><span>${pill(s.state)} <span aria-hidden="true">${expanded?"⌃":"⌄"}</span></span></button>${expanded? `<div class="harness-detail">`+line("Executable",escapeHTML(s.path||"Not detected"))+line("Authentication",escapeHTML(s.authentication))+line("MCP","Not verified")+ `<label for="agent-path-${name}">Executable override (optional)</label><input id="agent-path-${name}" value="${escapeHTML(configuredPath(name))}" placeholder="Automatic discovery"><div class="right"><button data-check-agent="${name}" ${s.state==="Checking"?"disabled":""}>Test connection</button></div><p class="note">${escapeHTML(s.diagnostic)}</p>`+ "</div>":""}</section>`;
 }).join("");
}


// This view renders only events emitted by Go for an actual execution.
// An on-demand file is "available" until a native read is explicitly observed.
function knowledgePreview(agent:{id:string;name:string;role:string;harness:string},ctx:ViewContext):string{
 const esc=escapeHTML;
 const pack=ctx.state.knowledgePack;
 if(!pack)return panel("Knowledge trace",'<p class="team-note">Connect a knowledge pack to enable runtime context.</p><button data-page="Engineering DNA">Connect source</button>');
 const languages=ctx.state.agentLanguages?.[agent.id]??[];
 const entries=knowledgeForAgent(pack,agent.role,ctx.state.agentKnowledge?.[agent.id]??[],languages);
 const run=knowledgeRuns[agent.id];
 const events=run?.events??[];
 const injected=new Set(events.filter(e=>e.kind==="knowledge.injected").map(e=>e.documentId));
 const available=new Set(events.filter(e=>e.kind==="knowledge.available").map(e=>e.documentId));
 const complete=events.some(e=>e.kind==="execution.completed");
 const failed=events.some(e=>e.kind==="execution.failed");
 const phase=failed?"Failed":complete?"Completed":events.some(e=>e.kind==="execution.started")?"Running":"Not run";
 const match=/^Knowledge (Graph|Timeline|Context) [0-6]$/.exec(ctx.nav.tab);
 const view=match?.[1]??"Graph";
 const views=["Graph","Timeline","Context"].map(v=>'<button data-tab="Knowledge '+v+' 0" aria-pressed="'+(view===v)+'" style="padding:5px 10px;'+(view===v?'background:var(--raised);':'')+'">'+v+'</button>').join("");

 const boot=entries.filter(e=>injected.has(e.id));
 const onDemand=entries.filter(e=>available.has(e.id));
 const foundation=entries.filter(e=>e.load==="bootstrap");
 const local=entries.filter(e=>e.load==="on-demand");
 const started=events.some(e=>e.kind==="execution.started");
 const selected=new Set(events.filter(e=>e.kind==="knowledge.selected").map(e=>e.documentId));
 const label=(x:number,y:number,t:string)=>'<text x="'+x+'" y="'+y+'" fill="var(--subtle)" font-size="10" letter-spacing="1">'+esc(t)+'</text>';
 const box=(x:number,y:number,w:number,h:number,t:string,sub:string,status="neutral",detail="")=>{
  const colors=status==="active"?["#25332d","#79a98e"]:status==="available"?["#242e3b","#79a7d7"]:status==="failed"?["#38272a","#b97880"]:["var(--raised)","var(--edge)"];
  const limit=Math.floor((w-20)/6.8);
  const short=t.length>limit?t.slice(0,limit-1)+"…":t;
  const subLimit=Math.floor((w-20)/5.6);
  return '<g><title>'+esc(t+" · "+sub+(detail?" · "+detail:""))+'</title><rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="7" fill="'+colors[0]+'" stroke="'+colors[1]+'"/><text x="'+(x+12)+'" y="'+(y+22)+'" fill="var(--ink)" font-size="12">'+esc(short)+'</text><text x="'+(x+12)+'" y="'+(y+40)+'" fill="var(--subtle)" font-size="10">'+esc(sub.length>subLimit?sub.slice(0,subLimit-1)+"…":sub)+'</text></g>';
 };
 const edge=(d:string,active=false)=>'<path d="'+d+'" fill="none" stroke="'+(active?"#79a98e":"var(--edge)")+'" stroke-width="1.2" stroke-dasharray="'+(active?"none":"4 4")+'"/>';
 const doc=(e:typeof entries[number],x:number,y:number,w:number)=>{
  const status=injected.has(e.id)?"Injected":available.has(e.id)?"Available":selected.has(e.id)?"Selected":"Configured";
  return box(x,y,w,52,knowledgeDisplayName(e),status+" · "+e.tokens.toLocaleString()+" est. tokens",injected.has(e.id)?"active":available.has(e.id)?"available":"neutral",e.path+" · "+(e.status??"unknown"));
 };
 const bootstrapBottom=194+Math.ceil((foundation.length+1)/2)*62;
 const harnessY=bootstrapBottom+52;
 const height=Math.max(harnessY+280,harnessY+local.length*62+45);
 const graph='<div class="overflow"><svg role="img" aria-label="Configured knowledge graph with native execution evidence" viewBox="0 0 660 '+height+'" style="width:100%;min-width:460px;display:block;background:radial-gradient(var(--edge) 1px,transparent 1px);background-size:15px 15px;border:1px solid var(--edge);border-radius:7px">'
  +box(220,18,220,58,agent.name,agent.role+" · "+(agent.harness==="Claude"?"Claude Code":"Codex CLI"),started?"active":"neutral")
  +edge("M330 76V99",started)
  +'<rect x="24" y="99" width="612" height="'+(bootstrapBottom-99)+'" rx="8" fill="#25332d15" stroke="var(--edge)"/>'
  +label(40,120,"01 · BOOTSTRAP CONTEXT")
  +foundation.map((e,i)=>doc(e,40+(i%2)*294,134+Math.floor(i/2)*62,286)).join("")
  +box(40+(foundation.length%2)*294,134+Math.floor(foundation.length/2)*62,286,52,"Task objective",started?"Native execution started":"Awaiting task",started?"active":"neutral")
  +box(40,bootstrapBottom-56,580,44,"Compact knowledge index",local.length+" configured on-demand documents",available.size?"available":"neutral")
  +edge("M330 "+bootstrapBottom+"V"+(harnessY-22)+"H157V"+harnessY,started)
  +label(24,harnessY-10,"02 · NATIVE HARNESS")+label(362,harnessY-10,"03 · LOCAL KNOWLEDGE")
  +box(24,harnessY,266,60,agent.harness==="Claude"?"Claude Code":"Codex CLI",started?"Native read / search tools":"Awaiting execution",started?"active":"neutral")
  +local.map((e,i)=>edge("M290 "+(harnessY+30)+"H340V"+(harnessY+i*62+26)+"H362",available.has(e.id))+doc(e,362,harnessY+i*62,274)).join("")
  +(!local.length?label(362,harnessY+25,"No assigned documents"):"")
  +edge("M157 "+(harnessY+60)+"V"+(harnessY+94),started)
  +label(24,harnessY+86,"04 · EXECUTION")
  +box(24,harnessY+94,266,58,"Task execution",phase,failed?"failed":started?"active":"neutral")
  +edge("M157 "+(harnessY+152)+"V"+(harnessY+176),complete)
  +box(24,harnessY+176,266,58,"Response & evidence",complete?"Native execution completed":failed?"Execution failed":"Awaiting runtime events",failed?"failed":complete?"active":"neutral")
  +label(24,height-12,"File-first knowledge · No mandatory MCP")+'</svg></div><p class="team-note">Configured nodes remain visible before execution. Blue means available, not read. Green means native injection or execution evidence.</p>';
 const timeline=events.length?'<div class="overflow"><table><thead><tr><th>Time</th><th>Event</th><th>Document</th><th>Detail</th></tr></thead><tbody>'+events.map(e=>
   '<tr><td>'+esc(e.at?.split("T")[1]?.slice(0,12)??"—")+'</td><td>'+esc(e.kind)+'</td><td>'+esc(e.documentId??"—")+'</td><td>'+esc(e.reason||e.status||"—")+'</td></tr>'
 ).join("")+'</tbody></table></div>':'<p class="team-note">No runtime events yet. Start a conversation with this agent to collect evidence.</p>';
 const usage=run?.usage;
 const context='<div class="team-assignment"><strong>Context actually injected</strong>'+(
   boot.length?boot.map(e=>'<div class="team-assignment-row"><span>'+esc(knowledgeDisplayName(e))+'</span><small>'+esc(e.status??"unknown")+'</small></div>').join("")
  :'<p class="team-note">No bootstrap injection observed yet.</p>')+
  '</div><div class="team-assignment"><strong>On-demand files available (not injected)</strong>'+
  (onDemand.length?onDemand.map(e=>'<div class="team-assignment-row"><span>'+esc(knowledgeDisplayName(e))+'</span><small>Available</small></div>').join(""):'<p class="team-note">No on-demand files recorded.</p>')+'</div>'+
  '<div class="team-assignment"><strong>Token usage</strong>'+
  line("Context estimate",run?.estimatedContextTokens!==undefined?run.estimatedContextTokens.toLocaleString()+" estimated tokens":"Not calculated")+
  line("Native input",usage?usage.inputTokens.toLocaleString()+" tokens":"Not reported")+
  line("Native output",usage?usage.outputTokens.toLocaleString()+" tokens":"Not reported")+
  line("Cache read",usage?(usage.cacheReadTokens??0).toLocaleString()+" tokens":"Not reported")+
  '<p class="team-note">Context is bytes/4, not billed tokens. Claude invocation input excludes cache reads; Codex input includes cached input. Usage scope: '+esc(usage?.scope??"not reported")+'.</p></div>';
 return '<section class="panel" data-knowledge-runtime><div class="between"><h3>Knowledge trace</h3><small class="muted">'+esc(phase)+'</small></div><div class="chips" role="group" aria-label="Knowledge trace view">'+views+'</div><div class="between space" style="gap:10px;flex-wrap:wrap"><small class="muted">'+esc(run?.runId?"Run "+run.runId:"No run recorded")+'</small><small class="muted">'+entries.length+' configured · '+boot.length+' injected · '+onDemand.length+' available</small></div>'+
  (view==="Graph"?graph:view==="Timeline"?timeline:context)+'</section>';
}

// Agents refer to document IDs, not copied skill or standard contents.
function assignmentPanel(ctx:ViewContext,id:string,role:string):string{
 const esc=escapeHTML;
 const pack=ctx.state.knowledgePack;
 if(!pack)return '<section class="team-assignment"><strong>Knowledge</strong><p class="team-note">No source connected.</p><button data-page="Engineering DNA">Connect source</button></section>';
 const saved=ctx.state.agentKnowledge?.[id]??[];
 const languages=ctx.state.agentLanguages?.[id]??[];
 const availableLanguages=[...new Set(pack.entries.flatMap(e=>e.languages??[]).map(x=>x.toLowerCase()))].sort();
 const inherited=pack.entries.filter(e=>e.load==="bootstrap"&&knowledgeApplicable(e,role,languages));
 const group=(title:string,kinds:string[])=>{
  const items=pack.entries.filter(e=>e.load==="on-demand"&&kinds.includes(e.kind)&&knowledgeApplicable(e,role,languages));
  const assigned=items.filter(e=>saved.includes(e.id));
  return '<section class="team-assignment"><div class="between"><strong>'+esc(title)+' · '+assigned.length+'</strong><button data-assignment-open="'+esc(title)+'" aria-label="Assign '+esc(title)+'">+</button></div>'+
   assigned.map(e=>'<div class="team-assignment-row"><span title="'+esc(e.path)+'">'+esc(knowledgeDisplayName(e))+'</span><small>'+esc(e.status||"unknown")+'</small></div>').join("")+
   (!assigned.length?'<p class="team-note">No direct assignments.</p>':'')+
   '<details data-assignment-picker="'+esc(title)+'" hidden><summary>Choose from library</summary>'+items.map(e=>'<label class="team-assignment-choice"><input type="checkbox" data-assignment-doc="'+esc(e.id)+'" '+(saved.includes(e.id)?'checked':'')+'><span title="'+esc(e.path)+'">'+esc(knowledgeDisplayName(e))+' <small>· '+esc(e.status||"unknown")+'</small></span></label>').join("")+
   '<button data-assignment-done>Done</button></details></section>';
 };
 const languagePanel='<section class="team-assignment"><strong>Project languages</strong><p class="team-note">Select languages for this agent. Language-specific standards only apply to matching projects.</p>'+
  (availableLanguages.length?availableLanguages.map(lang=>'<label class="team-assignment-choice"><input type="checkbox" data-agent-language="'+esc(lang)+'" '+(languages.includes(lang)?'checked':'')+'><span>'+esc(lang)+'</span></label>').join(""):'<p class="team-note">No language-specific documents.</p>')+'</section>';
 return languagePanel+
 '<section class="team-assignment"><strong>Automatic bootstrap · '+inherited.length+'</strong><p class="team-note">Engineering DNA, matching role and applicable standards. Draft entries remain provisional.</p>'+
 inherited.map(e=>'<div class="team-assignment-row"><span title="'+esc(e.path)+'">'+esc(knowledgeDisplayName(e))+'</span><small>'+esc(e.status||"unknown")+'</small></div>').join("")+'</section>'+
 group("Skills",["skills"])+group("References",["references","guides","profiles","lesson"])+
 '<section class="team-assignment"><strong>Source</strong><p class="team-note">'+esc(pack.id)+' · '+esc(pack.version)+' · '+esc(pack.status)+'</p><p class="team-note">Role and language applicability from manifest.json</p><button data-page="Engineering DNA">Open knowledge library</button></section>';
}

export function renderTeam(ctx:ViewContext):string {
 const {state,nav}=ctx;
 if(nav.tab==="Harnesses")return renderHarnesses(ctx);
 if(nav.tab==="Roles")return renderHarnesses(ctx);
 const agents=profiles(state);
 const esc=escapeHTML;
 const selected=agents.find(a=>a.id===nav.detail);
 const css=`<style>.team-view{font-size:13px;min-width:0}.team-view .team-toolbar{display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--edge);padding:0 18px;height:49px}.team-view .team-toolbar h2{margin:0;flex:1;font-size:14px;font-weight:500}.team-view .team-avatar{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:8px;background:#50545d;color:#eee;margin-right:10px}.team-view .team-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,26%);gap:0}.team-view .team-profile{padding:24px 28px;min-width:0}.team-view .team-properties{position:sticky;top:0;align-self:start;max-height:calc(100vh - 120px);overflow-y:auto;width:auto;max-width:none;min-width:0;height:auto;display:block;background:transparent;border:0;border-left:1px solid var(--edge);padding:18px 16px}.team-view .team-section{margin:22px 0 0;padding-top:18px;border-top:1px solid var(--edge)}.team-view .team-section h3{font-size:13px;margin:0 0 10px;font-weight:600}.team-view .team-link,.team-view .team-toolbar button,.team-view .team-section>button,.team-view .team-properties button{border:0;background:transparent;color:inherit;text-align:left;padding:5px 8px;border-radius:6px}.team-view button:hover{background:var(--raised)}.team-view .team-prop{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px;padding:7px 0;align-items:center}.team-view .team-prop input,.team-view .team-prop select{width:100%;min-width:0;box-sizing:border-box;font:inherit;padding:5px 6px;background:transparent;border:1px solid transparent;border-radius:4px;color:inherit}.team-view .team-prop input:hover,.team-view .team-prop select:hover,.team-view .team-prop input:focus,.team-view .team-prop select:focus{border-color:var(--edge);background:var(--raised)}.team-view .team-prop span:first-child{color:var(--subtle)}.team-view td{white-space:nowrap}.team-view .team-note{color:var(--subtle);font-size:12px}.team-view .team-identity{display:flex;align-items:center;margin:0 0 8px;font-size:24px;font-weight:600}.team-view .team-identity .team-avatar{width:42px;height:42px;font-size:20px}.team-view .team-profile>p{margin:0}.team-view .team-section details summary{cursor:pointer;color:var(--subtle)}.team-view .team-section details p{white-space:pre-wrap;line-height:1.6}.team-view .team-section .team-library-row{padding:7px 0;border-bottom:1px solid var(--edge)}.team-view .team-assignment{border-top:1px solid var(--edge);margin-top:16px;padding-top:14px}.team-view .team-assignment-row,.team-view .team-assignment-choice{display:flex;gap:8px;align-items:start;padding:7px 0;overflow-wrap:anywhere}.team-view .team-assignment-row span,.team-view .team-assignment-choice span{flex:1;min-width:0}.team-view .team-assignment small{color:var(--subtle);font-size:11px}.team-view .team-assignment details{margin-top:8px}.team-view .team-assignment details[hidden]{display:none}@media(max-width:850px){.team-view .team-split{grid-template-columns:minmax(0,1fr)}.team-view .team-properties{position:static;max-height:none;border-left:0;border-top:1px solid var(--edge)}.team-view .team-profile{padding:18px}}</style>`;
 const avatar=(a:typeof agents[number])=>`<span class="team-avatar">${esc(a.name[0])}</span>`;
 const prop=(k:string,v:string)=>`<div class="team-prop"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
 const body=nav.detail==="new-agent"?`<div class="team-toolbar"><button data-back>← All agents</button><h2>New agent</h2></div><div class="team-profile"><div class="team-prop"><span>Name</span><input id="new-agent-name" maxlength="80"></div><div class="team-prop"><span>Handle</span><input id="new-agent-handle" maxlength="40"></div><div class="team-prop"><span>Role</span><select id="new-agent-role">${ctx.options([...new Set([...Object.keys(state.roles),...(state.knowledgePack?.entries.filter(e=>e.kind==="roles").map(knowledgeRoleName)??[])])],"")}</select></div><div class="team-prop"><span>Harness</span><select id="new-agent-harness">${ctx.options(["Claude","Codex"],"Claude")}</select></div><div class="team-prop"><span>Model</span><input id="new-agent-model" value="Default"></div><button data-agent-create>Create agent</button><p data-profile-status class="team-note"></p></div>`:selected? `<div class="team-toolbar"><button data-back>← All agents</button><h2>${esc(selected.name)}</h2><button data-profile-chat="${selected.id}">Chat</button></div><div class="team-split"><div class="team-profile"><h2 class="team-identity">${avatar(selected)}${esc(selected.name)}</h2><p class="team-note">${esc(selected.role)} · @${esc(selected.handle)}</p><div class="team-section">${knowledgePreview(selected,ctx)}</div><div class="team-section"><h3>Recent work</h3><p class="team-note">Agent-specific run history is not connected.</p></div><div class="team-section"><h3>Instructions</h3><details><summary>View role instructions</summary><p>${esc(state.roles[selected.role]||"No role knowledge configured.")}</p></details></div></div><aside class="team-properties"><h3>Properties</h3>${prop("Status",agentStatus(selected.harness).state)}<div class="team-prop"><span>Handle</span><input aria-label="Handle" id="profile-handle" value="${esc(selected.handle)}"></div><div class="team-prop"><span>Role</span><select aria-label="Role" id="profile-role">${ctx.options([...new Set([selected.role,...(state.knowledgePack?.entries.filter(e=>e.kind==="roles").map(knowledgeRoleName)??Object.keys(state.roles))])],selected.role)}</select></div><div class="team-prop"><span>Harness</span><select aria-label="Harness" id="profile-harness">${ctx.options(["Claude","Codex"],selected.harness)}</select></div><div class="team-prop"><span>Model</span><input aria-label="Model" id="profile-model" value="${esc(selected.model)}"></div><button data-profile-save="${selected.id}">Save properties</button><p data-profile-status class="team-note"></p><button data-tab="Harnesses">Harness settings</button>${assignmentPanel(ctx,selected.id,selected.role)}</aside></div>`:`<div class="team-toolbar"><h2>All agents</h2><button data-agent-new>+ New agent</button></div><div class="overflow"><table><thead><tr>${["Agent","Role","Status","Harness","Model","Last active","Runs"].map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${agents.map(a=>`<tr><td><button class="team-link" data-harness="${a.id}">${avatar(a)}${esc(a.name)}</button></td><td>${esc(a.role)}</td><td>${esc(agentStatus(a.harness).state)}</td><td>${a.harness==="Claude"?"Claude Code":"Codex"}</td><td>${esc(a.model)}</td><td>—</td><td>—</td></tr>`).join("")}</tbody></table></div><p class="team-note">${agents.length} agents</p>`;
 return css+`<div class="team-view">${body}</div>`;
}

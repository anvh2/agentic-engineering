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
 const fill={agent:"#29263b",bootstrap:"#25332d",harness:agent.harness==="Claude"?"#352821":"#27272a",onDemand:"#242e3b",evidence:"#332e23"};
 const border={agent:"#a99ad9",bootstrap:"#79a98e",harness:agent.harness==="Claude"?"#d97757":"#a1a1aa",onDemand:"#79a7d7",evidence:"#c5ac72"};
 const node=(x:number,y:number,w:number,label:string,sub:string,color:string,key:keyof typeof fill)=>
  '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="65" rx="7" fill="'+color+'" stroke="'+border[key]+'"/><text x="'+(x+12)+'" y="'+(y+25)+'" font-size="13" fill="var(--ink)">'+esc(label)+'</text><text x="'+(x+12)+'" y="'+(y+45)+'" font-size="11" fill="var(--subtle)">'+esc(sub)+'</text>';
 const boot=entries.filter(e=>injected.has(e.id));
 const onDemand=entries.filter(e=>available.has(e.id));
 const edge=(d:string)=>'<path d="'+d+'" stroke="var(--subtle)" opacity=".65" stroke-width="1.3" fill="none"/>';
 const graph='<div class="overflow"><svg role="img" aria-label="Knowledge execution evidence" viewBox="0 0 650 350" style="width:100%;min-width:470px;border:1px solid var(--edge);border-radius:7px">'
  +node(210,15,230,65,agent.name,agent.role+" · "+agent.harness,fill.agent,"agent")
  +edge("M325 80V110")+node(170,110,310,65,"Bootstrap context",boot.length+" injected documents",boot.length?fill.bootstrap:"var(--raised)","bootstrap")
  +edge("M325 175V205H170V220 M325 205H480V220")
  +node(15,220,295,65,agent.harness==="Claude"?"Claude Code":"Codex CLI",phase,fill.harness,"harness")
  +node(335,220,300,65,"On-demand knowledge",onDemand.length+" available · reads not verified",onDemand.length?fill.onDemand:"var(--raised)","onDemand")
  +edge("M162 285V310H325V320 M485 285V310H325V320")
  +'<text x="325" y="340" font-size="12" text-anchor="middle" fill="var(--subtle)">'+esc(run?"Execution evidence captured":"No execution has been recorded")+'</text></svg></div>';
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
  '<p class="team-note">Context estimate is size-derived; native usage is reported by the CLI when available. They are different measurements.</p></div>';
 return '<section class="panel" data-knowledge-runtime><div class="between"><h3>Knowledge trace</h3><small class="muted">'+esc(phase)+'</small></div><div class="chips" role="group" aria-label="Knowledge trace view">'+views+'</div><div class="between space" style="gap:10px;flex-wrap:wrap"><small class="muted">'+esc(run?.runId?"Run "+run.runId:"No run recorded")+'</small><small class="muted">'+boot.length+' injected · '+onDemand.length+' available</small></div>'+
  (view==="Graph"?graph:view==="Timeline"?timeline:context)+'</section>';
}

// Agents refer to document IDs, not copied skill or standard contents.
function assignmentPanel(ctx:ViewContext,id:string,role:string):string{
 const esc=escapeHTML;
 const pack=ctx.state.knowledgePack;
 if(!pack)return '<section class="team-assignment"><strong>Knowledge</strong><p class="team-note">No source connected.</p><button data-page="Engineering DNA">Connect source</button></section>';
 const saved=ctx.state.agentKnowledge?.[id]??[];
 const roleName=role.toLowerCase();
 const inherited=pack.entries.filter(e=>e.kind==="engineering"||e.kind==="roles"&&e.path.includes("/"+roleName+"/"));
 const group=(title:string,kinds:string[])=>{
  const items=pack.entries.filter(e=>kinds.includes(e.kind));
  const assigned=items.filter(e=>saved.includes(e.id));
  return '<section class="team-assignment"><div class="between"><strong>'+title+' · '+assigned.length+'</strong><button data-assignment-open="'+title+'" aria-label="Assign '+title+'">+</button></div>'+
   assigned.map(e=>'<div class="team-assignment-row"><span title="'+esc(e.path)+'">'+esc(knowledgeDisplayName(e))+'</span><small>Direct</small></div>').join("")+
   (!assigned.length?'<p class="team-note">No assignments.</p>':'')+
   '<details data-assignment-picker="'+title+'" hidden><summary>Choose from library</summary>'+items.map(e=>'<label class="team-assignment-choice"><input type="checkbox" data-assignment-doc="'+esc(e.id)+'" '+(saved.includes(e.id)?'checked':'')+'><span title="'+esc(e.path)+'">'+esc(knowledgeDisplayName(e))+'</span></label>').join("")+
   '<button data-assignment-done>Done</button></details></section>';
 };
 return '<section class="team-assignment"><strong>Knowledge</strong>'+inherited.map(e=>'<div class="team-assignment-row"><span>'+esc(knowledgeDisplayName(e))+'</span><small>'+(e.kind==="engineering"?"Workspace":"Role")+'</small></div>').join("")+'</section>'+
 group("Standards",["standards"])+group("Skills",["skills"])+group("References",["references","guides"])+
 '<section class="team-assignment"><strong>Source</strong><p class="team-note">'+esc(pack.id)+' · '+esc(pack.version)+' · '+esc(pack.status)+'</p><p class="team-note">Local file adapter · Preview only</p><button data-page="Engineering DNA">Open knowledge library</button></section>';
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

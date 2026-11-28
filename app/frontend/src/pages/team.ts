import { profiles } from "../services/agent-chat";
import type { ViewContext } from "../view-context";
import { escapeHTML, pill, action, heading, panel, line } from "../components/primitives";
import { agentNames, agentStatus, configuredPath } from "../services/agent-connection";
import { knowledgeForAgent, knowledgeDisplayName, knowledgeRoleName, knowledgeApplicable, knowledgePhase } from "../services/knowledge-source";
function renderHarnesses(ctx:ViewContext):string {
 const {state,nav,tabs,options}=ctx;
 if(nav.tab==="Roles")return heading("Team","Native harnesses and reusable role knowledge")+tabs(["Agents","Roles","Harnesses"])+`<div class="between space"><select id="role-select">${options(Object.keys(state.roles),nav.roleSelected)}</select>${action("+ New role",'data-open="role"')}</div>`+panel("Base knowledge",`<textarea id="role-knowledge" class="editor">${escapeHTML(state.roles[nav.roleSelected])}</textarea><div class="right">${action("Save role","data-save-role",true)}</div>`);
 return heading("Team","Native execution environments",action("Rescan all","data-rescan"))+tabs(["Agents","Roles","Harnesses"])+agentNames.map(name=>{
 const s=agentStatus(name), expanded=nav.detail===name;
 return `<section class="panel harness-panel"><button class="harness-row" data-harness="${name}" aria-expanded="${expanded}"><span><b>${name==="Claude"?"Claude Code":"Codex CLI"}</b><small>${escapeHTML(s.version||"Native CLI")}</small></span><span>${pill(s.state)} <span aria-hidden="true">${expanded?"⌃":"⌄"}</span></span></button>${expanded? `<div class="harness-detail">`+line("Executable",escapeHTML(s.path||"Not detected"))+line("Authentication",escapeHTML(s.authentication))+line("MCP","Not verified")+ `<label for="agent-path-${name}">Executable override (optional)</label><input id="agent-path-${name}" value="${escapeHTML(configuredPath(name))}" placeholder="Automatic discovery"><div class="right"><button data-check-agent="${name}" ${s.state==="Checking"?"disabled":""}>Test connection</button></div><p class="note">${escapeHTML(s.diagnostic)}</p>`+ "</div>":""}</section>`;
 }).join("");
}


// Trace uses the connected local source manifest and this agent's assignments.
// The playback is illustrative until native file-read events are connected.
function knowledgePreview(agent:{id:string;name:string;role:string;harness:string},ctx:ViewContext):string{
 const esc=escapeHTML;
 const pack=ctx.state.knowledgePack;
 const eligible=knowledgeForAgent(pack,agent.role,ctx.state.agentKnowledge?.[agent.id]??[],ctx.state.agentLanguages?.[agent.id]??[]);
 if(!pack)return panel("Knowledge trace",'<p class="team-note">Connect engineering-knowledge to see the files selected for this agent.</p><button data-page="Engineering DNA">Connect knowledge source</button>');
 const entries=eligible.map(e=>({
  id:e.id,name:knowledgeDisplayName(e),kind:e.kind==="engineering"?"DNA":e.kind==="roles"?"Role":e.kind==="skills"?"Skill":e.kind==="standards"?"Standard":"Reference",
  phase:e.load==="bootstrap"?1:Math.max(2,knowledgePhase(e)),tokens:e.tokens,reason:e.kind==="engineering"?"Workspace":e.kind==="roles"?"Role":"Direct assignment"
 }));
 const phases=["Waiting","Bootstrap","Repository discovery","Planning","Implementation","Debugging","Verification"];
 const match=/^Knowledge (Graph|Timeline|Context) ([0-6])$/.exec(ctx.nav.tab);
 const view=match?.[1]||"Graph",step=Number(match?.[2]||0);
 const loaded=entries.filter(e=>e.phase<=step);
 const total=loaded.reduce((sum,e)=>sum+e.tokens,0);
 const motion="";
 const selectedIDs=new Set(eligible.map(e=>e.id));
 const applicable=pack.entries.filter(e=>knowledgeApplicable(e,agent.role,ctx.state.agentLanguages?.[agent.id]??[]));
 const groups=new Map<string,{title:string;docs:typeof applicable}>();
 for(const e of applicable){
  const id=e.group||e.kind;
  const group=groups.get(id)||{title:pack.groups?.find(g=>g.id===id)?.title||id,docs:[]};
  group.docs.push(e);groups.set(id,group);
 }
 const groupCards=(bootstrap:boolean)=>Array.from(groups.values()).map(g=>{
  const docs=g.docs.filter(e=>(e.load==="bootstrap")===bootstrap);
  if(!docs.length)return "";
  const chosen=docs.filter(e=>selectedIDs.has(e.id));
  const tokens=chosen.reduce((sum,e)=>sum+e.tokens,0);
  return '<details class="panel" style="margin:6px 0;padding:10px"><summary style="cursor:pointer"><strong>'+esc(g.title)+'</strong><br><small class="muted">'+chosen.length+'/'+docs.length+' selected · '+tokens.toLocaleString()+' est. tokens</small></summary>'+docs.map(e=>'<div class="between space"><span>'+esc(knowledgeDisplayName(e))+'</span><small class="muted">'+(selectedIDs.has(e.id)?(bootstrap?"Bootstrap planned":"Selected"):"Available")+' · '+e.tokens+' est.</small></div>').join("")+'</details>';
 }).join("");
 const graph='<div style="border:1px solid var(--edge);border-radius:7px;padding:12px;background:radial-gradient(var(--edge) 1px,transparent 1px);background-size:15px 15px"><div class="panel" style="max-width:240px;margin:auto;text-align:center"><strong>'+esc(agent.name)+'</strong><p class="muted">'+esc(agent.role+" · "+agent.harness)+'</p></div><div style="text-align:center">↓</div><section class="panel"><small class="muted">01 · BOOTSTRAP CONTEXT</small>'+groupCards(true)+'</section><div style="text-align:center">↓</div><div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:12px"><div><small class="muted">02 · NATIVE HARNESS</small><div class="panel">'+esc(agent.harness)+'</div><div style="text-align:center">↓</div><small class="muted">04 · EXECUTION</small><div class="panel">Task execution</div><div style="text-align:center">↓</div><div class="panel">Response &amp; evidence</div></div><div><small class="muted">03 · LOCAL KNOWLEDGE</small>'+groupCards(false)+'</div></div></div>';
 const timeline='<div class="overflow"><table><thead><tr><th>Phase</th><th>Knowledge</th><th>Source</th><th>Status</th></tr></thead><tbody>'+entries.map(e=>'<tr><td>'+esc(phases[e.phase])+'</td><td>'+esc(e.name)+'</td><td>'+esc(e.reason)+'</td><td data-knowledge-status="'+e.phase+'">'+(e.phase<=step?'Loaded':'Available')+'</td></tr>').join("")+'</tbody></table></div>';
 const usage=["DNA","Role","Standard","Skill","Reference"].map(k=>{const n=loaded.filter(e=>e.kind===k).reduce((sum,e)=>sum+e.tokens,0);return line(esc(k),'<span data-knowledge-category="'+k+'">'+n.toLocaleString()+' tokens</span>')+'<div class="progress"><i data-knowledge-bar="'+k+'" style="width:'+(total?100*n/total:0)+'%"></i></div>';}).join("");
 return '<div data-knowledge-preview data-knowledge-entries="'+esc(JSON.stringify(entries))+'">'+motion+'<section class="panel"><div class="between"><h3>Knowledge preview</h3><small class="muted" title="Selected files from '+esc(pack.id)+' '+esc(pack.version)+'; playback is illustrative, not native read telemetry">Preview</small></div><div class="chips" role="group" aria-label="Knowledge view">'+["Graph","Timeline","Context"].map(v=>'<button data-tab="Knowledge '+v+' '+step+'" aria-pressed="'+(v===view)+'" style="padding:5px 10px;'+(v===view?'background:var(--raised);':'')+'">'+v+'</button>').join("")+'</div><div class="between space" style="flex-wrap:wrap;gap:8px"><span data-knowledge-phase>'+esc(phases[step])+'</span><span class="muted"><span data-knowledge-count>'+loaded.length+" / "+entries.length+'</span> simulated phase · <span title="Size-derived estimate (bytes / 4); not actual model token usage"><span data-knowledge-total>'+total.toLocaleString()+'</span> est. tokens</span></span></div>'+(view==="Graph"?graph:view==="Timeline"?timeline:usage)+'<div class="between space"><small class="muted">File-first knowledge · No model calls</small><button data-knowledge-replay>↻ Replay</button></div></section></div>';
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
 group("Skills",["skills"])+group("References",["references","guides","profiles","lesson","standards"])+
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

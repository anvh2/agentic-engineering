import type { ViewContext } from "../view-context";
import { escapeHTML, pill, action, heading, panel, line } from "../components/primitives";
import { agentNames, agentStatus, configuredPath } from "../services/agent-connection";
function renderHarnesses(ctx:ViewContext):string {
 const {state,nav,tabs,options}=ctx;
 if(nav.tab==="Roles")return heading("Team","Native harnesses and reusable role knowledge")+tabs(["Agents","Roles","Harnesses"])+`<div class="between space"><select id="role-select">${options(Object.keys(state.roles),nav.roleSelected)}</select>${action("+ New role",'data-open="role"')}</div>`+panel("Base knowledge",`<textarea id="role-knowledge" class="editor">${escapeHTML(state.roles[nav.roleSelected])}</textarea><div class="right">${action("Save role","data-save-role",true)}</div>`);
 return heading("Team","Native execution environments",action("Rescan all","data-rescan"))+tabs(["Agents","Roles","Harnesses"])+agentNames.map(name=>{
 const s=agentStatus(name), expanded=nav.detail===name;
 return `<section class="panel harness-panel"><button class="harness-row" data-harness="${name}" aria-expanded="${expanded}"><span><b>${name==="Claude"?"Claude Code":"Codex CLI"}</b><small>${escapeHTML(s.version||"Native CLI")}</small></span><span>${pill(s.state)} <span aria-hidden="true">${expanded?"⌃":"⌄"}</span></span></button>${expanded? `<div class="harness-detail">`+line("Executable",escapeHTML(s.path||"Not detected"))+line("Authentication",escapeHTML(s.authentication))+line("MCP","Not verified")+ `<label for="agent-path-${name}">Executable override (optional)</label><input id="agent-path-${name}" value="${escapeHTML(configuredPath(name))}" placeholder="Automatic discovery"><div class="right"><button data-check-agent="${name}" ${s.state==="Checking"?"disabled":""}>Test connection</button></div><p class="note">${escapeHTML(s.diagnostic)}</p>`+ "</div>":""}</section>`;
 }).join("");
}


// Design preview only: these are illustrative events, not harness telemetry.
function knowledgePreview(agent: {name:string;role:string;harness:string}, ctx:ViewContext):string {
 const esc=escapeHTML;
 const entries=[
  {name:"Engineering DNA",kind:"DNA",phase:1,tokens:280,reason:"Workspace bootstrap"},
  {name:agent.role,kind:"Role",phase:1,tokens:190,reason:"Assigned role"},
  {name:"Repository context",kind:"Context",phase:2,tokens:240,reason:"Native discovery"},
  {name:"Go Standard",kind:"Standard",phase:3,tokens:410,reason:"Go implementation"},
  {name:"Messaging Standard",kind:"Standard",phase:3,tokens:360,reason:"Kafka consumer"},
  {name:"Database Standard",kind:"Standard",phase:4,tokens:320,reason:"Persistence"},
  {name:"Debugging",kind:"Skill",phase:5,tokens:480,reason:"Failed test"},
  {name:"Testing Standard",kind:"Standard",phase:6,tokens:260,reason:"Verification"},
  {name:"Code Review",kind:"Skill",phase:6,tokens:390,reason:"Review"},
  {name:"TypeScript Standard",kind:"Standard",phase:99,tokens:500,reason:"Not relevant"}
 ];
 const phases=["Waiting","Bootstrap","Repository discovery","Planning","Implementation","Debugging","Verification"];
 const match=/^Knowledge (Graph|Timeline|Context) ([0-6])$/.exec(ctx.nav.tab);
 const view=match?.[1]||"Graph", step=Number(match?.[2]||0);
 const loaded=entries.filter(e=>e.phase<=step),total=loaded.reduce((n,e)=>n+e.tokens,0);
 const button=(v:string,p:number,label:string)=>action(label,'data-tab="Knowledge '+v+' '+p+'"');
 const graph='<div class="overflow"><svg role="img" aria-label="Illustrative knowledge flow" viewBox="0 0 660 390" style="width:100%;min-width:460px;display:block">'+entries.map((e,i)=>{
 const left=i<5,x=left?10:460,y=20+(i%5)*72,active=e.phase<=step;
 return '<path d="M'+(left?200:460)+' '+(y+25)+' C'+(left?230:430)+' '+(y+25)+','+(left?230:430)+' 180,'+(left?255:405)+' 180" fill="none" stroke="'+(active?'#92a0ae':'var(--edge)')+'" stroke-dasharray="'+(active?'none':'4 4')+'"/>';
 }).join("")+'<rect x="255" y="142" width="150" height="76" rx="7" fill="var(--raised)" stroke="var(--subtle)"/><text x="330" y="171" text-anchor="middle" fill="var(--ink)" font-size="14">'+esc(agent.name)+'</text><text x="330" y="191" text-anchor="middle" fill="var(--subtle)" font-size="11">'+esc(agent.role)+'</text>'+entries.map((e,i)=>{
 const x=i<5?10:460,y=20+(i%5)*72,active=e.phase<=step;
 return '<rect x="'+x+'" y="'+y+'" width="190" height="50" rx="6" fill="var(--raised)" stroke="'+(active?'#92a0ae':'var(--edge)')+'"/><text x="'+(x+10)+'" y="'+(y+19)+'" fill="var(--ink)" font-size="12">'+esc(e.name)+'</text><text x="'+(x+10)+'" y="'+(y+36)+'" fill="var(--subtle)" font-size="10">'+(active?'Simulated load · '+e.tokens+' tokens':e.phase===99?'Not selected':'Available')+'</text>';
 }).join("")+'</svg></div>';
 const timeline='<div class="overflow"><table><thead><tr><th>Phase</th><th>Knowledge</th><th>Trigger</th><th>Status</th></tr></thead><tbody>'+entries.map(e=>'<tr><td>'+ (e.phase===99?'—':esc(phases[e.phase]))+'</td><td>'+esc(e.name)+'</td><td>'+esc(e.reason)+'</td><td>'+(e.phase<=step?'Simulated load':e.phase===99?'Not selected':'Available')+'</td></tr>').join("")+'</tbody></table></div>';
 const usage=["DNA","Role","Context","Standard","Skill"].map(k=>{const n=loaded.filter(e=>e.kind===k).reduce((sum,e)=>sum+e.tokens,0);return line(esc(k),n.toLocaleString()+" tokens")+'<div class="progress"><i style="width:'+(total?100*n/total:0)+'%"></i></div>';}).join("");
 return panel("Knowledge trace",'<p class="note">Design simulation · local file adapter vision. No live reads, skill activations or token measurements are connected.</p><div class="chips">'+["Graph","Timeline","Context"].map(v=>button(v,step,v===view?v+" (selected)":v)).join("")+'</div><div class="between space"><span>'+esc(phases[step])+' · '+step+'/6</span><div class="chips">'+button(view,0,"Reset")+(step<6?button(view,step+1,"Next phase"):"")+'</div></div>'+line("Simulated documents",loaded.length+" / "+entries.length)+line("Estimated knowledge tokens",total.toLocaleString())+(view==="Graph"?graph:view==="Timeline"?timeline:usage)+'<p class="muted">Illustrative cumulative document sizes, not actual context window usage or billed tokens.</p>');
}

export function renderTeam(ctx:ViewContext):string {
 const {state,nav}=ctx;
 if(nav.tab==="Harnesses")return renderHarnesses(ctx);
 if(nav.tab==="Roles")return renderHarnesses(ctx);
 const agents=[{id:"alex",name:"Alex",role:"Architect",harness:"Claude" as const},{id:"emma",name:"Emma",role:"Developer",harness:"Codex" as const},{id:"noah",name:"Noah",role:"Reviewer",harness:"Claude" as const}];
 const esc=escapeHTML;
 const selected=agents.find(a=>a.id===nav.detail);
 const css=`<style>.team-view{font-size:13px}.team-view .team-toolbar{display:flex;align-items:center;gap:12px;border-bottom:1px solid #303034;padding:12px 0}.team-view .team-toolbar h2{margin:0;flex:1;font-size:16px}.team-view .team-avatar{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#50545d;color:#eee;margin-right:10px}.team-view .team-split{display:grid;grid-template-columns:minmax(0,1fr) 210px;gap:24px}.team-view .team-profile{padding:24px 0}.team-view .team-properties{border-left:1px solid #303034;padding:24px 16px}.team-view .team-section{margin-top:28px}.team-view .team-section h3{font-size:13px}.team-view .team-link{border:0;background:transparent;color:inherit;text-align:left;padding:4px}.team-view .team-prop{display:flex;justify-content:space-between;gap:8px;padding:8px 0}.team-view .team-prop span:first-child{opacity:.6}.team-view td{white-space:nowrap}.team-view .team-note{opacity:.65;font-size:12px}@media(max-width:700px){.team-view .team-split{grid-template-columns:1fr}.team-view .team-properties{border-left:0;border-top:1px solid #303034}}</style>`;
 const avatar=(a:typeof agents[number])=>`<span class="team-avatar">${esc(a.name[0])}</span>`;
 const prop=(k:string,v:string)=>`<div class="team-prop"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
 const body=selected? `<div class="team-toolbar"><button data-back>Agents</button><h2>${esc(selected.name)}</h2></div><div class="team-split"><div class="team-profile"><h2>${avatar(selected)}${esc(selected.name)}</h2><p class="team-note">${esc(selected.role)} · @${esc(selected.id)}</p><div class="team-section"><h3>Now</h3><p class="team-note">No live agent activity is available in this preview.</p></div><div class="team-section"><h3>Recent work</h3><p class="team-note">Agent-specific run history is not connected.</p></div><div class="team-section"><h3>Instructions</h3><p style="white-space:pre-wrap">${esc(state.roles[selected.role]||"No role knowledge configured.")}</p></div><div class="team-section"><h3>Knowledge</h3><p class="team-note">Workspace library · agent-specific assignments are not connected.</p>${Object.keys(state.knowledge).map(k=>`<div class="team-prop">${esc(k)}</div>`).join("")}<button data-page="Engineering DNA">Open knowledge</button></div><div class="team-section"><h3>Skills</h3><p class="team-note">No agent-specific skills configured.</p></div><div class="team-section">${knowledgePreview(selected,ctx)}</div></div><aside class="team-properties"><h3>Properties</h3>${prop("Status","Preview")}${prop("Handle","@"+selected.id)}${prop("Role",selected.role)}${prop("Harness",selected.harness==="Claude"?"Claude Code":"Codex")}${prop("Model","Default")}<button data-tab="Harnesses">Harness settings</button></aside></div>`:`<div class="team-toolbar"><h2>All agents</h2><span class="team-note">Preview agents</span></div><div class="overflow"><table><thead><tr>${["Agent","Role","Status","Harness","Model","Last active","Runs"].map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${agents.map(a=>`<tr><td><button class="team-link" data-harness="${a.id}">${avatar(a)}${esc(a.name)}</button></td><td>${esc(a.role)}</td><td>Preview</td><td>${a.harness==="Claude"?"Claude Code":"Codex"}</td><td>Default</td><td>—</td><td>—</td></tr>`).join("")}</tbody></table></div><p class="team-note">${agents.length} agents</p>`;
 return css+`<div class="team-view">${ctx.tabs(["Agents","Roles","Harnesses"])}${body}</div>`;
}

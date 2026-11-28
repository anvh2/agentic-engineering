import {profiles} from "../services/agent-chat";
import {issueChats} from "../services/issue-chat";
import { mountWork, unmountWork } from "../work/mount";
import { agentStatus } from "../services/agent-connection";
import type { ViewContext } from "../view-context";
import { escapeHTML } from "./primitives";
import { renderPage } from "../pages";
import { renderDialog } from "./dialog";
// Product domains, not runtime components. Keep page IDs stable for existing handlers.
const groups = [
 {name:"Home", pages:["Overview"]},
 {name:"Work", pages:["Objectives","Projects","Decisions"]},
 {name:"Team", pages:["Team"]},
 {name:"Chat", pages:["Chat","Collaboration"]},
 {name:"Knowledge", pages:["Engineering DNA"]},
 {name:"Insights", pages:["Sessions","Usage & Cost"]},
 {name:"Settings",pages:["Settings"]}
];
const pageLabels:Record<string,string> = {
 Collaboration:"Project Chat", Objectives:"Working", Team:"Agents",
 "Engineering DNA":"Engineering DNA & skills", Sessions:"Executions"
};
function pageLabel(name:string){return pageLabels[name]||name;}
const paths:Record<string,string> = {
 Home:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
 Knowledge:'<path d="M12 5v16M3 4h5a4 4 0 0 1 4 3 4 4 0 0 1 4-3h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z"/>',
 Insights:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',
 Work:'<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M8 5V3h8v2M3 11h18"/>',
 Team:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m3 9v-2a5 5 0 0 0-3-5"/>',
 Chat:'<path d="M21 11a8 8 0 0 1-8 8H8l-5 3 1-6a8 8 0 0 1 7-13h2a8 8 0 0 1 8 8Z"/>',
 Settings:'<circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M5 5l3 3m8 8 3 3M5 19l3-3m8-8 3-3"/>',
 Overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
 Objectives:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
 Projects:'<path d="M3 5h7l2 3h9v12H3Z"/>',
 Decisions:'<path d="M12 3v18M5 7h14M5 7l-3 7h6Zm14 0-3 7h6Z"/>',
 Sessions:'<path d="m4 6 6 6-6 6m10 0h6"/>',
 "Engineering DNA":'<path d="M5 3c0 9 14 9 14 18M19 3c0 9-14 9-14 18M7 6h10M7 18h10"/>',
 "Usage & Cost":'<path d="M4 20V4m0 16h16M8 16v-4m5 4V7m5 9V4"/>',
 Collaboration:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m3 9v-2a5 5 0 0 0-3-5"/>'
};
function icon(name:string){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(paths[name]||paths.Chat)+'</svg>'}
export function renderLayout(root:HTMLElement,ctx:ViewContext){
 const {nav,state,getProject}=ctx;
 const project=nav.projectFilter==="all"?undefined:getProject(nav.projectFilter);
 const initial=project?Array.from(project.name.trim())[0]?.toUpperCase()||"?":"";
 const avatarTitle=escapeHTML(project?.name||"All projects");
 const projectAvatar='<details class="project-switcher"><summary class="rail-logo" aria-label="Switch project: '+avatarTitle+'" title="'+avatarTitle+'">'+(project?escapeHTML(initial):icon("Projects"))+'</summary><div class="project-menu"><small>Projects</small>'+[{id:"all",name:"All projects"},...state.projects].map(p=>'<button class="project-option" data-switch-project="'+escapeHTML(p.id)+'"><span class="project-initial">'+(p.id==="all"?icon("Projects"):escapeHTML(Array.from(p.name.trim())[0]?.toUpperCase()||"?"))+'</span><span>'+escapeHTML(p.name)+'</span>'+(p.id===nav.projectFilter?'<span class="project-check">✓</span>':'')+'</button>').join("")+'<div class="project-menu-divider"></div><button class="project-option" data-open="project">+ Create project</button></div></details>';
 const group=groups.find(g=>g.pages.includes(nav.page))||groups[0];
 const link=(name:string)=>'<button class="nav '+(name===nav.page?'active':'')+'" data-page="'+escapeHTML(name)+'"><span class="nav-icon">'+icon(name)+'</span>'+escapeHTML(pageLabel(name))+'</button>';
 const knowledgeTabs=["Overview","Engineering DNA","Standards","Roles","Skills","Lessons","Sources","Import / Export"];
 const knowledgeTab=knowledgeTabs.includes(nav.tab)?nav.tab:"Overview";
 const knowledgeLink=(name:string)=>'<button class="nav '+(knowledgeTab===name?'active':'')+'" data-tab="'+escapeHTML(name)+'">'+escapeHTML(name)+'</button>';
 const teamTab=nav.tab==="Roles"||nav.tab==="Harnesses"?nav.tab:"Agents";
 const teamLink=(name:string)=>'<button class="nav '+(teamTab===name?'active':'')+'" data-tab="'+name+'"><span class="nav-icon">'+icon(name==="Agents"?"Team":name==="Roles"?"Knowledge":"Settings")+'</span>'+name+'</button>';
 const teamSidebar='<small style="display:block;opacity:.65;margin:14px 10px 6px">Agents</small>'+teamLink("Agents")+'<small style="display:block;opacity:.65;margin:20px 10px 6px">Resources</small>'+teamLink("Roles")+teamLink("Harnesses");
 const knowledgeSidebar='<small style="display:block;opacity:.65;margin:14px 10px 6px">Library</small>'+knowledgeTabs.slice(0,6).map(knowledgeLink).join('')+'<small style="display:block;opacity:.65;margin:20px 10px 6px">Management</small>'+knowledgeTabs.slice(6).map(knowledgeLink).join('');
 unmountWork();
 root.innerHTML='<div class="native-dragbar" aria-hidden="true"></div><div class="layout desktop-shell"><nav class="app-rail" aria-label="Primary navigation">'+projectAvatar+''+groups.map(g=>'<button class="rail-item '+(g===group?'active':'')+'" data-page="'+g.pages[0]+'" aria-label="'+g.name+'" aria-current="'+(g===group?"page":"false")+'">'+icon(g.name)+'<span>'+g.name+'</span></button>').join('')+'</nav><aside class="section-sidebar"><div class="section-heading">'+escapeHTML(group.name)+'</div>'+(group.name==='Chat'?[{id:"group",name:"Group"},...profiles(state)].map(a=>'<button class="nav chat-person '+(nav.page==="Chat"&&nav.detail==="agent:"+a.id?"active":"")+'" data-agent-chat="'+a.id+'"><span class="chat-avatar">'+escapeHTML(a.name[0])+'</span>'+escapeHTML(a.name)+'</button>').join('')+link('Collaboration')+issueChats.filter(c=>c.project===nav.projectFilter).map(c=>'<button class="nav '+(nav.detail===c.id?'active':'')+'" data-issue-chat="'+escapeHTML(c.id)+'"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escapeHTML(c.title)+'</span></button>').join(''):group.name==='Team'?teamSidebar:group.name==='Knowledge'?knowledgeSidebar:group.name==='Work'?'<button class="nav '+(nav.page==='Objectives'&&nav.tab!=='Backlog'?'active':'')+'" data-page="Objectives"><span class="nav-icon">'+icon('Objectives')+'</span> Working</button><button class="nav '+(nav.page==='Objectives'&&nav.tab==='Backlog'?'active':'')+'" data-board-view="Backlog"><span class="nav-icon">'+icon('Work')+'</span> Backlog</button>'+group.pages.filter(n=>n!=='Objectives').map(link).join(''):group.pages.map(link).join(''))+'<div class="sidebar-foot"><small>Native harnesses</small>'+["Claude","Codex"].map(n=>'<div class="harness-indicator"><i class="'+(agentStatus(n as "Claude"|"Codex").state==="Connected"?"online":"")+'"></i>'+n+'<span>'+escapeHTML(agentStatus(n as "Claude"|"Codex").state)+'</span></div>').join('')+'</div></aside><main class="'+(['Chat','Collaboration'].includes(nav.page)?'chat-page':nav.page==='Objectives'?'issues-page':'')+'"><div class="app-breadcrumb">'+escapeHTML(group.name)+'<span>/</span>'+escapeHTML(nav.page==='Chat'?(issueChats.find(c=>c.id===nav.detail)?.title||(nav.detail==='agent:group'?'Group':profiles(state).find(a=>'agent:'+a.id===nav.detail)?.name||'Chat')):group.name==='Team'?teamTab:group.name==='Knowledge'?knowledgeTab:pageLabel(nav.page))+''+(nav.page==="Objectives"?'':'<span class="preview-label">Preview data</span>')+'</div><div class="page-content">'+(nav.page==="Objectives"?'<div id="work-root"></div>':renderPage(ctx))+'</div>'+(nav.page==="Objectives"?'':'<footer>Demo objective data · Native harness diagnostics</footer>')+'</main></div>'+(nav.modal?renderDialog(ctx):'');
 if(nav.page==="Objectives") mountWork(root.querySelector<HTMLElement>("#work-root")!,ctx);
}

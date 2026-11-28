import { knowledgeDisplayName } from "../services/knowledge-source";
import type { ViewContext } from "../view-context";
import { escapeHTML as esc } from "../components/primitives";

const groups = ["Overview","Engineering DNA","Standards","Roles","Skills","Lessons","Sources","Import / Export"];
const descriptions: Record<string,string> = {
 "Engineering DNA":"Core principles shared by all agents.",
 Standards:"Engineering conventions and quality expectations.",
 Roles:"Responsibilities and role-specific knowledge.",
 Skills:"Reusable guidance for native agents.",
 Lessons:"Capture knowledge from previous work."
};
export function renderEngineeringDNA(ctx: ViewContext): string {
 const {state,nav}=ctx;
 const tab=groups.includes(nav.tab)?nav.tab:"Overview";
 const docs=Object.keys(state.knowledge);
 const pack=state.knowledgePack;
 const entries=pack?.entries??[];
 const selected=docs.includes(nav.docSelected)?nav.docSelected:docs[0];
 if(selected)nav.docSelected=selected;
 const btn=(label:string,attrs:string)=>`<button class="kn-btn" ${attrs}>${esc(label)}</button>`;
 const row=(name:string,desc:string,end="")=>`<div class="kn-row"><div><strong>${esc(name)}</strong><small>${esc(desc)}</small></div>${end}</div>`;
 const editor=selected?`<div class="kn-row"><div><strong>${esc(selected)}</strong><small>Local knowledge · Markdown</small></div></div><div class="kn-docs">${docs.map(d=>btn(d,`data-doc="${esc(d)}"`)).join("")}</div><textarea id="knowledge-editor" class="kn-editor">${esc(state.knowledge[selected])}</textarea><div class="kn-actions">${btn("Save changes",'data-save-knowledge="global"')}</div>`:"<p>No knowledge entries yet.</p>";
 const sourceDoc=(e:typeof entries[number])=>row(knowledgeDisplayName(e),[e.description?.trim(),(e.bytes/1024).toFixed(1)+" KB",e.load==="on-demand"?"On demand":e.load==="bootstrap"?"Bootstrap":""].filter(Boolean).join(" · "),btn("View",'data-knowledge-read="'+esc(e.id)+'"'));
 const sourceList=(kinds:string[])=>entries.filter(e=>kinds.includes(e.kind)).map(sourceDoc).join("");
 const documentViewer='<div class="kn-reader" data-knowledge-reader hidden><div class="kn-row"><div><strong data-knowledge-document-title></strong><small>Read-only file · Source: '+esc(pack?.id||"")+'</small></div></div><pre data-knowledge-document-body style="white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;font:12px/1.6 ui-monospace,monospace;max-height:400px;overflow:auto"></pre></div>';
 const connectPrompt=row("Engineering knowledge","Connect a GitHub ref or local checkout to browse real files.",btn("Connect source",'data-tab="Import / Export"'));
 let body="";
 if(tab==="Overview")body=`<h1>Knowledge</h1><p>Manage engineering knowledge across your agents.</p><section><h2>Knowledge library</h2><div class="kn-grid">${Object.entries(descriptions).map(([k,d])=>`<div class="kn-item"><strong>${esc(k)}</strong><p>${esc(d)}</p>${btn("Open",`data-tab="${esc(k)}"`)}</div>`).join("")}</div></section><section><h2>Knowledge packs</h2>${pack?row(pack.id,pack.version+" · "+pack.status+" · "+entries.length+" files",btn("Open",'data-tab="Standards"')):connectPrompt}${row("Local notes",docs.length+" demo documents",btn("View",'data-tab="Engineering DNA"'))}</section>`;
 else if(tab==="Engineering DNA")body='<h1>Engineering DNA</h1><p>'+esc(descriptions["Engineering DNA"])+'</p><section>'+(pack?sourceList(["engineering"])+documentViewer:editor)+'</section>';
 else if(tab==="Standards")body='<h1>Standards</h1><p>'+esc(descriptions.Standards)+'</p><section>'+(pack?sourceList(["standards"])+documentViewer:connectPrompt)+'</section>';
 else if(tab==="Roles")body='<h1>Roles</h1><p>'+esc(descriptions.Roles)+'</p><section>'+(pack?sourceList(["roles"])+documentViewer:Object.entries(state.roles).map(([k,v])=>row(k,v)).join(""))+'</section>';
 else if(tab==="Skills")body='<h1>Skills</h1><p>'+esc(descriptions.Skills)+'</p><section>'+(pack?sourceList(["skills"])+documentViewer:connectPrompt)+'</section>';
 else if(tab==="Lessons")body='<h1>Lessons</h1><p>Reusable lessons from engineering work.</p><section>'+(pack?sourceList(["lesson"])+documentViewer:'<p>No lessons recorded yet.</p>')+'</section>';
 else if(tab==="Sources")body='<h1>Sources</h1><p>References and knowledge provenance.</p><section>'+(pack?row("Knowledge pack",pack.id+" · "+pack.version+" · "+pack.status+" · "+pack.ref)+'<h2>References</h2>'+sourceList(["references"])+'<h2 style="margin-top:24px">Guides</h2>'+sourceList(["guides"])+documentViewer:'<p>No external sources imported yet.</p>')+'</section>';
 else body=`<h1>Import / Export</h1><p>Connect an engineering-knowledge repository using the native file adapter.</p><section>${pack?row("Connected source",pack.id+" · "+pack.ref+" · v"+pack.version+" · "+pack.status+" · "+entries.length+" documents"):""}${row("GitHub","anvh2/engineering-knowledge · uses your existing Git credentials",'<select id="knowledge-github-ref" class="kn-btn" aria-label="GitHub ref"><option value="main">main · v0.2.0 (draft)</option><option value="calibrate/go-backend-2026-11">PR #1 calibration · v0.3.0 (draft)</option></select> '+btn("Sync",'data-knowledge-sync'))}${row("Local checkout","Use an already-cloned engineering-knowledge directory (offline).",'<input id="knowledge-local-path" aria-label="Local repository path" placeholder="/Users/.../engineering-knowledge" style="max-width:250px;min-width:120px"> '+btn("Open",'data-knowledge-local'))}<p class="kn-muted" role="status" data-knowledge-source-status></p><p class="kn-muted">Draft documents remain preview-only until reviewed. Sync updates a managed cache, not your local checkout.</p></section>`;
 return `<style>
 .kn-page{display:flex;min-height:520px;gap:0;color:inherit;font-size:13px}.kn-page .kn-side{width:174px;flex:0 0 174px;border-right:1px solid rgba(128,128,128,.18);padding:12px 10px}.kn-page .kn-nav{display:block;width:100%;text-align:left;background:transparent;border:0;padding:7px 9px;border-radius:4px;color:inherit;font-size:12px}.kn-page .kn-nav.active,.kn-page .kn-nav:hover{background:rgba(128,128,128,.16)}.kn-page .kn-label{font-size:11px;opacity:.55;margin:20px 9px 8px}.kn-page .kn-main{flex:1;min-width:0;padding:24px 30px;max-width:1050px}.kn-page h1{font-size:20px;font-weight:550;margin:0 0 6px}.kn-page h2{font-size:14px;font-weight:550;margin:0 0 14px}.kn-page p,.kn-page small,.kn-page .kn-muted{font-size:12px;opacity:.65;line-height:1.6}.kn-page p{margin:4px 0 10px}.kn-page section{border-top:1px solid rgba(128,128,128,.18);margin-top:24px;padding:22px 0 0}.kn-page .kn-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 26px}.kn-page .kn-item{padding:8px 0 16px;border-bottom:1px solid rgba(128,128,128,.18)}.kn-page strong{font-weight:500}.kn-page .kn-btn{font-size:11px;padding:5px 9px;border:1px solid rgba(128,128,128,.25);border-radius:4px;background:rgba(128,128,128,.09);color:inherit}.kn-page .kn-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid rgba(128,128,128,.18)}.kn-page .kn-row small{display:block;margin-top:4px;white-space:pre-wrap}.kn-page .kn-docs{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.kn-page .kn-editor{width:100%;min-height:230px;resize:vertical;font-size:13px;line-height:1.7}.kn-page .kn-actions{text-align:right;margin-top:10px}
 @media(max-width:700px){.kn-page .kn-side{width:130px;flex-basis:130px}.kn-page .kn-main{padding:16px}.kn-page .kn-grid{grid-template-columns:1fr}}
 </style><div class="kn-page"><div class="kn-main">${body}</div></div>`;
}

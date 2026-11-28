import type { ViewContext } from "../view-context";
import { escapeHTML, action } from "./primitives";
export function renderDialog(ctx: ViewContext) {
  const {state,nav,projectOptions,roleOptions}=ctx;
  const {modal,projectFilter}=nav;
    let body="";
    if(modal==="objective") body=`<label>Project</label><select id="new-project">${projectOptions(projectFilter==="all"?state.projects[0]?.id:projectFilter)}</select><label>Name</label><input id="new-name"><label>Description</label><textarea id="new-description"></textarea><label>Acceptance criteria</label><textarea id="new-criteria"></textarea>${["Claude","Codex"].map((a)=>`<label>${a} role</label><select id="new-${a}">${roleOptions("Developer")}</select>`).join("")}`;
    else if(modal==="project")body='<label>Name</label><input id="new-name"><label>Description</label><textarea id="new-description"></textarea>';
    else if(modal==="repo")body=`<label>Existing repository</label><select id="new-repo"><option value="">Add local repository path</option>${state.repos.map((r)=>`<option value="${r.id}">${escapeHTML(r.name)}</option>`).join("")}</select><label>Local path</label><input id="new-name"><button data-project-browse-repo>Browse…</button>`;
    else body='<label>Name</label><input id="new-name">'+(modal==="role"?'<label>Base knowledge</label><textarea id="new-description"></textarea>':"");
    return `<div class="overlay"><div class="dialog"><h2>${escapeHTML("New "+modal)}</h2>${body}<div class="right space">${action("Cancel","data-cancel")}${action("Save","data-create",true)}</div></div></div>`;
  }

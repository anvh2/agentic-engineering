import type { ViewContext } from "../view-context";
import { escapeHTML } from "./primitives";
import { renderPage } from "../pages";
import { renderDialog } from "./dialog";
  const pages=["Overview","Projects","Objectives","Collaboration","Sessions","Decisions","Engineering DNA","Team","Usage & Cost","Settings"];
  const icons=["▦","▱","◎","▤","⌘","▧","◇","♧","▥","⚙"];
export function renderLayout(root: HTMLElement, ctx: ViewContext) {
  const {nav,projectOptions}=ctx;
  const {page,projectFilter,modal}=nav;
    root.innerHTML=`<div class="layout"><aside><div class="brand"><span class="logo">ae</span><b>Agentic<br>Engineering</b></div><select id="project-filter">${projectOptions(projectFilter,true)}</select>${pages.map((name,index)=>`${index===0||index===6?`<div class="nav-title">${index===0?"WORKSPACE":"ENGINEERING"}</div>`:""}<button class="nav ${name===page?"active":""}" data-page="${escapeHTML(name)}"><span class="nav-icon">${icons[index]}</span>${escapeHTML(name)}</button>`).join("")}<div class="sidebar-foot">RUNTIMES · NOT CONNECTED<br>Claude Code · Codex</div></aside><main>${renderPage(ctx)}<footer>Agentic Engineering v2 · UI demo · No agent processes started</footer></main></div>${modal?renderDialog(ctx):""}`;
  }

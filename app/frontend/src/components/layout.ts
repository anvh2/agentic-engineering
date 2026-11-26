import { agentStatus } from "../services/agent-connection";
import type { ViewContext } from "../view-context";
import { escapeHTML } from "./primitives";
import { renderPage } from "../pages";
import { renderDialog } from "./dialog";
  const pages=["Overview","Projects","Objectives","Collaboration","Chat","Sessions","Decisions","Engineering DNA","Team","Usage & Cost","Settings"];
  const icons=["▦","▱","◎","▤","◉","⌘","▧","◇","♧","▥","⚙"];
export function renderLayout(root: HTMLElement, ctx: ViewContext) {
  const {nav,projectOptions}=ctx;
  const {page,projectFilter,modal}=nav;
    root.innerHTML=`<div class="layout"><aside><div class="brand"><span class="logo">ae</span><b>Agentic<br>Engineering</b></div><select id="project-filter">${projectOptions(projectFilter,true)}</select>${pages.map((name,index)=>`${index===0||index===7?`<div class="nav-title">${index===0?"WORKSPACE":"ENGINEERING"}</div>`:""}<button class="nav ${name===page?"active":""}" data-page="${escapeHTML(name)}"><span class="nav-icon">${icons[index]}</span>${escapeHTML(name==="Objectives"?"Work":name)}</button>`).join("")}<div class="sidebar-foot">HARNESSES · NATIVE CLI<br>Claude: ${escapeHTML(agentStatus("Claude").state)}<br>Codex: ${escapeHTML(agentStatus("Codex").state)}</div></aside><main>${renderPage(ctx)}<footer>Agentic Engineering v2 · Demo objective data · Native harness diagnostics and test console</footer></main></div>${modal?renderDialog(ctx):""}`;
  }

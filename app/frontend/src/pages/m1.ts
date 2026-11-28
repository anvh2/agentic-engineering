import type {ViewContext} from "../view-context";
import {escapeHTML as e} from "../components/primitives";
import {m1} from "../services/m1-runtime";

const val=(v:unknown)=>e(String(v??""));
export function renderM1(_ctx:ViewContext):string {
 const snapshot=m1.snapshot;
 const active=m1.running;
 const header=`<header class="issues-toolbar"><strong>M1 · Collaboration runtime</strong><small>Core / MCP / native Claude & Codex</small></header>`;
 const error=m1.error?`<p role="alert" style="color:var(--danger, #cc7777)">${val(m1.error)}</p>`:"";
 const note='<p class="note">Real execution (not preview data). Native permissions remain active. Agents may submit, but only the Director accepts after independent verification.</p>';
 const setup=`<section class="panel" style="max-width:960px;padding:16px;display:grid;gap:10px">
  <h3>New objective</h3>
  <label>Repository root <input id="m1-repo" placeholder="/Users/you/projects/repo" value="${val(m1.repository)}"></label>
  <label>Title <input id="m1-title" value="M1 live vertical slice"></label>
  <label>Description <textarea id="m1-description" rows="2" placeholder="What should the team implement?"></textarea></label>
  <label>Acceptance criteria <textarea id="m1-criteria" rows="2" placeholder="Objective, verifiable acceptance criteria"></textarea></label>
  <label>Tasks (one per line) <textarea id="m1-tasks" rows="3">Implement requested change
Verify code and tests
Independent code review</textarea></label>
  <div style="display:flex;flex-wrap:wrap;gap:12px">
   <label>Developer <select id="m1-developer"><option>Claude</option><option selected>Codex</option></select></label>
   <label>Reviewer <select id="m1-reviewer"><option selected>Claude</option><option>Codex</option></select></label>
   <label>Automatic wake budget <input id="m1-wake" type="number" min="0" max="20" value="0" style="max-width:90px"></label>
  </div>
  <div><button data-m1-create class="primary" ${m1.busy?'disabled':''}>Create isolated objective</button></div>
  </section>`;
 if(!snapshot)return `<section class="board-shell">${header}${error}${note}${setup}</section>`;
 const participants=snapshot.participants.map(p=>{
   const report=m1.reports[p.id];
   const run=active===p.id;
   const usage=report?.usage?.length?report.usage.map(u=>{
      const input=(u.uncached_input??0)+(u.cache_read??0)+(u.cache_write??0);
      return `${val(u.provider)} · input ${val(input)} · output ${val(u.output??"not reported")} · cost ${u.cost_usd_estimate==null?"unknown":'$'+val(u.cost_usd_estimate)} (API-equivalent)`;
   }).join(" | "):"Usage not yet reported";
   return `<article class="panel" style="padding:16px;min-width:0">
    <h3>${val(p.handle)} <small>${val(p.agent)} / ${val(p.role)}</small></h3>
    <small style="overflow-wrap:anywhere">Worktree: ${val(p.workdir)}</small>
    <label>Task prompt<textarea rows="3" id="m1-prompt-${val(p.id)}" placeholder="Use get_objective, claim_task, implement/review and send your handoff."></textarea></label>
    <div style="display:flex;gap:8px"><button class="primary" data-m1-run="${val(p.id)}" ${active?'disabled':''}>Run ${val(p.role)}</button>${run?'<button data-m1-stop>Cancel</button>':''}</div>
    ${run?`<p role="status">Running native turn · <span data-m1-events>${m1.eventCount}</span> events</p>`:""}
    ${report?`<div class="line"><strong>${val(report.state)}</strong><p>${val(report.error??"")}</p>
      <p style="white-space:pre-wrap;overflow-wrap:anywhere">${val(report.finalText)}</p>
      <small>${usage}</small>
      <small style="display:block;overflow-wrap:anywhere">Native events: ${val(report.evidencePath)} · SHA-256 ${val(report.evidenceSha256)}</small>
      <small style="display:block;overflow-wrap:anywhere">Git head: ${val(report.gitHead??"unknown")} · patch: ${val(report.diffPath??"unavailable")} · SHA-256 ${val(report.diffSha256??"")}</small>
      ${report.gitStatus?`<details><summary>Worktree changes</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${val(report.gitStatus)}</pre></details>`:""}
      ${report.gitEvidenceError?`<p role="status">Git evidence unavailable: ${val(report.gitEvidenceError)}</p>`:""}</div>`:""}
   </article>`;
 }).join("");
 const tasks=snapshot.objective.tasks.map(task=>`<article class="line">
  <strong>${val(task.title)}</strong> <small>${val(task.status)} · revision ${task.revision} · ${val(task.owner??"unclaimed")}</small>
  <p style="white-space:pre-wrap">${val(task.summary??"")}</p>
  ${task.status==="submitted"?`<section style="display:grid;gap:6px">
   <label>Test/build evidence <input id="m1-test-${val(task.id)}" placeholder="Test command, result, commit or log path"></label>
   <label>Independent reviewer evidence <input id="m1-review-${val(task.id)}" placeholder="Reviewer handle, finding and review artifact"></label>
   <label>Director decision <input id="m1-note-${val(task.id)}" placeholder="Explicit acceptance / rejection note"></label>
   <div><button data-m1-verdict="${val(task.id)}" data-m1-accepted="true">Accept</button>
   <button data-m1-verdict="${val(task.id)}" data-m1-accepted="false">Request revision</button></div>
   </section>`:""}
  </article>`).join("");
 const messages=snapshot.messages.length?snapshot.messages.map(msg=>`<div class="line">
   <small>${val(msg.seq)} · ${val(msg.from)} → ${val(msg.to||"all")}</small>
   <p style="white-space:pre-wrap;overflow-wrap:anywhere">${val(msg.body)}</p></div>`).join(""):"<p class=\"muted\">No collaboration messages yet.</p>";
 return `<section class="board-shell">${header}${error}${note}
  <div class="between" style="gap:12px"><h3>${val(snapshot.objective.title)}</h3><button data-m1-refresh>Refresh evidence</button></div>
  <p>${val(snapshot.objective.acceptance_criteria)}</p>
  <label>Engineering Knowledge v1.0.0 root <input id="m1-knowledge" placeholder="/Users/you/.../engineering-knowledge" value="${val(m1.knowledgeRoot)}"></label>
  <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px">${participants}</section>
  <section class="panel" style="padding:16px"><h3>Task board / Director acceptance</h3>${tasks}</section>
  <section class="panel" style="padding:16px"><h3>Collaboration messages</h3>
  ${messages}
  <div style="display:grid;gap:6px"><label>Recipient
   <select id="m1-recipient"><option value="">Everyone</option>${snapshot.participants.map(p=>`<option value="${val(p.handle)}">${val(p.handle)}</option>`).join("")}</select></label>
   <textarea id="m1-message" rows="2" placeholder="Director instruction or feedback"></textarea>
   <div><button data-m1-send>Send</button></div></div>
  </section>
  <details><summary>Start another objective</summary>${setup}</details>
 </section>`;
}

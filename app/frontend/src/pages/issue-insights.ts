import {escapeHTML as e} from "../components/primitives";
import {allExecutions,money,tokens,totals} from "../services/issue-runtime";

const safe=(x:unknown)=>e(String(x??""));
const rows=()=>allExecutions().flatMap(x=>(x.runs??[]).map(run=>({issue:x.issueKey||x.issueId,run})));

export function renderRunTimeline():string {
 const runs=rows();
 const body=runs.map(({issue,run})=>`<tr><td>${safe(issue)}</td><td>${safe(run.agentName)}<small>${safe(run.harness)} · ${safe(run.duty)}</small></td>
   <td>${safe(run.purpose)}</td><td>${safe(run.state)}</td><td>${safe(run.startedAt)}</td><td>${safe(run.toolFailures)}</td>
   <td><small style="overflow-wrap:anywhere">${safe(run.evidencePath||"Unavailable")}</small></td></tr>`).join("");
 return `<section class="panel"><h3>Native issue runs <small>${runs.length} since the app started</small></h3>
   ${runs.length?`<div class="overflow"><table><thead><tr><th>Issue</th><th>Agent</th><th>Purpose</th><th>State</th><th>Started</th><th>MCP failures</th><th>Evidence</th></tr></thead><tbody>${body}</tbody></table></div>`:'<p>No native runs yet. Move a Working issue to In Progress.</p>'}
   </section>`;
}

export function renderRunUsage():string {
 const runs=rows();
 const sum=totals(runs.map(r=>r.run));
 const body=runs.flatMap(({issue,run})=>(run.usage??[]).map(u=>`<tr><td>${safe(issue)}</td><td>${safe(run.agentName)}</td><td>${safe(run.harness)}</td>
   <td>${safe(u.model||"Unavailable")}</td><td>${safe(tokens(u.inputTokens))}</td><td>${safe(tokens(u.cacheRead))}</td>
   <td>${safe(tokens(u.outputTokens))}</td><td>${safe(money(u.costUsd))}</td></tr>`)).join("");
 return `<section class="panel"><h3>Native issue usage</h3>
   <div class="metrics"><div class="metric"><small>Reported input</small><strong>${safe(tokens(sum.input))}</strong></div>
   <div class="metric"><small>Reported output</small><strong>${safe(tokens(sum.output))}</strong></div>
   <div class="metric"><small>Reported cost estimate</small><strong>${safe(money(sum.cost))}</strong></div></div>
   ${body?`<div class="overflow"><table><thead><tr><th>Issue</th><th>Agent</th><th>Harness</th><th>Model</th><th>Input</th><th>Cache read</th><th>Output</th><th>Estimated USD</th></tr></thead><tbody>${body}</tbody></table></div>`:'<p>No provider-reported usage yet.</p>'}
   <p class="note">Only provider-reported values are summed; ${sum.costRuns} of ${sum.runs} runs report a cost estimate. Estimates are not subscription billing.</p>
   </section>`;
}

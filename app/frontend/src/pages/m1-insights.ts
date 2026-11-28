import {escapeHTML as e} from "../components/primitives";
import {m1} from "../services/m1-runtime";

const safe=(x:unknown)=>e(String(x??""));
export function renderM1TurnTimeline():string {
 const turns=m1.snapshot?.turns??[];
 if(!m1.objectiveID)return '<section class="panel"><h3>Live M1 executions</h3><p>Create an objective in Work → M1 Runtime to see persisted native turns.</p></section>';
 const rows=turns.map(t=>`<tr><td>${safe(t.turnId)}</td><td>${safe(t.handle)}<small>${safe(t.role)}</small></td>
   <td>${safe(t.trigger)}</td><td>${safe(t.state)}</td>
   <td>${safe(t.startedAt)}</td><td>${safe(t.toolFailures)}</td>
   <td><small style="overflow-wrap:anywhere">${safe(t.logPath)}</small></td></tr>`).join("");
 return `<section class="panel"><h3>Live M1 executions <small>${turns.length} persisted turns</small></h3>
   <p class="note">SQLite-backed sessions; immutable event logs are stored on disk. An interrupted turn is not a successful one.</p>
   ${turns.length?`<div class="overflow"><table><thead><tr><th>Turn</th><th>Agent / role</th><th>Trigger</th><th>State</th><th>Started</th><th>MCP failures</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p>No native turns have been executed yet.</p>'}
   </section>`;
}

export function renderM1UsageSummary():string {
 const turns=m1.snapshot?.turns??[];
 const records=turns.flatMap(t=>t.usage.map(u=>({turn:t,usage:u})));
 const total=(key:"uncachedInput"|"cacheRead"|"cacheWrite"|"output")=>
   records.reduce((acc,x)=>acc+(x.usage[key]??0),0);
 const recorded=records.filter(x=>x.usage.costUsd!==null);
 const estimate=recorded.reduce((acc,x)=>acc+(x.usage.costUsd??0),0);
 const rows=records.map(x=>`<tr><td>${safe(x.turn.handle)}</td><td>${safe(x.usage.provider)}</td>
   <td>${safe(x.usage.model||"not reported")}</td>
   <td>${safe(x.usage.uncachedInput??"unknown")}</td>
   <td>${safe(x.usage.cacheRead??"unknown")}</td>
   <td>${safe(x.usage.output??"unknown")}</td>
   <td>${x.usage.costUsd===null?"unknown":"$"+safe(x.usage.costUsd)}</td></tr>`).join("");
 return `<section class="panel"><h3>Live M1 usage · ${safe(m1.objectiveID||"no objective")}</h3>
   <div class="metrics"><div class="metric"><small>Reported non-cached input</small><strong>${total("uncachedInput").toLocaleString()}</strong></div>
   <div class="metric"><small>Reported cache reads</small><strong>${total("cacheRead").toLocaleString()}</strong></div>
   <div class="metric"><small>Reported output</small><strong>${total("output").toLocaleString()}</strong></div>
   <div class="metric"><small>Known API-equivalent estimates</small><strong>$${estimate.toFixed(4)}</strong></div></div>
   ${records.length?`<div class="overflow"><table><thead><tr><th>Participant</th><th>Provider</th><th>Model</th><th>Uncached input</th><th>Cache read</th><th>Output</th><th>Estimated USD</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p>No provider-reported usage yet.</p>'}
   <p class="note">Totals include only reported counters. Missing values are unknown, not zero. Estimates are not subscription billing. ${recorded.length}/${records.length} records report a cost estimate.</p>
   </section>`;
}

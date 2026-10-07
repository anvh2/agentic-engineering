// Read-only measurement over recorded harness evidence. Writes nothing outside the scratchpad.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const ROOT = '/Users/anvh/go/src/github.com/anvh2/harness-engineering/.workdir';
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const stats = (xs) => xs.length ? { n: xs.length, p50: Math.round(pct(xs, 50)), p90: Math.round(pct(xs, 90)), max: Math.round(Math.max(...xs)), mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) } : { n: 0 };
const s = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`);
const traces = walk(ROOT).filter((p) => p.endsWith('trace.jsonl'));
const groups = {};
for (const file of traces) {
  const src = relative(ROOT, file).split('/')[0];
  const ev = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!ev.length) continue;
  const t = (e) => Date.parse(e.ts);
  const end = ev.find((e) => e.type === 'task_passed' || e.type === 'task_failed');
  const g = (groups[src] ??= { runs: 0, finished: 0, passed: 0, taskMs: [], modelMs: [], modelErr: 0, verifyMs: [], formatMs: [], attempts: [], codingRetries: 0, runtimeRetries: 0, modelTotal: 0, verifyTotal: 0, wallTotal: 0, tokensOut: [], firstPass: 0 });
  g.runs++;
  // pair model_started -> model_finished in order
  let open = null;
  for (const e of ev) {
    if (e.type === 'model_started') open = t(e);
    if (e.type === 'model_finished') { const d = e.data?.durationMs ?? (open ? t(e) - open : null); if (d != null) { g.modelMs.push(d); g.modelTotal += d; } if (e.data?.error) g.modelErr++; if (e.data?.outputTokens) g.tokensOut.push(e.data.outputTokens); open = null; }
    if (e.type === 'verification_finished' && e.data?.phase === 'verify' && e.data?.durationMs != null) { g.verifyMs.push(e.data.durationMs); g.verifyTotal += e.data.durationMs; }
    if (e.type === 'coding_retry') g.codingRetries++;
    if (e.type === 'runtime_retry') g.runtimeRetries++;
  }
  // verification without durationMs (older traces): pair started/finished
  if (!ev.some((e) => e.type === 'verification_finished' && e.data?.durationMs != null)) {
    let vs = null;
    for (const e of ev) { if (e.type === 'verification_started' && e.data?.phase === 'verify') vs = t(e); if (e.type === 'verification_finished' && e.data?.phase === 'verify' && vs) { g.verifyMs.push(t(e) - vs); g.verifyTotal += t(e) - vs; vs = null; } }
  }
  if (end) {
    g.finished++;
    const dur = end.data?.durationMs ?? t(end) - t(ev[0]);
    g.taskMs.push(dur); g.wallTotal += dur;
    g.attempts.push(end.data?.attempts ?? 0);
    if (end.type === 'task_passed') { g.passed++; if ((end.data?.attempts ?? 0) === 1) g.firstPass++; }
  }
}
console.log('## Per-run harness traces (', traces.length, 'trace files )');
for (const [src, g] of Object.entries(groups)) {
  console.log(`\n### ${src}: runs=${g.runs} finished=${g.finished} passed=${g.passed} (first-attempt pass ${g.firstPass}) unfinished(killed)=${g.runs - g.finished}`);
  console.log('  task latency      ', JSON.stringify(Object.fromEntries(Object.entries(stats(g.taskMs)).map(([k, v]) => [k, k === 'n' ? v : s(v)]))));
  console.log('  model call        ', JSON.stringify(Object.fromEntries(Object.entries(stats(g.modelMs)).map(([k, v]) => [k, k === 'n' ? v : s(v)]))), 'errors', g.modelErr);
  console.log('  verification      ', JSON.stringify(Object.fromEntries(Object.entries(stats(g.verifyMs)).map(([k, v]) => [k, k === 'n' ? v : s(v)]))));
  console.log('  attempts/finished ', JSON.stringify(stats(g.attempts)), ' coding retries', g.codingRetries, ' runtime retries', g.runtimeRetries, ` (${(g.runtimeRetries / Math.max(1, g.modelMs.length) * 100).toFixed(0)}% of model calls)`);
  console.log(`  time share: model ${(g.modelTotal / Math.max(1, g.wallTotal) * 100).toFixed(0)}% | verification ${(g.verifyTotal / Math.max(1, g.wallTotal) * 100).toFixed(1)}% | other ${(100 - (g.modelTotal + g.verifyTotal) / Math.max(1, g.wallTotal) * 100).toFixed(1)}%  (of finished-run wall time ${s(g.wallTotal)})`);
  if (g.tokensOut.length) console.log('  output tokens/call', JSON.stringify(stats(g.tokensOut)));
}

// Scheduler DB (read-only)
const db = new DatabaseSync(join(ROOT, 'scheduler/scheduler.db'), { readOnly: true });
console.log('\n## Scheduler DB (read-only)');
console.log(db.prepare("select state, count(*) n, sum(claims) claims, sum(attempts) attempts, sum(coding_ms) coding_ms from tasks group by state").all());
console.log('reviews', db.prepare("select decision, count(*) n from reviews group by decision").all());
console.log('failure categories', db.prepare("select failure_category c, count(*) n from tasks where failure_category is not null group by 1").all());
const ev = db.prepare("select task_id, at, from_state, to_state, actor, reason from events order by seq").all();
console.log('events', ev.length, 'from', new Date(ev[0]?.at).toISOString(), 'to', new Date(ev.at(-1)?.at).toISOString());
const reaps = ev.filter((e) => /lease expired|lease stolen/.test(e.reason ?? ''));
console.log('lease-expiry / steal requeues:', reaps.length);

// lead-batch event logs
console.log('\n## lead-batch events');
for (const b of readdirSync(join(ROOT, 'batches'))) {
  const f = join(ROOT, 'batches', b, 'events.jsonl'); if (!existsSync(f)) continue;
  const es = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const tos = es.filter((e) => e.to).reduce((m, e) => ((m[e.to] = (m[e.to] ?? 0) + 1), m), {});
  const runStart = {}; const lat = [];
  for (const e of es) { if (e.to === 'RUNNING') runStart[e.taskId] = Date.parse(e.ts); else if (e.taskId && runStart[e.taskId] && ['WORKER_PASS', 'REVIEW_REJECTED', 'RUNTIME_FAILURE', 'ESCALATED'].includes(e.to)) { lat.push(Date.parse(e.ts) - runStart[e.taskId]); delete runStart[e.taskId]; } }
  const span = Date.parse(es.at(-1).ts) - Date.parse(es[0].ts);
  console.log(b, JSON.stringify(tos), 'span', s(span), 'dispatch->outcome', JSON.stringify(Object.fromEntries(Object.entries(stats(lat)).map(([k, v]) => [k, k === 'n' ? v : s(v)]))));
}

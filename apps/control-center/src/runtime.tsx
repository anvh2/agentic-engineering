import { useEffect, useState } from 'react';
import type { RuntimeView } from '../../../src/integrations/control-center/runtime-view.ts';
import type { ViewState } from './view-state.ts';

/**
 * The runtime as it actually ran: the project and its target repository, GitHub issues as last synchronized, objectives with
 * their task DAG, the Engineering Lead, and the agent PROCESSES the runtime spawned, with live state taken only from their own
 * recorded events (UNKNOWN when the evidence is stale). Read-only; nothing here starts, stops or approves anything.
 */

const LIVE_LABEL: Record<string, string> = {
  SPAWNING: 'Spawning', PROCESS_ALIVE: 'Process alive', WAITING_FOR_MODEL_PERMIT: 'Waiting for model permit', MODEL_INFERENCE: 'Model inference',
  TOOL_EXECUTION: 'Tool execution', VERIFICATION: 'Verification', COMPLETED: 'Completed', FAILED: 'Failed', CANCELLED: 'Cancelled',
  TIMED_OUT: 'Timed out', SUPERSEDED: 'Superseded', LOST: 'Lost', SPAWN_FAILED: 'Spawn failed', UNKNOWN: 'UNKNOWN',
};
const ms = (v: number | null | undefined) => (v === null || v === undefined ? 'UNKNOWN' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);
const when = (v: number | null | undefined) => (v ? new Date(v).toLocaleTimeString() : '—');
const rate = (v: number | null | undefined) => (v === null || v === undefined ? 'UNKNOWN' : `${Math.round(v * 100)}%`);

export function RuntimePanel({ apiBase, view }: { apiBase: string; view: ViewState }) {
  const [data, setData] = useState<RuntimeView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const q = new URLSearchParams();
    if (view.project) q.set('project', view.project);
    if (view.objective) q.set('objectiveId', view.objective);
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/runtime?${q}`, { signal: abort.signal });
        if (!response.ok) throw new Error();
        const next = (await response.json()) as RuntimeView;
        if (!abort.signal.aborted) { setData(next); setFailed(false); }
      } catch { if (!abort.signal.aborted) setFailed(true); }
      if (!abort.signal.aborted) timer = setTimeout(load, 2_000);
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [apiBase, view.project, view.objective]);

  if (failed) return <p role="alert" className="notice">Runtime view unavailable. Agent state is UNKNOWN. Retrying automatically.</p>;
  if (!data) return null;
  const m = data.metrics;
  return <section className="panel runtime-panel" aria-label="Runtime">
    <div className="panel-heading">
      <h2>Runtime <span className="count">{data.agents.length} agent process{data.agents.length === 1 ? '' : 'es'}</span></h2>
      <span className="badge">{data.source === 'connected' ? 'FROM RUNTIME RECORDS' : 'DISCONNECTED'}</span>
    </div>

    <h3>Project and target repository</h3>
    {data.projects.length === 0 ? <p className="empty">No registered project in this scope.</p> : <div className="table-scroll"><table className="agent-table"><thead><tr><th>Project</th><th>Repository identity</th><th>Canonical root</th><th>Worktrees</th><th>GitHub</th></tr></thead><tbody>
      {data.projects.map((p) => <tr key={p.projectId}><td><strong>{p.projectId}</strong>{p.isFramework && <span className="badge">FRAMEWORK REPO</span>}</td><td><code>{p.repositoryId}</code></td><td><code>{p.canonicalRoot}</code></td><td><code>{p.worktreeRoot}</code></td><td>{p.githubRepo ?? 'none'}</td></tr>)}
    </tbody></table></div>}

    <h3>Agent organization</h3>
    <div className="table-scroll"><table className="agent-table">
      <thead><tr><th>Agent</th><th>Role · model</th><th>Live state</th><th>Task · worktree</th><th>Permit wait / inference</th><th>Tools · tokens in/out</th><th>Exit</th><th>Evidence</th></tr></thead>
      <tbody>
        <tr><td><strong>{data.lead.identity}</strong><br /><small className="muted">not a spawned process</small></td><td>Engineering Lead</td><td><span className="badge">NOT SUPERVISED BY THE RUNTIME</span></td><td>{data.lead.plannedObjectives} objective(s) planned</td><td>—</td><td>{data.lead.reviewDecisions} review decision(s)</td><td>—</td><td className="muted">last recorded {when(data.lead.lastActivityAt)}</td></tr>
        {data.agents.length === 0 && <tr><td colSpan={8} className="muted">No agent process has been spawned in this scope. Logical worker slots and model permits are not agents.</td></tr>}
        {data.agents.map((a) => <tr key={a.executionId}>
          <td><strong>{a.agentId}</strong><br /><small><code>{a.executionId}</code> · pid {a.pid ?? '—'}</small></td>
          <td>{a.role}<br /><small>assigned {a.assignedModel ?? 'UNKNOWN (provider chooses)'} · reported <strong>{a.reportedModel ?? 'UNKNOWN'}</strong></small></td>
          <td><span className={`badge live-${a.liveState.toLowerCase()}`}>{LIVE_LABEL[a.liveState] ?? a.liveState}</span>{a.liveDetail && <><br /><small className="muted">{a.liveDetail}</small></>}</td>
          <td>{a.taskId}<br /><small><code>{a.worktree}</code></small></td>
          <td>{ms(a.permitWaitMs)} / {ms(a.inferenceMs)}</td>
          <td>{a.toolCalls} · {a.inputTokens ?? 'UNKNOWN'}/{a.outputTokens ?? 'UNKNOWN'}</td>
          <td>{a.outcome ?? a.status}{a.exitCode !== null && <small> (exit {a.exitCode})</small>}{a.failure && <><br /><small className="muted">{a.failure}</small></>}</td>
          <td>{a.traceUrl ? <a href={a.traceUrl} target="_top">Mastra run ↗</a> : 'no run'}<br /><small><code>{a.logPath ?? '—'}</code></small></td>
        </tr>)}
      </tbody>
    </table></div>

    <h3>Objectives and task DAG</h3>
    {data.objectives.length === 0 && <p className="empty">No objective in this scope.</p>}
    {data.objectives.map((o) => <div key={o.id} className="runtime-objective">
      <p><strong>{o.id}</strong> · project {o.project} · lifecycle <span className="badge">{o.lifecycle?.phase ?? 'NOT PINNED'}</span> · {o.progress.done}/{o.progress.total} done, {o.progress.inFlight} in flight, {o.progress.waiting} waiting, {o.progress.failed} failed{o.issues.length > 0 && <> · issues {o.issues.map((n) => `#${n}`).join(', ')}</>}</p>
      <p className="muted">Target {o.target ? <><code>{o.target.repositoryId}</code>, worktrees in <code>{o.target.worktreeRoot}</code></> : 'not recorded (batch created before target identities)'}</p>
      <div className="table-scroll"><table className="agent-table">
        <thead><tr><th>Task</th><th>State</th><th>Depends on · blocked by</th><th>Routed model</th><th>Worktree · branch</th><th>Verifier · review · integration</th><th>Trace</th></tr></thead>
        <tbody>{o.tasks.map((t) => <tr key={t.id}>
          <td><strong>{t.id}</strong><br /><small>{t.title}</small></td>
          <td><span className="badge">{t.state}</span>{t.failureCategory && <><br /><small className="muted">{t.failureCategory}</small></>}</td>
          <td>{t.dependsOn.join(', ') || '—'}{t.blockedBy.length > 0 && <><br /><small>waiting on {t.blockedBy.join(', ')}</small></>}</td>
          <td>{t.routedModel ?? (t.executor === 'claude' ? 'Lead-owned' : 'not routed')}{t.routingReason && <><br /><small className="muted">{t.routingReason}</small></>}</td>
          <td><small><code>{t.worktree ?? '—'}</code><br />{t.branch ?? ''}</small></td>
          <td>exit {t.verifierExitCode ?? '—'} · {t.reviewOutcome ?? 'no decision'} · {t.integratedCommit ? <code>{t.integratedCommit.slice(0, 10)}</code> : 'not integrated'}</td>
          <td>{t.traceUrl ? <a href={t.traceUrl} target="_top">run ↗</a> : '—'}</td>
        </tr>)}</tbody>
      </table></div>
    </div>)}

    {m && <>
      <h3>Is the architecture working?</h3>
      <dl className="runtime-metrics">
        <div><dt>Agents spawned / logical claims</dt><dd>{m.agentsSpawned} / {m.logicalClaims}</dd></div>
        <div><dt>Spawn success</dt><dd>{rate(m.agentSpawnSuccessRate)}</dd></div>
        <div><dt>Task acceptance</dt><dd>{rate(m.workerTaskAcceptanceRate)}</dd></div>
        <div><dt>First-pass acceptance</dt><dd>{rate(m.firstPassAcceptanceRate)}</dd></div>
        <div><dt>Retry / escalation</dt><dd>{rate(m.retryRate)} / {rate(m.escalationRate)}</dd></div>
        <div><dt>Permit wait / inference</dt><dd>{ms(m.permitWaitMs)} / {ms(m.inferenceMs)}</dd></div>
        <div><dt>Human interventions</dt><dd>{m.humanInterventions} ({rate(m.humanInterventionRate)})</dd></div>
        <div><dt>Worktrees created / still present</dt><dd>{m.worktrees.created} / {m.worktrees.stillPresent}</dd></div>
        <div><dt>Model identity reported / unknown</dt><dd>{m.executionsByEvidence.providerReportedModel} / {m.executionsByEvidence.modelUnknown}</dd></div>
      </dl>
      {m.models.length > 0 && <p className="muted">Models: {m.models.map((x) => `${x.assignedModel} ×${x.executions} (reported ${x.reportedModels.join(', ') || 'UNKNOWN'}; ${ms(x.inferenceMs)}; cost ${x.costUsd === null ? 'UNKNOWN' : `$${x.costUsd}`})`).join(' · ')}</p>}
      {m.failureTaxonomy.length > 0 && <p className="muted">Failures: {m.failureTaxonomy.map((f) => `${f.category} ×${f.count}`).join(' · ')}</p>}
    </>}

    <h3>Agent lifecycle events</h3>
    {data.agentEvents.length === 0 ? <p className="empty">No agent events in this scope.</p> : <div className="table-scroll"><table className="agent-table"><thead><tr><th>Time</th><th>Execution</th><th>Event</th><th>Detail</th></tr></thead><tbody>
      {data.agentEvents.slice(-60).map((e) => <tr key={e.seq}><td>{when(e.at)}</td><td><code>{e.executionId}</code></td><td>{e.type}</td><td><small><code>{e.detail ? JSON.stringify(e.detail).slice(0, 160) : ''}</code></small></td></tr>)}
    </tbody></table></div>}

    <h3>GitHub issues <span className="count">{data.issues.length}</span></h3>
    {data.issues.length === 0 ? <p className="empty">No synchronized issues in this scope.</p> : <div className="table-scroll"><table className="agent-table"><thead><tr><th>Issue</th><th>State</th><th>Objectives</th><th>Synced</th></tr></thead><tbody>
      {data.issues.map((i) => <tr key={i.number}><td><a href={i.url} target="_blank" rel="noreferrer">#{i.number}</a> {i.title}</td><td>{i.state}</td><td>{i.linkedObjectives.join(', ') || '—'}</td><td>{when(i.syncedAt)}</td></tr>)}
    </tbody></table></div>}

    {data.limitations.length > 0 && <ul className="muted">{data.limitations.map((l) => <li key={l}>{l}</li>)}</ul>}
  </section>;
}

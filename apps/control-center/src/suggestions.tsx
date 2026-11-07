import { useEffect, useState } from 'react';
import { inScope, type ViewState } from './view-state.ts';
import { MEETING_TYPE_LABEL, orderSuggestions, suggestionsSchema, type Suggestions } from './suggestions-model.ts';

/**
 * Meetings the lifecycle SUGGESTED after technical escalations. Not meetings: nothing was opened and nobody met. Shown in its own
 * panel with that said plainly; the Engineering Lead or an operator accepts one by opening a real meeting, or dismisses it.
 */
export function SuggestedMeetings({ apiBase, view }: { apiBase: string; view: ViewState }) {
  const [data, setData] = useState<Suggestions | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/meeting-suggestions`, { signal: abort.signal });
        if (!response.ok) throw new Error();
        const next = suggestionsSchema.parse(await response.json());
        if (!abort.signal.aborted) { setData(next); setFailed(false); }
      } catch { if (!abort.signal.aborted) setFailed(true); }
      if (!abort.signal.aborted) timer = setTimeout(load, 10_000);
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [apiBase]);
  if (failed) return <p role="alert" className="notice">Meeting suggestions unavailable. Retrying automatically.</p>;
  if (data?.availability === 'CORRUPT') return <section className="panel" aria-label="Suggested meetings"><div className="panel-heading"><h2>Suggested meetings</h2><span className="badge">INTEGRITY FAILURE</span></div><p role="alert" className="notice">{data.reason}</p></section>;
  if (!data || data.availability !== 'AVAILABLE') return null;
  const items = orderSuggestions(inScope(data.suggestions, view));
  const pendingInScope = items.filter(s => s.status === 'pending').length;
  return <section className="panel" aria-label="Suggested meetings">
    <div className="panel-heading"><h2>Suggested meetings</h2><span className="badge">NOT MEETINGS</span><span className="badge">{pendingInScope} PENDING IN THIS SCOPE</span></div>
    <p className="muted">The lifecycle suggests a meeting after a technical escalation. A suggestion opens nothing: the Engineering Lead or an operator accepts it with <code>lead meeting open &lt;session&gt; --suggestion &lt;id&gt;</code> or dismisses it with a reason. Security, authorization, budget and held-lock stops are never suggested; they need an operator.</p>
    {items.length === 0 ? <p className="empty">{data.reason ?? 'No meeting suggestion in this scope.'}</p> : <ul className="suggestion-list">{items.map(s => <li key={s.id}>
      <p><span className="badge">{s.status === 'pending' ? 'PENDING · NOT A MEETING' : s.status.toUpperCase()}</span> <strong>{MEETING_TYPE_LABEL[s.meetingType] ?? s.meetingType}</strong> · <code>{s.id}</code></p>
      <p>{s.reason}</p>
      <p className="collaboration-meta">{s.attribution.status === 'ATTRIBUTED' ? `Scope: project ${s.attribution.project} · batch ${s.attribution.batchId}${s.taskId ? ` · task ${s.taskId}` : ''}${s.objectiveId ? ` · objective ${s.objectiveId}` : ''}` : `UNATTRIBUTED · ${s.attribution.reason}`}</p>
      <p className="collaboration-meta">Proposed participants: {s.participants.map(p => `${p.id} (${p.role})`).join(' · ')}</p>
      <p className="collaboration-meta">Evidence: {s.evidence.map(e => `${e.kind} ${e.ref}: ${e.detail}`).join(' · ')}</p>
      {s.status === 'accepted' && <p className="collaboration-meta">Accepted by {s.decidedBy} · meeting <code>{s.sessionId}</code></p>}
      {s.status === 'dismissed' && <p className="collaboration-meta">Dismissed by {s.decidedBy}: {s.decisionReason}</p>}
    </li>)}</ul>}
  </section>;
}

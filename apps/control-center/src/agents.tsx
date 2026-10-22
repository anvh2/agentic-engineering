import { useEffect, useState } from 'react';
import { rosterSchema, type Roster } from './agents-model.ts';

const KIND = { 'coding-worker': 'Coding worker', specialist: 'Specialist (read-only)', 'council-scripted': 'Council stand-in (SCRIPTED)' } as const;

export function AgentsView({ apiBase }: { apiBase: string }) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'disconnected'>('loading');
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/agents`, { signal: abort.signal });
        if (!response.ok) throw new Error();
        const next = rosterSchema.parse(await response.json());
        if (!abort.signal.aborted) { setRoster(next); setState('ready'); }
      } catch { if (!abort.signal.aborted) setState('disconnected'); }
      if (!abort.signal.aborted) timer = setTimeout(load, 10000);
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [apiBase]);
  if (state === 'loading') return <p role="status" className="notice">Loading registered agents…</p>;
  if (state === 'disconnected' || !roster) return <p role="alert" className="notice">Agent registration unavailable. No agents are shown rather than guessed.</p>;
  if (roster.source === 'unavailable') return <section className="panel"><div className="panel-heading"><h2>Registered agents</h2><span className="badge">NOT AVAILABLE</span></div><p className="empty">{roster.error}</p></section>;
  return <section className="panel" aria-label="Registered agents">
    <div className="panel-heading"><h2>Registered agents</h2><span>{roster.counts.registered} registered · {roster.counts.refused} refused · {roster.counts.unavailable} unavailable</span></div>
    <p className="muted">Read from this Mastra process's registration. Model = the resolver's binding (provider/model); availability of a registered model is not probed here.</p>
    {roster.error && <p role="alert" className="notice">Specialist pack not loaded: {roster.error}</p>}
    <div className="table-scroll"><table>
      <thead><tr><th scope="col">Agent</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Model binding</th><th scope="col">Tools</th><th scope="col">Reason</th></tr></thead>
      <tbody>{roster.agents.map(a => <tr key={`${a.kind}:${a.agentId}`} aria-label={`${a.name} ${a.status}`}>
        <td><strong>{a.name}</strong><br /><code className="muted">{a.agentId}</code></td>
        <td>{KIND[a.kind]}</td>
        <td><span className="badge">{a.status.toUpperCase()}</span></td>
        <td>{a.model ?? 'none'}{a.modelPinned === false && <span role="alert" className="badge"> REPOINTED after binding</span>}</td>
        <td>{a.tools.join(', ') || '—'}</td>
        <td>{a.reason ?? ''}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}

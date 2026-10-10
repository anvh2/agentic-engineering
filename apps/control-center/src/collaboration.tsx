import { useEffect, useState } from 'react';
import { collaborationSchema, orderedMessages, safeReference, type Collaboration, type Thread } from './collaboration-model.ts';

const known = (value: unknown) => value === null || value === undefined ? 'UNKNOWN' : String(value);
function Reference({ url, label }: { url: string | null; label: string }) {
  const safe = safeReference(url);
  return safe ? <a href={safe} target="_top" rel="noreferrer">{label}</a> : <span className="muted">{label} · unavailable</span>;
}
function MessageLinks({ ids, thread, open }: { ids: string[]; thread?: Thread; open: (id: string, message?: string) => void }) {
  return <span className="source-links">{ids.map(id => thread?.messages.some(m => m.id === id) ? <button key={id} className="text-button" onClick={() => open(thread.id, id)}>Source message {id}</button> : <span key={id}>Source {id} · NOT AVAILABLE</span>)}</span>;
}
function Transcript({ thread, messageId }: { thread: Thread; messageId?: string }) {
  useEffect(() => { if (messageId) document.getElementById(`message-${messageId}`)?.scrollIntoView({ block: 'center' }); }, [thread.id, messageId]);
  const messages = orderedMessages(thread);
  return <section className="panel transcript" aria-label="Discussion transcript">
    <div className="panel-heading"><h2>{thread.title}</h2><span>{messages.filter(m => m.type === 'OBJECTION' && m.objectionState !== 'RESOLVED').length} open or unknown objections</span></div>
    <p className="collaboration-meta">Objective: {known(thread.objectiveId)} · Task: {known(thread.taskId)}</p>
    <p className="collaboration-meta">{thread.participants.map(p => `${p.name} (${p.role})`).join(' · ') || 'Participants UNKNOWN'}</p>
    {messages.length === 0 && <p className="empty">No reported messages.</p>}
    {messages.map(m => <article key={m.id} id={`message-${m.id}`} tabIndex={-1} className={`message ${messageId === m.id ? 'selected-message' : ''}`}>
      <header><strong>{thread.participants.find(p => p.id === m.authorId)?.name ?? m.authorId}</strong><span className="badge">{m.type}</span><time>{known(m.at)}</time></header>
      <p className="muted">Author ID: {m.authorId} · Message: {m.id}</p>
      {m.replyTo && <p>Reply to <a href={`#message-${encodeURIComponent(m.replyTo)}`}>{m.replyTo}</a></p>}
      <p className="message-text">{m.text}</p>
      {m.type === 'OBJECTION' && <p className="notice">Objection: {m.objectionState ?? 'UNKNOWN'}</p>}
      <div className="source-links">{m.references.map((r, i) => <Reference key={i} {...r} />)}{m.traceUrl && <Reference url={m.traceUrl} label="Mastra trace" />}</div>
      <small className="muted">Invocation: {known(m.invocationId)}</small>
    </article>)}
  </section>;
}
export function CollaborationView({ kind, apiBase }: { kind: 'Discussions' | 'Meetings'; apiBase: string }) {
  const [data, setData] = useState<Collaboration | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'disconnected'>('loading');
  const [threadId, setThread] = useState<string>();
  const [meetingId, setMeeting] = useState<string>();
  const [messageId, setMessage] = useState<string>();
  const [showThread, setShowThread] = useState(false);
  useEffect(() => { setShowThread(false); }, [kind]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/collaboration`, { signal: abort.signal });
        if (!response.ok) throw new Error();
        const next = collaborationSchema.parse(await response.json());
        if (!abort.signal.aborted) { setData(next); setState('ready'); }
      } catch { if (!abort.signal.aborted) setState('disconnected'); }
      // Serial polling replaces the complete snapshot; no append/replay accumulation.
      if (!abort.signal.aborted) timer = setTimeout(load, 5000);
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [apiBase]);
  const open = (id: string, message?: string) => { setThread(id); setMessage(message); setShowThread(true); };
  if (state === 'loading') return <p role="status" className="notice">Loading {kind.toLowerCase()}…</p>;
  if (state === 'disconnected') return <p role="alert" className="notice">Collaboration connection unavailable. No live records displayed. Retrying automatically.</p>;
  if (!data || data.availability === 'NOT_AVAILABLE') return <section className="panel"><div className="panel-heading"><h2>{kind}</h2><span className="badge">NOT AVAILABLE</span></div><p className="empty">{data?.reason ?? 'Authoritative Core B records are unavailable.'}</p></section>;
  const thread = data.threads.find(t => t.id === threadId) ?? data.threads[0];
  const meeting = data.meetings.find(m => m.id === meetingId) ?? data.meetings[0];
  const meetingThread = data.threads.find(t => t.id === meeting?.threadId);
  const discussionMode = kind === 'Discussions' || showThread;
  return <>
    {data.source === 'test-fixture' && <p role="status" className="notice">SYNTHETIC TEST DATA · not connected to live collaboration</p>}
    {showThread && kind === 'Meetings' && <button className="text-button" onClick={() => setShowThread(false)}>Back to meeting</button>}
    <div className="collaboration-layout">
      <nav className="panel thread-list" aria-label={discussionMode ? 'Discussion threads' : 'Meetings'}>
        {(discussionMode ? data.threads : data.meetings).map(item => <button key={item.id} aria-current={item.id === (discussionMode ? thread?.id : meeting?.id) ? 'true' : undefined} onClick={() => discussionMode ? open(item.id) : setMeeting(item.id)}>{item.title}</button>)}
        {(discussionMode ? data.threads : data.meetings).length === 0 && <p className="empty">No reported {discussionMode ? 'threads' : 'meetings'}.</p>}
      </nav>
      {discussionMode ? thread && <Transcript thread={thread} messageId={messageId} /> : meeting && <section className="panel meeting-inspector" aria-label="Meeting inspector">
        <div className="panel-heading"><h2>{meeting.title}</h2><span className="badge">READ ONLY</span></div>
        <h3>Agenda</h3><ul>{meeting.agenda.map((a, i) => <li key={i}>{a}</li>)}</ul>
        <h3>Participants and roles</h3><p>{meeting.participants.map(p => `${p.name} (${p.role})`).join(' · ') || 'UNKNOWN'}</p>
        <dl className="details"><div><dt>Started</dt><dd>{known(meeting.startedAt)}</dd></div><div><dt>Ended</dt><dd>{known(meeting.endedAt)}</dd></div><div><dt>Round budget</dt><dd>{meeting.rounds.length} reported / {known(meeting.roundLimit)}</dd></div><div><dt>Invocation budget</dt><dd>{known(meeting.invocationsUsed)} / {known(meeting.invocationLimit)}</dd></div><div><dt>Budget exhausted</dt><dd>{meeting.budgetExhausted === null ? 'UNKNOWN' : meeting.budgetExhausted ? 'YES' : 'NO'}</dd></div></dl>
        <h3>Discussion rounds</h3>{meeting.rounds.map(r => <p key={r.id}>Round {r.number} · {r.state}<MessageLinks ids={r.messageIds} thread={meetingThread} open={open} /></p>)}
        <h3>Proposals and objections</h3>{meetingThread ? orderedMessages(meetingThread).filter(m => ['PROPOSAL', 'OBJECTION'].includes(m.type)).map(m => <p key={m.id}>{m.type} · {m.text}{m.type === 'OBJECTION' && ` · ${m.objectionState ?? 'UNKNOWN'}`}<MessageLinks ids={[m.id]} thread={meetingThread} open={open} /></p>) : <p>NOT AVAILABLE</p>}
        {(['agreements', 'disagreements', 'decisions'] as const).map(field => <section key={field}><h3>{field === 'disagreements' ? 'Unresolved disagreements' : field[0].toUpperCase() + field.slice(1)}</h3>{meeting[field].length ? meeting[field].map((record, i) => <p key={i}>{record.text}<MessageLinks ids={record.messageIds} thread={meetingThread} open={open} /></p>) : <p className="muted">None reported; no consensus inferred.</p>}</section>)}
        <h3>Action items</h3>{meeting.actions.length ? meeting.actions.map(a => <p key={a.id}>{a.text} · Owner: {meeting.participants.find(p => p.id === a.ownerId)?.name ?? known(a.ownerId)} · Follow-up: {known(a.state)}<MessageLinks ids={a.messageIds} thread={meetingThread} open={open} /></p>) : <p className="muted">None reported.</p>}
        <h3>Reported usage</h3><p>Input: {known(meeting.usage.inputTokens)} · Output: {known(meeting.usage.outputTokens)}</p><p>Source: {meeting.usage.source} · Completeness: {meeting.usage.completeness}</p>
        <div className="source-links">{meeting.references.map((r, i) => <Reference key={i} {...r} />)}</div>
      </section>}
    </div>
  </>;
}

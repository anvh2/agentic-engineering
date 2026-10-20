import { useEffect, useState } from 'react';
import { collaborationSchema, orderedMessages, safeReference, type Collaboration, type Thread } from './collaboration-model.ts';

const known = (value: unknown) => value === null || value === undefined ? 'UNKNOWN' : String(value);
function Reference({ url, label }: { url: string | null; label: string }) {
  // Core B evidence (a message id, path, commit or trace id) is an opaque reference, not a link.
  if (url === null) return <span className="muted">{label}</span>;
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
    <div className="panel-heading"><h2>{thread.title}</h2><span>{thread.synthetic && <span className="badge">FAKE PARTICIPANTS</span>} {messages.filter(m => m.type === 'OBJECTION' && m.objectionState !== 'RESOLVED' && m.objectionState !== 'WITHDRAWN').length} open or unknown objections</span></div>
    <p className="collaboration-meta">Objective: {known(thread.objectiveId)} · Task: {known(thread.taskId)}</p>
    <p className="collaboration-meta">{thread.participants.map(p => `${p.name} (${p.role})`).join(' · ') || 'Participants UNKNOWN'}</p>
    {messages.length === 0 && <p className="empty">No reported messages.</p>}
    {messages.map(m => <article key={m.id} id={`message-${m.id}`} tabIndex={-1} className={`message ${messageId === m.id ? 'selected-message' : ''}`}>
      <header><strong>{thread.participants.find(p => p.id === m.authorId)?.name ?? m.authorId}</strong><span className="badge">{m.type}</span><time>{known(m.at)}</time></header>
      <p className="muted">Author ID: {m.authorId} · Message: {m.id}{m.seq !== null && ` · Event #${m.seq}`}</p>
      {m.replyTo && <p>Reply to <a href={`#message-${encodeURIComponent(m.replyTo)}`}>{m.replyTo}</a></p>}
      <p className="message-text">{m.text}</p>
      {m.type === 'OBJECTION' && <p className="notice">Objection: {m.objectionState ?? 'UNKNOWN'}</p>}
      {m.correctedBy.length > 0 && <p className="notice">Corrected by {m.correctedBy.join(', ')} (original kept)</p>}
      {m.withdrawnBy && <p className="notice">Withdrawn by {m.withdrawnBy}</p>}
      <div className="source-links">{m.references.map((r, i) => <Reference key={i} {...r} />)}{m.traceUrl && <Reference url={m.traceUrl} label="Mastra trace" />}</div>
      <small className="muted">Invocation: {known(m.invocationId)}{m.traceId && <> · Trace: <code>{m.traceId}</code></>}</small>
    </article>)}
  </section>;
}
function CouncilFacts({ meeting }: { meeting: Collaboration['meetings'][number] }) {
  if (meeting.councilIssue) return <p role="alert" className="notice">COUNCIL RECORD NOT VERIFIED · {meeting.councilIssue}</p>;
  const c = meeting.council;
  if (!c) return null;
  return <section aria-label="Council record">
    <p className="notice">{c.mode === 'LIVE'
      ? <><span className="badge">LIVE</span> Replies were produced by the local model {c.model}. Advisory only; human approval pending.</>
      : <><span className="badge">SCRIPTED</span> Canned replies ({c.model}): this proves wiring and rules, not model output.</>}</p>
    {c.integrity === 'OPEN_UNRECORDED'
      ? <p className="muted">OPEN: no council record yet. Mode and model are checked against the verified events; workflow runs and call counts appear once the meeting concludes and its record verifies.</p>
      : <dl className="details">
        <div><dt>Model calls</dt><dd>{c.modelCalls ?? 'UNKNOWN'}{c.failedCalls ? ` (${c.failedCalls} failed, no reply)` : ''}</dd></div>
        <div><dt>Tool calls</dt><dd>{c.toolCalls?.length ? c.toolCalls.map(t => `${t.tool} ×${t.count}`).join(', ') : 'none'}</dd></div>
        <div><dt>Council record</dt><dd><code>{c.recordPath}</code> · <code>npm run council -- show {c.meetingId}</code></dd></div>
        <div><dt>Integrity</dt><dd>Council record intact and covering exactly the verified events (#{meeting.provenance?.throughSeq ?? '?'})</dd></div>
      </dl>}
    <div className="source-links">{c.workflowRuns.map(r => <Reference key={r.runId} url={r.url} label={`Mastra workflow run ${r.runId}`} />)}</div>
    <p className="muted">Mastra trace{c.traceIds.length === 1 ? '' : 's'}: {c.traceIds.length ? c.traceIds.map(t => <code key={t}>{t} </code>) : 'none recorded'}</p>
  </section>;
}
export function CollaborationView({ kind, apiBase }: { kind: 'Discussions' | 'Meetings' | 'Council'; apiBase: string }) {
  const endpoint = kind === 'Council' ? 'council' : 'collaboration';
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
    let reopen: ReturnType<typeof setTimeout>;
    let running = false;
    let again = false;
    const load = async () => {
      if (running) { again = true; return; }
      running = true;
      clearTimeout(timer);
      try {
        const response = await fetch(`${apiBase}/${endpoint}`, { signal: abort.signal });
        if (!response.ok) throw new Error();
        const next = collaborationSchema.parse(await response.json());
        if (!abort.signal.aborted) { setData(next); setState('ready'); }
      } catch { if (!abort.signal.aborted) setState('disconnected'); }
      running = false;
      if (abort.signal.aborted) return;
      if (again) { again = false; void load(); return; }
      // Serial replacement of the complete, verified snapshot; no append/replay accumulation. SSE below only says when.
      timer = setTimeout(load, 5000);
    };
    void load();
    // Core B's event feed is an invalidation signal (ids and types only): every frame, reconnect or reset re-reads the
    // snapshot. Connectivity is decided by that read, never by the stream alone.
    let stream: EventSource | undefined;
    const subscribe = () => {
      stream = new EventSource(`${apiBase}/${endpoint}/events`);
      for (const name of ['collab', 'checkpoint', 'reset', 'connection']) stream.addEventListener(name, () => void load());
      stream.onerror = () => {
        if (abort.signal.aborted) return;
        void load();
        // A refused (non-stream) response closes EventSource for good; the browser retries only dropped connections.
        if (stream?.readyState === EventSource.CLOSED) reopen = setTimeout(subscribe, 5000);
      };
    };
    subscribe();
    return () => { abort.abort(); clearTimeout(timer); clearTimeout(reopen); stream?.close(); };
  }, [apiBase, endpoint]);
  const open = (id: string, message?: string) => { setThread(id); setMessage(message); setShowThread(true); };
  if (state === 'loading') return <p role="status" className="notice">Loading {kind.toLowerCase()}…</p>;
  if (state === 'disconnected') return <p role="alert" className="notice">Collaboration connection unavailable. No live records displayed. Retrying automatically.</p>;
  if (data?.availability === 'CORRUPT') return <section className="panel"><div className="panel-heading"><h2>{kind}</h2><span className="badge">INTEGRITY FAILURE</span></div><p role="alert" className="notice">{data.reason}</p><p className="empty">No collaboration records are shown until the store verifies.</p></section>;
  if (!data || data.availability === 'NOT_AVAILABLE') return <section className="panel"><div className="panel-heading"><h2>{kind}</h2><span className="badge">NOT AVAILABLE</span></div><p className="empty">{data?.reason ?? 'Authoritative Core B records are unavailable.'}</p></section>;
  const thread = data.threads.find(t => t.id === threadId) ?? data.threads[0];
  const meeting = data.meetings.find(m => m.id === meetingId) ?? data.meetings[0];
  const meetingThread = data.threads.find(t => t.id === meeting?.threadId);
  const discussionMode = kind === 'Discussions' || showThread;
  return <>
    {data.source === 'test-fixture' && <p role="status" className="notice">SYNTHETIC TEST DATA · not connected to live collaboration</p>}
    {data.source === 'core' && data.threads.some(t => t.synthetic) && <p role="status" className="notice">DETERMINISTIC FAKE PARTICIPANTS · Persisted collaboration events authored by scripted test identities (provider: fake). Not live model output.</p>}
    {data.source === 'core' && data.reason && <p className="muted">{data.reason}</p>}
    {kind === 'Council' && data.source === 'core' && <p role="status" className="muted">Engineering council meetings, read from the council's own Core B store with the same hash-chain verification. LIVE and SCRIPTED meetings are labelled on each meeting.</p>}
    {showThread && kind !== 'Discussions' && <button className="text-button" onClick={() => setShowThread(false)}>Back to meeting</button>}
    <div className="collaboration-layout">
      <nav className="panel thread-list" aria-label={discussionMode ? 'Discussion threads' : 'Meetings'}>
        {(discussionMode ? data.threads : data.meetings).map(item => <button key={item.id} aria-current={item.id === (discussionMode ? thread?.id : meeting?.id) ? 'true' : undefined} onClick={() => discussionMode ? open(item.id) : setMeeting(item.id)}>{'council' in item && item.council ? `[${item.council.mode}] ` : ''}{'councilIssue' in item && item.councilIssue ? '[UNVERIFIED] ' : ''}{item.title}</button>)}
        {(discussionMode ? data.threads : data.meetings).length === 0 && <p className="empty">No reported {discussionMode ? 'threads' : 'meetings'}.</p>}
      </nav>
      {discussionMode ? thread && <Transcript thread={thread} messageId={messageId} /> : meeting && <section className="panel meeting-inspector" aria-label="Meeting inspector">
        <div className="panel-heading"><h2>{meeting.title}</h2><span className="badge">READ ONLY</span></div>
        <CouncilFacts meeting={meeting} />
        <p>Status: {known(meeting.status)} · Outcome: {meeting.outcome ?? 'none yet'}{meeting.reason ? ` · ${meeting.reason}` : ''}</p>
        <h3>Agenda</h3><ul>{meeting.agenda.map((a, i) => <li key={i}>{a}</li>)}</ul>
        <h3>Participants and roles</h3><p>{meeting.participants.map(p => `${p.name} (${p.role})`).join(' · ') || 'UNKNOWN'}</p>
        <dl className="details"><div><dt>Started</dt><dd>{known(meeting.startedAt)}</dd></div><div><dt>Ended</dt><dd>{known(meeting.endedAt)}</dd></div><div><dt>Round budget</dt><dd>{meeting.rounds.length} reported / {known(meeting.roundLimit)}</dd></div><div><dt>Invocation budget</dt><dd>{known(meeting.invocationsUsed)} / {known(meeting.invocationLimit)}</dd></div><div><dt>Budget exhausted</dt><dd>{meeting.budgetExhausted === null ? 'UNKNOWN' : meeting.budgetExhausted ? 'YES' : 'NO'}</dd></div><div><dt>Tokens used</dt><dd>{known(meeting.tokensUsed)}</dd></div></dl>
        <h3>Discussion rounds</h3>{meeting.rounds.map(r => <p key={r.id}>Round {r.number} · {r.state}<MessageLinks ids={r.messageIds} thread={meetingThread} open={open} /></p>)}
        <h3>Proposals and objections</h3>{meetingThread ? orderedMessages(meetingThread).filter(m => ['PROPOSAL', 'OBJECTION'].includes(m.type)).map(m => <p key={m.id}>{m.type} · {m.text}{m.type === 'OBJECTION' && ` · ${m.objectionState ?? 'UNKNOWN'}`}<MessageLinks ids={[m.id]} thread={meetingThread} open={open} /></p>) : <p>NOT AVAILABLE</p>}
        {(['agreements', 'disagreements', 'decisions'] as const).map(field => <section key={field}><h3>{field === 'disagreements' ? 'Unresolved disagreements' : field[0].toUpperCase() + field.slice(1)}</h3>{meeting[field].length ? meeting[field].map((record, i) => <p key={i}>{record.text}<MessageLinks ids={record.messageIds} thread={meetingThread} open={open} /></p>) : <p className="muted">None reported; no consensus inferred.</p>}</section>)}
        <h3>Action items</h3>{meeting.actions.length ? meeting.actions.map(a => <p key={a.id}>{a.text} · Owner: {meeting.participants.find(p => p.id === a.ownerId)?.name ?? known(a.ownerId)} · Follow-up: {known(a.state)}<MessageLinks ids={a.messageIds} thread={meetingThread} open={open} /></p>) : <p className="muted">None reported.</p>}
        {meeting.objections.length > 0 && <><h3>Objections in the record</h3>{meeting.objections.map(o => <p key={o.id}>{o.status} · {o.text}<MessageLinks ids={o.messageIds} thread={meetingThread} open={open} /></p>)}</>}
        <h3>Reported usage</h3><p>Input: {known(meeting.usage.inputTokens)} · Output: {known(meeting.usage.outputTokens)}</p><p>Source: {meeting.usage.source} · Completeness: {meeting.usage.completeness}</p>
        <div className="source-links">{meeting.references.map((r, i) => <Reference key={i} {...r} />)}</div>
        <h3>Provenance</h3>{meeting.provenance
          ? <p className="provenance">Record covers events through #{meeting.provenance.throughSeq} · {meeting.provenance.messageCount} messages · chain hash <code>{meeting.provenance.throughHash.slice(0, 16)}…</code> · record hash <code>{meeting.provenance.recordHash.slice(0, 16)}…</code></p>
          : <p className="muted">No meeting record yet: the session has not concluded.</p>}
      </section>}
    </div>
  </>;
}

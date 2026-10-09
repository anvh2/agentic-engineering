import { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowUpRight,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  GitBranch,
  Layers,
  ListChecks,
  Moon,
  Network,
  PanelLeft,
  Sun,
  Terminal,
  X,
} from 'lucide-react';
import {
  snapshotSchema,
  type ControlAgent,
  type ControlTask,
  type Snapshot,
  type Usage,
} from '../../../src/integrations/control-center/contract.ts';
import './style.css';

type Page = 'Overview' | 'Organization' | 'Objectives' | 'Runs' | 'Reviews';
const pages = [
  { name: 'Overview', icon: Layers },
  { name: 'Organization', icon: Network },
  { name: 'Objectives', icon: ListChecks },
  { name: 'Runs', icon: Activity },
  { name: 'Reviews', icon: CheckCheck },
] as const;
const number = (n: number | null) => (n === null ? 'UNKNOWN' : n.toLocaleString());
const date = (n: number | null) => (n === null ? 'Unknown' : new Date(n).toLocaleString());
const duration = (n: number | null) =>
  n === null ? 'Unknown' : n < 60000 ? `${Math.floor(n / 1000)}s` : `${Math.floor(n / 60000)}m ${Math.floor(n / 1000) % 60}s`;
function Badge({ value }: { value: string }) {
  return (
    <span
      className={`badge ${['RUNNING', 'VERIFYING'].includes(value) ? 'active' : ['RUNTIME_FAILURE', 'FAILED', 'UNAVAILABLE'].includes(value) ? 'failed' : ''}`}
    >
      {value.replaceAll('_', ' ')}
    </span>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <CircleHelp size={18} />
      <p>{children}</p>
    </div>
  );
}
function Trace({ task }: { task: ControlTask }) {
  return task.traceUrl ? (
    <a className="trace" href={task.traceUrl} target="_blank" rel="noreferrer">
      Mastra run <ArrowUpRight size={12} />
    </a>
  ) : (
    <span className="muted">Trace unavailable</span>
  );
}
function UsageView({ usage }: { usage: Usage }) {
  return (
    <>
      <div className="section-heading">
        <h3>Token usage</h3>
        <Badge value={usage.completeness.toUpperCase()} />
      </div>
      <dl className="metrics">
        {(
          [
            ['Input tokens', usage.inputTokens],
            ['Output tokens', usage.outputTokens],
            ['Cached input¹', usage.cachedInputTokens],
            ['Reasoning¹', usage.reasoningTokens],
            ['Latency (ms)', usage.latencyMs],
            ['Provider cost (USD)', usage.actualCostUsd],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={value === null ? 'muted' : ''}>{number(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="footnote">¹ Detail counts are subsets, never added to input/output totals.</p>
      <dl className="details">
        <div>
          <dt>Estimated cost</dt>
          <dd>
            {usage.estimatedCost ? `$${usage.estimatedCost.usd} · ${usage.estimatedCost.pricingSource}` : 'UNKNOWN · no pricing source'}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{usage.source === 'unavailable' ? 'Core telemetry unavailable' : usage.source}</dd>
        </div>
      </dl>
      {usage.completeness === 'pending' && <p className="notice">Tokens pending provider completion.</p>}
    </>
  );
}
function useSnapshot(objectiveId: string) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<'loading' | 'connected' | 'disconnected'>('loading');
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    setSnapshot(null);
    setConnection('loading');
    const query = objectiveId ? `?objectiveId=${encodeURIComponent(objectiveId)}` : '';
    let eventArrived = false;
    const accept = (value: unknown) => {
      const parsed = snapshotSchema.safeParse(value);
      if (!active) return;
      if (!parsed.success) {
        setSnapshot(null);
        setConnection('disconnected');
        return;
      }
      setSnapshot(parsed.data);
      setConnection(parsed.data.source);
    };
    fetch(`/api/v1/snapshot${query}`, { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((value) => {
        if (!eventArrived) accept(value);
      })
      .catch(() => {
        if (active && !eventArrived) setConnection('disconnected');
      });
    const stream = new EventSource(`/api/v1/events${query}`);
    stream.addEventListener('snapshot', (event) => {
      eventArrived = true;
      try {
        accept(JSON.parse((event as MessageEvent).data));
      } catch {
        setConnection('disconnected');
      }
    });
    stream.addEventListener('connection', () => {
      if (active) setConnection('disconnected');
    });
    stream.addEventListener('reset', () => {
      if (active) {
        setSnapshot(null);
        setConnection('loading');
      }
    });
    stream.onerror = () => {
      if (active) setConnection('disconnected');
    };
    return () => {
      active = false;
      abort.abort();
      stream.close();
    };
  }, [objectiveId]);
  return { snapshot, connection };
}
function TaskTable({ tasks, onSelect, now }: { tasks: ControlTask[]; onSelect: (id: string) => void; now: number }) {
  if (!tasks.length) return <Empty>No tasks in this scope. Select an objective with persisted scheduler data.</Empty>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Provider</th>
            <th>Scheduler state</th>
            <th>Claim elapsed</th>
            <th>Usage</th>
            <th>Execution</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>
                <button className="text-button" onClick={() => onSelect(t.id)}>
                  {t.title}
                </button>
                <small className="mono">{t.id}</small>
              </td>
              <td>{t.provider}</td>
              <td>
                <Badge value={t.state} />
                {t.stale && <small className="warning">Lease expired · activity unknown</small>}
              </td>
              <td className="mono">{duration(t.activeSince === null ? null : Math.max(0, now - t.activeSince))}</td>
              <td className="muted">
                {t.usage.inputTokens === null ? 'UNKNOWN' : `${number(t.usage.inputTokens)} in / ${number(t.usage.outputTokens)} out`}
              </td>
              <td>
                <Trace task={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Inspector({
  agent,
  task,
  snapshot,
  onClose,
  now,
  disconnected,
}: {
  agent?: ControlAgent;
  task?: ControlTask;
  snapshot: Snapshot;
  onClose: () => void;
  now: number;
  disconnected: boolean;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => previous?.focus();
  }, []);
  const tasks = task ? [task] : snapshot.tasks.filter((t) => agent?.assignmentIds.includes(t.id));
  const history = snapshot.tasks
    .filter((t) => (task ? t.id === task.id : t.provider === agent?.provider))
    .flatMap((t) => t.runIds.map((id) => ({ id, task: t })));
  const activity = disconnected ? 'UNKNOWN' : (task?.activity ?? agent?.activity ?? 'UNKNOWN');
  const events = snapshot.events.filter((e) =>
    task ? e.taskId === task.id : snapshot.tasks.some((t) => t.id === e.taskId && t.provider === agent?.provider),
  );
  return (
    <aside
      className="inspector"
      aria-label="Details inspector"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <header className="inspector-header">
        <div>
          <span className="eyebrow">{task ? 'Task inspector' : 'Agent inspector'}</span>
          <h2>{task?.title ?? agent?.name}</h2>
        </div>
        <button ref={close} className="icon-button" aria-label="Close inspector" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="inspector-body">
        <div className="section-heading">
          <h3>Current activity</h3>
          <Badge value={activity} />
        </div>
        {disconnected && <p className="notice">Disconnected. Details below are the last observed snapshot.</p>}
        <dl className="details">
          <div>
            <dt>Provider</dt>
            <dd>{task?.provider ?? agent?.provider}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{agent?.modelId ?? 'UNKNOWN'}</dd>
          </div>
          <div>
            <dt>Configuration</dt>
            <dd>{agent?.configured === true ? 'Configured' : agent?.configured === false ? 'Not configured' : 'UNKNOWN'}</dd>
          </div>
          <div>
            <dt>Availability</dt>
            <dd>{agent?.availability ?? 'UNKNOWN'}</dd>
          </div>
          <div>
            <dt>Last outcome</dt>
            <dd>
              {agent?.lastOutcome ??
                (task && !['READY', 'CLAIMED', 'CODING', 'VERIFYING', 'BACKLOG'].includes(task.state) ? task.state : 'Unknown')}
            </dd>
          </div>
          <div>
            <dt>Last event</dt>
            <dd>{date(task?.lastEventAt ?? agent?.lastEventAt ?? null)}</dd>
          </div>
        </dl>
        <p className="footnote">
          {agent?.historicallyVerified
            ? 'Historically verified in this objective. This does not indicate online presence.'
            : 'No live worker heartbeat is exposed by Core.'}
        </p>
        <section>
          <h3>Assignment & execution</h3>
          {tasks.length ? (
            tasks.map((t) => (
              <div className="assignment" key={t.id}>
                <strong>{t.title}</strong>
                <small className="mono">{t.id}</small>
                <dl className="details">
                  <div>
                    <dt>Stage</dt>
                    <dd>{t.stage}</dd>
                  </div>
                  <div>
                    <dt>Worker ID</dt>
                    <dd>{t.workerId ?? 'UNKNOWN'}</dd>
                  </div>
                  <div>
                    <dt>Claim elapsed²</dt>
                    <dd>{duration(!disconnected && t.activeSince !== null ? Math.max(0, now - t.activeSince) : null)}</dd>
                  </div>
                  <div>
                    <dt>Permit queue</dt>
                    <dd>{t.queuePosition ?? 'UNKNOWN'}</dd>
                  </div>
                  <div>
                    <dt>Dependencies</dt>
                    <dd>{t.dependsOn.length ? t.dependsOn.join(', ') : 'None'}</dd>
                  </div>
                </dl>
                <Trace task={t} />
              </div>
            ))
          ) : (
            <p className="muted">No current assignment observed.</p>
          )}
          <p className="footnote">² Time since scheduler claim, including preparation and waiting. Inference duration is unavailable.</p>
        </section>
        <section>
          <UsageView usage={task?.usage ?? agent!.usage} />
          <p className="footnote">Per-call telemetry is not exposed yet. Failed, retried and cancelled call usage is unknown.</p>
        </section>
        <section>
          <h3>
            Run history <span className="count">{history.length}</span>
          </h3>
          {history.length ? (
            history.map((r) => (
              <div className="history-row" key={`${r.task.id}:${r.id}`}>
                <span className="mono">{r.id}</span>
                {r.id === r.task.runId ? <Trace task={r.task} /> : <span className="muted">Historical run</span>}
              </div>
            ))
          ) : (
            <p className="muted">No persisted runs in this objective.</p>
          )}
        </section>
        <section>
          <h3>Execution timeline</h3>
          <Timeline events={events} />
        </section>
      </div>
    </aside>
  );
}
function Timeline({ events }: { events: Snapshot['events'] }) {
  return events.length ? (
    <ol className="timeline">
      {events
        .slice()
        .reverse()
        .map((e) => (
          <li key={e.id}>
            <span className="timeline-dot" />
            <div>
              <strong>{e.type}</strong>
              <small className="mono">
                {e.taskId} · {e.from ?? 'NEW'} → {e.to}
              </small>
              <time dateTime={new Date(e.at).toISOString()}>{date(e.at)}</time>
            </div>
          </li>
        ))}
    </ol>
  ) : (
    <p className="muted">No persisted events in this scope.</p>
  );
}
function Providers({ snapshot }: { snapshot: Snapshot }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Provider usage</h2>
        <span className="muted">Selected objective only</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cached</th>
              <th>Reasoning</th>
              <th>Cost / quota</th>
              <th>Permits³</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.providers.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td className="muted">{number(p.usage.inputTokens)}</td>
                <td className="muted">{number(p.usage.outputTokens)}</td>
                <td className="muted">{number(p.usage.cachedInputTokens)}</td>
                <td className="muted">{number(p.usage.reasoningTokens)}</td>
                <td className="muted">
                  {number(p.usage.actualCostUsd)} / {number(p.quota)}
                </td>
                <td className="mono">{p.permits === null ? 'UNKNOWN' : `${p.permitsInUse} / ${p.permits}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="panel-note">³ Machine-wide permit usage, sampled independently. No task-level permit attribution.</p>
    </section>
  );
}
function App() {
  const [page, setPage] = useState<Page>('Organization');
  const [objectiveId, setObjective] = useState('');
  const [selected, setSelected] = useState<{ kind: 'agent' | 'task'; id: string } | null>(null);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('control-center-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [now, setNow] = useState(Date.now());
  const { snapshot, connection } = useSnapshot(objectiveId);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('control-center-theme', theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const agent = selected?.kind === 'agent' ? snapshot?.agents.find((a) => a.id === selected.id) : undefined;
  const task = selected?.kind === 'task' ? snapshot?.tasks.find((t) => t.id === selected.id) : undefined;
  const pickTask = (id: string) => setSelected({ kind: 'task', id });
  const connected = connection === 'connected';
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Primary">
        <div className="brand">
          <Terminal size={19} />
          <span>
            Engineering<span className="brand-sub">Control Center</span>
          </span>
        </div>
        <div className="nav-label">WORKSPACE</div>
        {pages.map(({ name, icon: Icon }) => (
          <button
            key={name}
            aria-label={name}
            aria-current={page === name ? 'page' : undefined}
            onClick={() => {
              setPage(name);
              setSelected(null);
            }}
          >
            <Icon size={16} />
            <span>{name}</span>
            {name === 'Reviews' && !!snapshot?.reviews.length && <span className="count">{snapshot.reviews.length}</span>}
          </button>
        ))}
        <div className="sidebar-bottom">
          <span className="read-only">
            <span className="square" />
            Read-only workspace
          </span>
          <p>No execution controls</p>
        </div>
      </nav>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <PanelLeft size={16} />
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{page}</strong>
          </div>
          <div className="top-actions">
            <span className={`connection ${connected ? 'connected' : ''}`} role="status">
              <span />
              {connection === 'loading' ? 'Connecting' : connected ? 'Scheduler connected' : 'Disconnected'}
            </span>
            <button
              className="icon-button"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>
        <div className={`content-layout ${agent || task ? 'has-inspector' : ''}`}>
          <main id="main" tabIndex={-1}>
            <div className="page-heading">
              <div>
                <span className="eyebrow">ENGINEERING OPERATIONS</span>
                <h1>{page}</h1>
                <p>
                  {page === 'Organization'
                    ? 'Agent activity, assignments and execution evidence.'
                    : 'Persisted scheduler data. Observation only.'}
                </p>
              </div>
              <span className="version">M8.4 / READ ONLY</span>
            </div>
            <div className="scope-bar">
              <label htmlFor="objective">Objective</label>
              <select
                id="objective"
                value={objectiveId}
                onChange={(e) => {
                  setObjective(e.target.value);
                  setSelected(null);
                }}
              >
                <option value="">Select a scheduler batch</option>
                {snapshot?.objectives.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.id} · {o.label}
                  </option>
                ))}
              </select>
              <span className="muted">{objectiveId ? 'Scoped observation' : 'No usage aggregated'}</span>
            </div>
            {connection === 'loading' && (
              <div className="notice" role="status">
                Loading scheduler snapshot…
              </div>
            )}
            {connection === 'disconnected' && (
              <div className="notice" role="alert">
                Scheduler connection unavailable. Activity is UNKNOWN; any retained data is a historical snapshot. Reconnecting
                automatically.
              </div>
            )}
            {!objectiveId && (
              <div className="notice">
                Choose an objective to inspect its tasks and runs. Agent roles below do not indicate configuration or online presence.
              </div>
            )}
            {snapshot && (
              <>
                {page === 'Organization' && (
                  <>
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>
                          Agent hierarchy <span className="count">{snapshot.agents.length}</span>
                        </h2>
                        <span className="muted">Lead → coding workers</span>
                      </div>
                      <div className="table-scroll">
                        <table className="agent-table">
                          <thead>
                            <tr>
                              <th>Agent / provider</th>
                              <th>Current activity</th>
                              <th>Current assignment</th>
                              <th>Last outcome</th>
                              <th>Last event</th>
                            </tr>
                          </thead>
                          <tbody>
                            {snapshot.agents.map((a) => (
                              <tr key={a.id} className={selected?.id === a.id ? 'selected' : ''}>
                                <td>
                                  <button
                                    className={`agent-name ${a.role === 'worker' ? 'child' : ''}`}
                                    onClick={() => setSelected({ kind: 'agent', id: a.id })}
                                  >
                                    {a.role === 'worker' ? <GitBranch size={15} /> : <Network size={15} />}
                                    <span>
                                      {a.name}
                                      <small>
                                        {a.provider} · model {a.modelId ?? 'UNKNOWN'}
                                      </small>
                                    </span>
                                  </button>
                                </td>
                                <td>
                                  <Badge value={connected ? a.activity : 'UNKNOWN'} />
                                </td>
                                <td>
                                  {a.assignmentIds.length ? (
                                    a.assignmentIds.map((id) => (
                                      <button key={id} className="text-button assignment-link" onClick={() => pickTask(id)}>
                                        {id}
                                      </button>
                                    ))
                                  ) : (
                                    <span className="muted">No assignment observed</span>
                                  )}
                                </td>
                                <td>{a.lastOutcome ? <Badge value={a.lastOutcome} /> : <span className="muted">Unknown</span>}</td>
                                <td className="muted">{date(a.lastEventAt)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="panel-note">Activity and outcome are separate. A completed run does not make a worker online.</p>
                    </section>
                    <Providers snapshot={snapshot} />
                    <section className="panel compact">
                      <h2>Observation coverage</h2>
                      <p>
                        Task transitions and review requests are available. Live inference spans, provider availability and token collection
                        are awaiting Core interfaces.
                      </p>
                      <details>
                        <summary>Data sources & limitations</summary>
                        <ul>
                          {snapshot.limitations.map((l) => (
                            <li key={l}>{l}</li>
                          ))}
                        </ul>
                      </details>
                    </section>
                  </>
                )}
                {page === 'Overview' && (
                  <>
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Objective snapshot</h2>
                        <span className="muted">
                          {snapshot.tasks.length} tasks · {snapshot.reviews.length} pending reviews
                        </span>
                      </div>
                      <TaskTable tasks={snapshot.tasks} onSelect={pickTask} now={connected ? now : snapshot.observedAt} />
                    </section>
                    <Providers snapshot={snapshot} />
                    <section className="panel compact">
                      <h2>Recent transitions</h2>
                      <Timeline events={snapshot.events.slice(-12)} />
                    </section>
                  </>
                )}
                {page === 'Objectives' && (
                  <>
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Tasks & dependencies</h2>
                        <span className="muted">{objectiveId || 'No objective selected'}</span>
                      </div>
                      <TaskTable tasks={snapshot.tasks} onSelect={pickTask} now={connected ? now : snapshot.observedAt} />
                    </section>
                    <section className="panel compact">
                      <UsageView usage={snapshot.usage} />
                    </section>
                    <section className="panel compact">
                      <h2>Objective timeline</h2>
                      <Timeline events={snapshot.events} />
                    </section>
                  </>
                )}
                {page === 'Runs' && (
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Persisted workflow runs</h2>
                      <span className="muted">Open execution details in Mastra</span>
                    </div>
                    {snapshot.tasks.some((t) => t.runIds.length) ? (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Run ID</th>
                              <th>Task</th>
                              <th>Scheduler state</th>
                              <th>Trace</th>
                            </tr>
                          </thead>
                          <tbody>
                            {snapshot.tasks.flatMap((t) =>
                              t.runIds.map((id) => (
                                <tr key={`${t.id}:${id}`}>
                                  <td className="mono">{id}</td>
                                  <td>
                                    <button className="text-button" onClick={() => pickTask(t.id)}>
                                      {t.id}
                                    </button>
                                  </td>
                                  <td>
                                    {id === t.runId ? (
                                      <Badge value={t.state} />
                                    ) : (
                                      <span className="muted">Historical · run outcome unknown</span>
                                    )}
                                  </td>
                                  <td>{id === t.runId ? <Trace task={t} /> : <span className="muted">Unknown trace URL</span>}</td>
                                </tr>
                              )),
                            )}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty>No persisted runs in this objective.</Empty>
                    )}
                  </section>
                )}
                {page === 'Reviews' && (
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Review queue</h2>
                      <span className="muted">Observation only</span>
                    </div>
                    {snapshot.reviews.length ? (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Task</th>
                              <th>Round</th>
                              <th>Requested</th>
                              <th>State</th>
                            </tr>
                          </thead>
                          <tbody>
                            {snapshot.reviews.map((r) => (
                              <tr key={r.id}>
                                <td>
                                  <button className="text-button" onClick={() => pickTask(r.taskId)}>
                                    {r.taskId}
                                  </button>
                                </td>
                                <td>{r.round}</td>
                                <td>{date(r.createdAt)}</td>
                                <td>
                                  <Badge value="REVIEW_PENDING" />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty>No pending review requests in this objective.</Empty>
                    )}
                  </section>
                )}
              </>
            )}
            <footer className="page-footer">
              <span>Scheduler is the source of truth</span>
              <span>{snapshot ? `Observed ${date(snapshot.observedAt)}` : 'Waiting for Gateway'}</span>
            </footer>
          </main>
          {snapshot && (agent || task) && (
            <Inspector
              key={`${selected?.kind}:${selected?.id}`}
              agent={agent}
              task={task}
              snapshot={snapshot}
              onClose={() => setSelected(null)}
              now={now}
              disconnected={!connected}
            />
          )}
        </div>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

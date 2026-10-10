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
import { claimElapsed, currentTasks, inspectorObservations, observedActivity, priced, taskUsage } from './observations.ts';
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
const date = (n: number | null) => (n === null ? 'UNKNOWN' : new Date(n).toLocaleString());
const duration = (n: number | null) =>
  n === null ? 'UNKNOWN' : n < 60000 ? `${Math.floor(n / 1000)}s` : `${Math.floor(n / 60000)}m ${Math.floor(n / 1000) % 60}s`;
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
function UsageView({ usage, title = 'Token usage', callCount }: { usage: Usage; title?: string; callCount?: number | null }) {
  return (
    <>
      <div className="section-heading">
        <h3>{title}</h3>
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
            ['Provider cost (USD)', priced(usage) ? usage.actualCostUsd : null],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={value === null ? 'muted' : ''}>{number(value)}</dd>
          </div>
        ))}
      </dl>
      {callCount !== undefined && (
        <dl className="details">
          <div>
            <dt>Reported calls</dt>
            <dd>{number(callCount)}</dd>
          </div>
        </dl>
      )}
      <p className="footnote">¹ Detail counts are subsets, never added to input/output totals.</p>
      <dl className="details">
        <div>
          <dt>Estimated cost</dt>
          <dd>
            {priced(usage)
              ? `$${usage.estimatedCost!.usd} · ${usage.estimatedCost!.modelId} · ${usage.estimatedCost!.pricingSource}`
              : 'UNKNOWN · model/pricing unavailable'}
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
function AgentMeasurements({
  agent,
  snapshot,
  now,
  connected,
  part = 'both',
}: {
  agent: ControlAgent;
  snapshot: Snapshot;
  now: number;
  connected: boolean;
  part?: 'both' | 'elapsed' | 'tokens';
}) {
  const tasks = currentTasks(snapshot, agent);
  return tasks.length ? (
    <>
      {tasks.map((t) => {
        const usage = taskUsage(snapshot, t);
        return (
          <div key={t.id} className="agent-measurement" title={`Task ${t.id}`}>
            {part !== 'tokens' && <span className="mono">{duration(claimElapsed(t, now, connected))}</span>}
            {part !== 'elapsed' && (
              <small>
                {number(usage.inputTokens)} in / {number(usage.outputTokens)} out
              </small>
            )}
          </div>
        );
      })}
    </>
  ) : (
    <span className="muted">UNKNOWN</span>
  );
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
  const [tab, setTab] = useState<'Overview' | 'Usage' | 'Runs'>('Overview');
  const observations = inspectorObservations(snapshot, agent, task);
  const tasks = task ? [task] : observations.assigned;
  const history = observations.history;
  const activity = disconnected
    ? 'UNKNOWN'
    : task
      ? task.stale || (['RUNNING', 'VERIFYING'].includes(task.activity) && task.leaseExpiresAt !== null && task.leaseExpiresAt <= now)
        ? 'UNKNOWN'
        : task.activity
      : agent
        ? observedActivity(agent, observations.assigned, true, now)
        : 'UNKNOWN';
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
      <div className="inspector-tabs" role="tablist" aria-label="Inspector sections">
        {(['Overview', 'Usage', 'Runs'] as const).map((name, index, tabs) => (
          <button
            key={name}
            id={`inspector-tab-${name}`}
            role="tab"
            aria-selected={tab === name}
            aria-controls="inspector-panel"
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
            onKeyDown={(e) => {
              const next =
                e.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : e.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? tabs.length - 1
                        : null;
              if (next !== null) {
                e.preventDefault();
                setTab(tabs[next]!);
                document.getElementById(`inspector-tab-${tabs[next]}`)?.focus();
              }
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        className="inspector-body inspector-panel"
        role="tabpanel"
        id="inspector-panel"
        aria-labelledby={`inspector-tab-${tab}`}
        tabIndex={0}
      >
        {disconnected && <p className="notice">Disconnected. Details below are the last observed snapshot.</p>}
        {tab === 'Overview' && (
          <>
            <div className="section-heading">
              <h3>Current activity</h3>
              <Badge value={activity} />
            </div>
            <dl className="details">
              <div>
                <dt>Provider</dt>
                <dd>{task?.provider ?? agent?.provider}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>
                  {agent?.modelId ??
                    (observations.current.length && observations.current.every((c) => c.modelId === observations.current[0]!.modelId)
                      ? observations.current[0]!.modelId
                      : null) ??
                    'UNKNOWN'}
                </dd>
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
                <dt>Last observed event</dt>
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
                        <dd>{duration(claimElapsed(t, now, !disconnected))}</dd>
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
                <>
                  <p className="muted">No current assignment observed.</p>
                  {history.find((r) => r.id !== null && r.id === r.task.runId && r.task.traceUrl) && (
                    <p className="footnote">
                      Latest recorded run:{' '}
                      <Trace task={history.find((r) => r.id !== null && r.id === r.task.runId && r.task.traceUrl)!.task} />
                    </p>
                  )}
                </>
              )}
              <p className="footnote">
                ² Time since scheduler claim, including preparation and waiting. Inference duration is unavailable.
              </p>
            </section>
          </>
        )}
        {tab === 'Usage' && (
          <>
            <UsageView title="Current run usage" usage={observations.currentUsage} callCount={observations.current.length || null} />
            <p className="footnote">Current assignment runs only. Task totals are not substituted for run usage.</p>
            <section>
              <UsageView
                title="Historical reported usage"
                usage={observations.historicalUsage}
                callCount={observations.historical.length || null}
              />
              <p className="footnote">
                Other runs in this selected objective only. Reported call observations may be incomplete; retries and cancelled calls are
                counted once when reported. UNKNOWN does not mean zero.
              </p>
            </section>
          </>
        )}
        {tab === 'Runs' && (
          <>
            <section className="run-list">
              <h3>
                Recent tasks / runs <span className="count">{history.length}</span>
              </h3>
              {history.length ? (
                history.map((r) => (
                  <div className="assignment" key={`${r.task.id}:${r.id ?? 'no-run'}`}>
                    <strong>{r.task.title}</strong>
                    <small className="mono">{r.id ?? 'Run ID UNKNOWN'}</small>
                    <dl className="details">
                      <div>
                        <dt>Execution duration</dt>
                        <dd>UNKNOWN</dd>
                      </div>
                      <div>
                        <dt>Retry count</dt>
                        <dd>UNKNOWN</dd>
                      </div>
                      <div>
                        <dt>Final run outcome</dt>
                        <dd>UNKNOWN</dd>
                      </div>
                      <div>
                        <dt>Task state</dt>
                        <dd>{r.task.state}</dd>
                      </div>
                    </dl>
                    {r.id !== null && r.id === r.task.runId ? <Trace task={r.task} /> : <span className="muted">Trace unavailable</span>}
                  </div>
                ))
              ) : (
                <p className="muted">No recent tasks or runs in this objective.</p>
              )}
              <p className="footnote">
                Per-run duration, retries and final outcome are not exposed by Core. The task state is shown separately.
              </p>
            </section>
            <section>
              <h3>Execution timeline</h3>
              <Timeline events={events} />
            </section>
          </>
        )}
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
                  {number(priced(p.usage) ? p.usage.actualCostUsd : null)} / {number(p.quota)}
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
                              <th>Elapsed / task tokens</th>
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
                                  <Badge value={observedActivity(a, currentTasks(snapshot, a), connected, now)} />
                                </td>
                                <td>
                                  {currentTasks(snapshot, a).length ? (
                                    currentTasks(snapshot, a).map(({ id }) => (
                                      <button key={id} className="text-button assignment-link" onClick={() => pickTask(id)}>
                                        {id}
                                      </button>
                                    ))
                                  ) : (
                                    <span className="muted">No assignment observed</span>
                                  )}
                                </td>
                                <td>
                                  <AgentMeasurements agent={a} snapshot={snapshot} now={now} connected={connected} />
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
                        <h2>Agent activity</h2>
                        <span className="muted">Current task usage · selected objective</span>
                      </div>
                      <div className="table-scroll">
                        <table aria-label="Agent activity">
                          <thead>
                            <tr>
                              <th>Agent</th>
                              <th>Activity</th>
                              <th>Current Task</th>
                              <th>Elapsed</th>
                              <th>Tokens</th>
                              <th>Last Outcome</th>
                            </tr>
                          </thead>
                          <tbody>
                            {snapshot.agents.map((a) => {
                              const assigned = currentTasks(snapshot, a);
                              return (
                                <tr key={a.id}>
                                  <td>
                                    <button className="text-button" onClick={() => setSelected({ kind: 'agent', id: a.id })}>
                                      {a.name}
                                    </button>
                                  </td>
                                  <td>
                                    <Badge value={observedActivity(a, assigned, connected, now)} />
                                  </td>
                                  <td>
                                    {assigned.length ? (
                                      assigned.map((t) => (
                                        <button key={t.id} className="text-button assignment-link" onClick={() => pickTask(t.id)}>
                                          {t.id}
                                        </button>
                                      ))
                                    ) : (
                                      <span className="muted">No assignment observed</span>
                                    )}
                                  </td>
                                  <td>
                                    <AgentMeasurements agent={a} snapshot={snapshot} now={now} connected={connected} part="elapsed" />
                                  </td>
                                  <td>
                                    <AgentMeasurements agent={a} snapshot={snapshot} now={now} connected={connected} part="tokens" />
                                  </td>
                                  <td>{a.lastOutcome ? <Badge value={a.lastOutcome} /> : 'UNKNOWN'}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <p className="panel-note">Elapsed is time since the scheduler claim, including preparation and waiting.</p>
                    </section>

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

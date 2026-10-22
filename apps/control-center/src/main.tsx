import { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowUpRight,
  ChevronRight,
  CircleHelp,
  GitBranch,
  Layers,
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
import { CollaborationView } from './collaboration.tsx';
import { AgentsView } from './agents.tsx';
import './style.css';
const embedded = window.location.pathname.startsWith('/organization-app/');
const apiBase = embedded ? '/control-center/v1' : '/api/v1';

type Page = 'Overview' | 'Runs' | 'Collaboration' | 'Usage';
const pages = [
  { name: 'Overview', icon: Layers },
  { name: 'Runs', icon: Activity },
  { name: 'Collaboration', icon: Network },
  { name: 'Usage', icon: Activity },
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
    <a className="trace" href={task.traceUrl} target={embedded ? "_top" : "_blank"} rel="noreferrer">
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
    fetch(`${apiBase}/snapshot${query}`, { signal: abort.signal })
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
    const stream = new EventSource(`${apiBase}/events${query}`);
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
      <table className="task-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Provider / worker</th>
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
              <td>{t.provider}<small>{t.workerId ?? 'Worker UNKNOWN'}</small></td>
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
            {task && <section aria-label="Task execution evidence">
              <h3>Task execution evidence</h3>
              <dl className="details">
                <div><dt>Scheduler batch</dt><dd>{task.objectiveId}</dd></div>
                <div><dt>Project</dt><dd>{snapshot.objectives.find(o => o.id === task.objectiveId)?.label ?? 'UNKNOWN'}</dd></div>
                <div><dt>Coding attempts (all runs)</dt><dd>{task.execution?.attempts ?? 'UNKNOWN'}</dd></div>
                <div><dt>Runtime retries</dt><dd>{task.execution?.runtimeRetries ?? 'UNKNOWN'}</dd></div>
                <div><dt>Runtime requeues</dt><dd>{task.execution?.runtimeRequeues ?? 'UNKNOWN'}</dd></div>
                <div><dt>Created</dt><dd>{date(task.execution?.createdAt ?? null)}</dd></div>
                <div><dt>Claimed</dt><dd>{date(task.claimedAt)}</dd></div>
                <div><dt>Updated</dt><dd>{date(task.updatedAt)}</dd></div>
                <div><dt>Finished</dt><dd>{date(task.execution?.finishedAt ?? null)}</dd></div>
                <div><dt>Failure / escalation category</dt><dd>{task.execution?.failureCategory ?? 'UNKNOWN · no recognized category reported'}</dd></div>
                <div><dt>Recorded verifier exit code</dt><dd>{task.execution?.verifierExitCode ?? 'UNKNOWN'}</dd></div>
                <div><dt>Review outcome</dt><dd>{task.execution?.reviewOutcome ?? 'UNKNOWN'}</dd></div>
                <div><dt>Pending review rounds</dt><dd>{snapshot.reviews.filter(r => r.taskId === task.id).map(r => `${r.round} (${date(r.createdAt)})`).join(', ') || 'None reported'}</dd></div>
              </dl>
              <h3>Recorded change-review findings</h3>
              {task.execution?.findings == null ? <p className="muted">UNKNOWN · no findings record exposed</p> : task.execution.findings.length ? <ul>{task.execution.findings.map((f, i) => <li key={i}><Badge value={f.severity.toUpperCase()} /> {f.code}</li>)}</ul> : <p className="muted">No recognized findings in the recorded result.</p>}
              {!!task.execution?.findingsOmitted && <p className="notice">{task.execution.findingsOmitted} findings omitted (unrecognized or beyond the 50-finding limit).</p>}
              <p className="footnote">Recorded verifier exit code and change-review findings describe the persisted task result, not every workflow run. Acceptance artifacts, finding details and free-form failure reasons are unavailable in this safe projection. Task state is not a verifier PASS. Agent/model identity and historical worker assignments are not inferred from provider or current worker.</p>
              <p className="footnote">Associated Council meetings: unavailable without a verified task-to-meeting correlation. Inspect preserved records in Collaboration → Council.</p>
            </section>}
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
                Per-run duration, retries and final outcome are not exposed by Core; task execution counters, where shown, are totals across runs. The task state is shown separately.
              </p>
            </section>
            <section>
              <h3>{task ? 'Persisted lifecycle & recovery events' : 'Execution timeline'}</h3>
              <Timeline events={events} />
              {task && <p className="footnote">Latest 200 batch events only. Same-state audit events include recovery; sensitive reasons and payloads are withheld.</p>}
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
              <strong>{e.operation ?? e.type}</strong>
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
  const [page, setPage] = useState<Page>('Overview');
  const [objectiveId, setObjective] = useState('');
  const [project, setProject] = useState('');
  const [status, setStatus] = useState('');
  const [collaborationKind, setCollaborationKind] = useState<'Discussions' | 'Meetings' | 'Council'>('Discussions');
  const [selected, setSelected] = useState<{ kind: 'agent' | 'task'; id: string } | null>(null);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('control-center-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    if (!embedded) return;
    window.parent.postMessage({ type: 'organization-ready' }, window.location.origin);
    const parent = window.parent.document.documentElement;
    const sync = () => setTheme(parent.classList.contains('dark') || parent.dataset.theme === 'dark' ? 'dark' : 'light');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(parent, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);
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
    <div className={`app ${embedded ? 'embedded' : ''}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {!embedded && <nav className="sidebar" aria-label="Primary">
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
          </button>
        ))}
        <div className="sidebar-bottom">
          <span className="read-only">
            <span className="square" />
            Read-only workspace
          </span>
          <p>No execution controls</p>
        </div>
      </nav>}
      <div className="workspace">
        {embedded && <nav className="organization-tabs" aria-label="Organization views">{pages.map(({name}) => <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => { setPage(name); setSelected(null); }}>{name}</button>)}</nav>}
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
                  Persisted execution evidence. Observation only.
                </p>
              </div>
              <span className="version">READ ONLY</span>
            </div>
            {page === 'Runs' && <div className="scope-bar">
              <label htmlFor="project">Project</label>
              <select id="project" value={project} onChange={e => { setProject(e.target.value); setObjective(''); setStatus(''); setSelected(null); }}>
                <option value="">All projects</option>
                {[...new Set(snapshot?.objectives.map(o => o.label) ?? [])].map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <label htmlFor="objective">Objective / scheduler batch</label>
              <select
                id="objective"
                value={objectiveId}
                onChange={(e) => {
                  setObjective(e.target.value);
                  setStatus('');
                  setSelected(null);
                }}
              >
                <option value="">Select a scheduler batch</option>
                {snapshot?.objectives.filter(o => !project || o.label === project).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.id} · {o.label}
                  </option>
                ))}
              </select>
              <label htmlFor="task-status">Task status</label>
              <select id="task-status" value={status} onChange={e => { setStatus(e.target.value); setSelected(null); }}>
                <option value="">All statuses</option>
                {[...new Set(snapshot?.tasks.map(t => t.state) ?? [])].sort().map(s => <option key={s}>{s}</option>)}
              </select>
            </div>}
            {objectiveId && page !== 'Runs' && page !== 'Collaboration' && <p className="muted">Reported scope: {objectiveId} · change scope in Runs.</p>}
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
            {!objectiveId && page !== 'Collaboration' && (
              <div className="notice">
                Choose a scheduler batch in Runs to inspect execution. If none are listed, this data source has no persisted batches. Agent roles do not indicate online presence.
              </div>
            )}
            {page === 'Collaboration' && <>
              <nav className="organization-tabs" aria-label="Collaboration views">
                {(['Discussions', 'Meetings', 'Council'] as const).map(kind => <button key={kind} aria-current={collaborationKind === kind ? 'page' : undefined} onClick={() => setCollaborationKind(kind)}>{kind}</button>)}
              </nav>
              <CollaborationView key={collaborationKind} kind={collaborationKind} apiBase={apiBase} />
            </>}
            {page === 'Runs' && <p className="notice">Project labels come from scheduler batches. Milestone filtering and external Claude Code sessions are unavailable: no durable metadata contract is exposed. A scheduler batch, task, workflow run, model call and Council meeting are distinct identities.</p>}
            {page === 'Overview' && <p><a href="/agents" target={embedded ? '_top' : '_blank'} rel="noreferrer">Open Mastra Agents ↗</a></p>}
            {snapshot && (
              <>
                {page === 'Overview' && (
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
                      <div className="panel-note" aria-label="Verifier role"><strong>Verifier</strong> · Deterministic runtime verification role · Activity UNKNOWN. Individual verifier identity and heartbeat are not exposed by Core.</div>
                    </section>
                    <details><summary>Registered agent bindings</summary><AgentsView apiBase={apiBase} /></details>
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
                {page === 'Runs' && (
                  <>
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Tasks & dependencies</h2>
                        <span className="muted">{objectiveId || 'No objective selected'}</span>
                      </div>
                      <TaskTable tasks={snapshot.tasks.filter(t => !status || t.state === status)} onSelect={pickTask} now={connected ? now : snapshot.observedAt} />
                    </section>
                    <section className="panel">
                      <div className="panel-heading"><h2>Objective DAG</h2><span className="muted">Persisted dependency edges</span></div>
                      {snapshot.tasks.length ? <div className="table-scroll"><table aria-label="Objective DAG"><thead><tr><th>Task</th><th>Depends on</th></tr></thead><tbody>{snapshot.tasks.map(t => <tr key={t.id}><td><button className="text-button" onClick={() => pickTask(t.id)}>{t.id}</button></td><td>{t.dependsOn.length ? t.dependsOn.map(id => <button className="text-button assignment-link" key={id} onClick={() => pickTask(id)}>{id}</button>) : 'None'}</td></tr>)}</tbody></table></div> : <Empty>No dependency graph in this scope.</Empty>}
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
                {page === 'Usage' && <><section className="panel usage-panel"><UsageView usage={snapshot.usage} title="Objective usage" /></section><Providers snapshot={snapshot} /></>}
                {page === 'Runs' && (
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

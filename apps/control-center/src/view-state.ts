import type { ControlTask, ModelCall, Snapshot, Usage } from '../../../src/integrations/control-center/contract.ts';
import { filterByStatus, usageForCalls } from './observations.ts';

/**
 * The console's shared scope and per-section filters, kept in the URL query so a link reproduces the view and browser
 * navigation restores it. Parsing is strict: an unknown value falls back to its default instead of being guessed.
 */
export const SECTIONS = ['overview', 'runs', 'collaboration', 'usage'] as const;
export const WINDOWS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 } as const;
export type Window = keyof typeof WINDOWS | '';
export interface ViewState {
  section: (typeof SECTIONS)[number];
  /** batches.project; '' is every project. Ignored when `unattributed`. */
  project: string;
  /** One scheduler batch; '' is all objectives of the project. */
  objective: string;
  /** Records with no authoritative project association (collaboration and Council), never assigned to a project. */
  unattributed: boolean;
  status: string;
  provider: string;
  worker: string;
  updated: Window;
  collab: 'discussions' | 'meetings' | 'council';
  participant: string;
  mode: '' | 'LIVE' | 'SCRIPTED';
  decision: '' | 'recorded' | 'none' | 'contested';
  range: Window;
  callProvider: string;
  model: string;
  callWorker: string;
  completeness: '' | 'complete' | 'partial';
}
export const DEFAULT_VIEW: ViewState = {
  section: 'overview', project: '', objective: '', unattributed: false, status: '', provider: '', worker: '', updated: '',
  collab: 'discussions', participant: '', mode: '', decision: '', range: '', callProvider: '', model: '', callWorker: '', completeness: '',
};
const text = (v: string | null) => (v !== null && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v) ? v : '');
const pick = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T => ((allowed as readonly string[]).includes(v ?? '') ? ((v ?? '') as T) : fallback);
const windows = ['', ...Object.keys(WINDOWS)] as Window[];

export function parseView(search: string): ViewState {
  const q = new URLSearchParams(search);
  const unattributed = q.get('scope') === 'unattributed';
  return {
    section: pick(q.get('section'), SECTIONS, 'overview'),
    project: unattributed ? '' : text(q.get('project')),
    objective: unattributed || !/^[A-Za-z0-9._-]{1,200}$/.test(q.get('objective') ?? '') ? '' : q.get('objective')!,
    unattributed,
    status: text(q.get('status')),
    provider: text(q.get('provider')),
    worker: text(q.get('worker')),
    updated: pick(q.get('updated'), windows, ''),
    collab: pick(q.get('collab'), ['discussions', 'meetings', 'council'] as const, 'discussions'),
    participant: text(q.get('participant')),
    mode: pick(q.get('mode'), ['', 'LIVE', 'SCRIPTED'] as const, ''),
    decision: pick(q.get('decision'), ['', 'recorded', 'none', 'contested'] as const, ''),
    range: pick(q.get('range'), windows, ''),
    callProvider: text(q.get('callProvider')),
    model: text(q.get('model')),
    callWorker: text(q.get('callWorker')),
    completeness: pick(q.get('completeness'), ['', 'complete', 'partial'] as const, ''),
  };
}
/** Only non-default values, in a fixed order, so equal views produce equal links. */
export function serializeView(view: ViewState): string {
  const q = new URLSearchParams();
  for (const key of Object.keys(DEFAULT_VIEW) as (keyof ViewState)[]) {
    if (key === 'unattributed') { if (view.unattributed) q.set('scope', 'unattributed'); continue; }
    const value = view[key];
    if (value !== DEFAULT_VIEW[key] && value !== '') q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
/** The scope part of a view: what the Gateway is asked for. */
export const scopeQuery = (view: ViewState) => {
  const q = new URLSearchParams();
  if (view.unattributed) return '';
  if (view.project) q.set('project', view.project);
  if (view.objective) q.set('objectiveId', view.objective);
  const s = q.toString();
  return s ? `?${s}` : '';
};

const within = (at: number | null, window: Window, now: number) => !window || (at !== null && now - at <= WINDOWS[window]);

export function filterRuns(tasks: readonly ControlTask[], view: Pick<ViewState, 'status' | 'provider' | 'worker' | 'updated'>, now: number): ControlTask[] {
  return filterByStatus(tasks, view.status).filter(
    (t) => (!view.provider || t.provider === view.provider) && (!view.worker || t.workerId === view.worker) && within(t.updatedAt, view.updated, now),
  );
}
export function filterCalls(calls: readonly ModelCall[], view: Pick<ViewState, 'range' | 'callProvider' | 'model' | 'callWorker' | 'completeness'>, now: number): ModelCall[] {
  return calls.filter(
    (c) =>
      within(c.finishedAt ?? c.startedAt, view.range, now) &&
      (!view.callProvider || c.provider === view.callProvider) &&
      (!view.model || c.modelId === view.model) &&
      (!view.callWorker || c.workerId === view.callWorker) &&
      (!view.completeness || (view.completeness === 'complete') === (c.usage.completeness === 'complete')),
  );
}
/**
 * Usage of a filtered set of recorded invocations. A filter narrows what is summed; it can never make coverage better than
 * the scope's own: when the scope total is not complete, neither is any filtered total.
 */
export function filteredUsage(snapshot: Snapshot, calls: readonly ModelCall[]): Usage {
  const ids = snapshot.scope?.objectiveIds ?? (snapshot.objectiveId ? [snapshot.objectiveId] : []);
  const usage = usageForCalls([...calls], ids);
  const scopeGap = snapshot.usage.source !== 'unavailable' && snapshot.usage.completeness !== 'complete';
  return scopeGap && usage.completeness === 'complete' ? { ...usage, completeness: 'partial' } : usage;
}

/** Collaboration records carry a persisted attribution; the scope selects by it and never by title, label or time. */
export interface Attributed { attribution: { status: 'ATTRIBUTED' | 'UNATTRIBUTED'; batchId: string | null; project: string | null } }
export function inScope<T extends Attributed>(items: readonly T[], view: Pick<ViewState, 'project' | 'objective' | 'unattributed'>): T[] {
  if (view.unattributed) return items.filter((i) => i.attribution.status === 'UNATTRIBUTED');
  if (view.objective) return items.filter((i) => i.attribution.status === 'ATTRIBUTED' && i.attribution.batchId === view.objective);
  if (view.project) return items.filter((i) => i.attribution.status === 'ATTRIBUTED' && i.attribution.project === view.project);
  return [...items];
}
interface MeetingLike extends Attributed {
  participants: { id: string }[];
  decisions: unknown[];
  disagreements: unknown[];
  council?: { mode: 'LIVE' | 'SCRIPTED' } | null;
}
export function filterMeetings<T extends MeetingLike>(meetings: readonly T[], view: Pick<ViewState, 'participant' | 'mode' | 'decision'>): T[] {
  return meetings.filter(
    (m) =>
      (!view.participant || m.participants.some((p) => p.id === view.participant)) &&
      // A meeting without a verified council record has no mode; it never matches a LIVE/SCRIPTED filter.
      (!view.mode || m.council?.mode === view.mode) &&
      (!view.decision ||
        (view.decision === 'recorded' && m.decisions.length > 0) ||
        (view.decision === 'none' && m.decisions.length === 0) ||
        (view.decision === 'contested' && m.disagreements.length > 0)),
  );
}

/** Why a section is empty: never a blank list that could mean any of these. */
export type EmptyReason = 'UNAVAILABLE' | 'NO_SCOPE' | 'NO_RECORDS' | 'FILTERED_OUT' | 'NOT_RECORDED';
export const EMPTY_TEXT: Record<EmptyReason, string> = {
  UNAVAILABLE: 'Data source unavailable: nothing could be read. This is not an empty result.',
  NO_SCOPE: 'Select a project (or one of its objectives) to scope this view.',
  NO_RECORDS: 'No records in the selected scope.',
  FILTERED_OUT: 'Records exist in this scope, but none match the current filters.',
  NOT_RECORDED: 'Telemetry not recorded for this scope: runs exist, but no worker invocation telemetry was persisted for them.',
};
export function emptyReason(input: { connected: boolean; scoped: boolean; inScope: number; shown: number; notRecorded?: boolean }): EmptyReason | null {
  if (!input.connected) return 'UNAVAILABLE';
  if (!input.scoped) return 'NO_SCOPE';
  if (input.notRecorded) return 'NOT_RECORDED';
  if (input.inScope === 0) return 'NO_RECORDS';
  if (input.shown === 0) return 'FILTERED_OUT';
  return null;
}

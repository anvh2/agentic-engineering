import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { councilDbPath } from '../../runtime/council/run.ts';
import { idSchema } from '../../runtime/collaboration/types.ts';
import { createCollaborationReader, type CollaborationMeeting, type CollaborationView } from './collaboration-adapter.ts';

/**
 * Read-only view of the engineering council for the Organization page.
 *
 * Council meetings are Core B meetings in their own database (`.workdir/council/council.db`), so they are read with the same
 * read-only, hash-chain-verified collaboration reader as the scheduler's meetings: no second meeting model, no copy. The council
 * adds per-meeting files it derives from those events (sidecar, record, workflow runs, call journal). Those are trusted only when
 * they point back at the verified events: the sidecar names the session, and the council record's meeting-record hash, chain
 * hash and event coverage equal what Core B just verified. Otherwise the meeting is still shown from Core B's events, with an
 * integrity note and none of the council's own claims (mode, model, runs, traces).
 */

export interface CouncilAnnotation {
  meetingId: string;
  mode: 'LIVE' | 'SCRIPTED';
  /** The model the sidecar recorded for every seat: `provider/model`. SCRIPTED meetings say `scripted/...`. */
  model: string;
  /** Repository-relative source files; opened with `npm run council -- show <meetingId>`. */
  recordPath: string;
  workflowRuns: { runId: string; url: string }[];
  traceIds: string[];
  modelCalls: number;
  toolCalls: { tool: string; count: number }[];
  /** Turns whose cited files were not read with a file tool in that call (the record flags each). */
  integrity: 'VERIFIED';
}
export type CouncilMeeting = CollaborationMeeting & { council: CouncilAnnotation | null; councilIssue: string | null };
export type CouncilView = Omit<CollaborationView, 'meetings'> & { meetings: CouncilMeeting[]; councilDir: string };

const MAX_JSONL_BYTES = 2 * 1024 * 1024;
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
const TRACE_ID = /^[a-f0-9]{16,64}$/;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  if (text.length > MAX_JSONL_BYTES) throw new Error(`${path} is larger than ${MAX_JSONL_BYTES} bytes`);
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
}

interface Sidecar { meetingId: string; sessionId: string; mode: string; model: { provider: string; model: string } }
interface CouncilRecordFile { meetingId: string; mode: string; integrity: { meetingRecordHash: string; throughSeq: number; throughHash: string } }
interface CallLine { traceId?: unknown; toolCalls?: unknown; outcome?: unknown }

/** Council meetings by session id, from the per-meeting directories. Only directory names that are valid ids are opened. */
function sidecars(dir: string): Map<string, { dir: string; sidecar: Sidecar }> {
  const out = new Map<string, { dir: string; sidecar: Sidecar }>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!idSchema.safeParse(name).success) continue;
    const path = join(dir, name, 'meeting.json');
    if (!existsSync(path)) continue;
    try {
      const s = readJson(path) as Sidecar;
      if (s.meetingId === name && typeof s.sessionId === 'string') out.set(s.sessionId, { dir: join(dir, name), sidecar: s });
    } catch { /* unreadable sidecar: the meeting is shown without council annotations */ }
  }
  return out;
}

function annotate(meeting: CollaborationMeeting, entry: { dir: string; sidecar: Sidecar } | undefined, studioOrigin: string): CouncilMeeting {
  const plain = (issue: string | null): CouncilMeeting => ({ ...meeting, council: null, councilIssue: issue });
  if (!entry) return plain('No council sidecar names this session; shown from Core B events only.');
  const { sidecar, dir } = entry;
  if (sidecar.mode !== 'LIVE' && sidecar.mode !== 'SCRIPTED') return plain(`Council sidecar has an unknown mode: ${String(sidecar.mode).slice(0, 40)}`);
  // Every participant identity in the verified events must be the model the sidecar claims, so LIVE/SCRIPTED cannot be relabelled.
  const claimed = `${sidecar.model.provider}/${sidecar.model.model}`;
  const seen = [...new Set(meeting.participants.map((p) => `${p.provider ?? 'UNKNOWN'}/${p.model ?? 'UNKNOWN'}`))];
  if (seen.length !== 1 || seen[0] !== claimed) return plain(`Council sidecar claims ${claimed}, but the verified participants are ${seen.join(', ') || 'none'}.`);
  if ((sidecar.mode === 'SCRIPTED') !== (sidecar.model.provider === 'scripted')) return plain(`Council sidecar mode ${sidecar.mode} disagrees with provider ${sidecar.model.provider}.`);

  if (meeting.provenance) {
    const recordPath = join(dir, 'record.json');
    if (!existsSync(recordPath)) return plain('The meeting concluded but its council record is missing.');
    let rec: CouncilRecordFile;
    try { rec = readJson(recordPath) as CouncilRecordFile; } catch { return plain('The council record is unreadable.'); }
    const p = meeting.provenance;
    if (rec.meetingId !== sidecar.meetingId || rec.mode !== sidecar.mode
      || rec.integrity?.meetingRecordHash !== p.recordHash || rec.integrity?.throughSeq !== p.throughSeq || rec.integrity?.throughHash !== p.throughHash) {
      return plain('The council record does not match the verified meeting record (hash or event coverage differs); its claims are not shown.');
    }
  }

  let runs: CouncilAnnotation['workflowRuns'] = [];
  let calls: CallLine[] = [];
  try {
    runs = readJsonl(join(dir, 'workflow-runs.jsonl')).map((r) => (r as { runId?: unknown }).runId).filter((id): id is string => typeof id === 'string' && RUN_ID.test(id))
      .filter((id, i, all) => all.indexOf(id) === i)
      .map((runId) => ({ runId, url: `${studioOrigin}/workflows/engineering-council-workflow/graph/${runId}` }));
    calls = readJsonl(join(dir, 'calls.jsonl')) as CallLine[];
  } catch { return plain('The council call journal or workflow-run log is unreadable.'); }
  const tools = new Map<string, number>();
  for (const c of calls) for (const t of Array.isArray(c.toolCalls) ? (c.toolCalls as { tool?: unknown; count?: unknown }[]) : []) {
    if (typeof t.tool === 'string' && typeof t.count === 'number') tools.set(t.tool, (tools.get(t.tool) ?? 0) + t.count);
  }
  return {
    ...meeting,
    councilIssue: null,
    council: {
      meetingId: sidecar.meetingId, mode: sidecar.mode, model: claimed,
      recordPath: `.workdir/council/${sidecar.meetingId}/record.md`,
      workflowRuns: runs,
      traceIds: [...new Set(calls.map((c) => c.traceId).filter((t): t is string => typeof t === 'string' && TRACE_ID.test(t)))],
      modelCalls: calls.length,
      toolCalls: [...tools.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tool, count]) => ({ tool, count })),
      integrity: 'VERIFIED',
    },
  };
}

export function createCouncilReader(options: { workdir: string; studioOrigin: string }) {
  const councilDir = join(options.workdir, 'council');
  const dbPath = councilDbPath(options.workdir);
  const collaboration = createCollaborationReader({ dbPath });
  const shape = (view: CollaborationView, reason?: string): CouncilView => {
    const bySession = view.availability === 'AVAILABLE' ? sidecars(councilDir) : new Map();
    return { ...view, ...(reason && view.availability === 'NOT_AVAILABLE' ? { reason } : {}), councilDir, meetings: view.meetings.map((m) => annotate(m, bySession.get(m.id), options.studioOrigin)) };
  };
  return {
    snapshot(): CouncilView {
      if (!existsSync(dbPath)) return shape({ availability: 'NOT_AVAILABLE', source: 'unavailable', reason: null, cursor: null, threads: [], meetings: [] }, 'No council meetings have been held in this checkout (.workdir/council/council.db does not exist).');
      return shape(collaboration.snapshot());
    },
    cursor: () => (existsSync(dbPath) ? collaboration.cursor() : 0),
    feed: (afterSeq: number, limit?: number) => (existsSync(dbPath) ? collaboration.feed(afterSeq, limit) : { events: [], cursor: afterSeq, hasMore: false }),
  };
}
export type CouncilReader = ReturnType<typeof createCouncilReader>;

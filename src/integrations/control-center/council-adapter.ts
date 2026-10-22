import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { councilDbPath } from '../../runtime/council/run.ts';
import { councilRecordIntact, type CouncilRecord } from '../../runtime/council/record.ts';
import { idSchema } from '../../runtime/collaboration/types.ts';
import { createCollaborationReader, type CollaborationMeeting, type CollaborationView } from './collaboration-adapter.ts';

/**
 * Read-only view of the engineering council for the Organization page.
 *
 * Council meetings are Core B meetings in their own database (`.workdir/council/council.db`), so they are read with the same
 * read-only, hash-chain-verified collaboration reader as the scheduler's meetings: no second meeting model, no copy. The council
 * adds per-meeting files it derives from those events (sidecar, record, workflow runs, call journal). Those are trusted only when
 * they point back at the verified events: the sidecar names the session, and the council record's meeting-record hash, chain
 * hash and event coverage equal what Core B just verified, and the record's own hash verifies; runs, call counts and traces are
 * then taken from that record, never from the raw logs. An open meeting has no record yet: it shows only the mode/model checked
 * against its events and the trace ids on its verified messages. Otherwise the meeting is still shown from Core B's events, with
 * an integrity note and none of the council's own claims.
 */

export interface CouncilAnnotation {
  meetingId: string;
  mode: 'LIVE' | 'SCRIPTED';
  /** The model every participant identity in the verified events carries: `provider/model`. SCRIPTED meetings say `scripted/...`. */
  model: string;
  /** Repository-relative source files; opened with `npm run council -- show <meetingId>`. */
  recordPath: string;
  /**
   * RECORD_VERIFIED: the meeting concluded and its council record is intact (self-hash) and covers exactly the events Core B
   * verified; runs, calls and traces below come from that record. OPEN_UNRECORDED: no record exists yet; only the mode/model
   * (checked against the events) and trace ids reported on verified messages are shown.
   */
  integrity: 'RECORD_VERIFIED' | 'OPEN_UNRECORDED';
  workflowRuns: { runId: string; url: string }[];
  traceIds: string[];
  /** Model calls journaled by the council, and how many of those failed (no reply); null while no record exists. */
  modelCalls: number | null;
  failedCalls: number | null;
  toolCalls: { tool: string; count: number }[] | null;
}
export type CouncilMeeting = CollaborationMeeting & { council: CouncilAnnotation | null; councilIssue: string | null };
export type CouncilView = Omit<CollaborationView, 'meetings'> & { meetings: CouncilMeeting[] };

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
const TRACE_ID = /^[a-f0-9]{16,64}$/;

/** A regular file inside the meeting directory, bounded before it is read. Symlinks are refused. */
function readJson(path: string): unknown {
  const info = lstatSync(path);
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`${path} is larger than ${MAX_FILE_BYTES} bytes`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

interface Sidecar { meetingId: string; sessionId: string; mode: string; model: { provider: string; model: string } }

/**
 * Council meetings by session id. Only directories whose names are valid ids and whose sidecar names that same meeting and the
 * session id the council derives from it (`council-<meetingId>`, run.ts) are used; two sidecars claiming one session are both
 * dropped.
 */
function sidecars(dir: string): Map<string, { dir: string; sidecar: Sidecar } | 'duplicate'> {
  const out = new Map<string, { dir: string; sidecar: Sidecar } | 'duplicate'>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!idSchema.safeParse(name).success) continue;
    const meetingDir = join(dir, name);
    try {
      if (!lstatSync(meetingDir).isDirectory()) continue;
      const path = join(meetingDir, 'meeting.json');
      if (!existsSync(path)) continue;
      const s = readJson(path) as Sidecar;
      if (s.meetingId !== name || s.sessionId !== `council-${name}`) continue;
      out.set(s.sessionId, out.has(s.sessionId) ? 'duplicate' : { dir: meetingDir, sidecar: s });
    } catch { /* unreadable sidecar: the meeting is shown without council annotations */ }
  }
  return out;
}

function annotate(meeting: CollaborationMeeting, thread: CollaborationView['threads'][number] | undefined, entry: { dir: string; sidecar: Sidecar } | 'duplicate' | undefined, studioOrigin: string): CouncilMeeting {
  const plain = (issue: string | null): CouncilMeeting => ({ ...meeting, council: null, councilIssue: issue });
  if (entry === undefined) return plain('No council sidecar names this session; shown from Core B events only.');
  if (entry === 'duplicate') return plain('More than one council sidecar claims this session; none is trusted.');
  const { sidecar, dir } = entry;
  if (sidecar.mode !== 'LIVE' && sidecar.mode !== 'SCRIPTED') return plain(`Council sidecar has an unknown mode: ${String(sidecar.mode).slice(0, 40)}`);
  // Every participant identity in the verified events must be the model the sidecar claims, so LIVE/SCRIPTED cannot be relabelled.
  const claimed = `${sidecar.model?.provider}/${sidecar.model?.model}`;
  const seen = [...new Set(meeting.participants.map((p) => `${p.provider ?? 'UNKNOWN'}/${p.model ?? 'UNKNOWN'}`))];
  if (seen.length !== 1 || seen[0] !== claimed) return plain(`Council sidecar claims ${claimed}, but the verified participants are ${seen.join(', ') || 'none'}.`);
  // The council runs LIVE only on the local Ollama provider and SCRIPTED only on the scripted one (council run.ts, live-roster.ts).
  const expected = sidecar.mode === 'LIVE' ? 'ollama' : 'scripted';
  if (sidecar.model.provider !== expected) return plain(`Council sidecar mode ${sidecar.mode} requires provider ${expected}, not ${sidecar.model.provider}.`);
  const base = { meetingId: sidecar.meetingId, mode: sidecar.mode, model: claimed, recordPath: `.workdir/council/${sidecar.meetingId}/record.md` } as const;
  const verifiedTraces = [...new Set((thread?.messages ?? []).filter((m) => m.sessionId === meeting.id).map((m) => m.traceId).filter((t): t is string => typeof t === 'string' && TRACE_ID.test(t)))];

  if (!meeting.provenance) {
    return { ...meeting, councilIssue: null, council: { ...base, integrity: 'OPEN_UNRECORDED', workflowRuns: [], traceIds: verifiedTraces, modelCalls: null, failedCalls: null, toolCalls: null } };
  }
  const recordPath = join(dir, 'record.json');
  if (!existsSync(recordPath)) return plain('The meeting concluded but its council record is missing.');
  let rec: CouncilRecord;
  try { rec = readJson(recordPath) as CouncilRecord; } catch { return plain('The council record is unreadable.'); }
  const p = meeting.provenance;
  if (!rec?.integrity || !councilRecordIntact(rec)) return plain('The council record fails its own integrity hash; its claims are not shown.');
  if (rec.meetingId !== sidecar.meetingId || rec.sessionId !== meeting.id || rec.mode !== sidecar.mode
    || rec.integrity.meetingRecordHash !== p.recordHash || rec.integrity.throughSeq !== p.throughSeq || rec.integrity.throughHash !== p.throughHash) {
    return plain('The council record does not match the verified meeting record (hash or event coverage differs); its claims are not shown.');
  }
  const tools = new Map<string, number>();
  for (const c of rec.calls) for (const t of c.toolCalls ?? []) tools.set(t.tool, (tools.get(t.tool) ?? 0) + t.count);
  return {
    ...meeting,
    councilIssue: null,
    council: {
      ...base, integrity: 'RECORD_VERIFIED',
      workflowRuns: rec.workflowRuns.map((r) => r.runId).filter((id) => RUN_ID.test(id)).filter((id, i, all) => all.indexOf(id) === i)
        .map((runId) => ({ runId, url: `${studioOrigin}/workflows/engineering-council-workflow/graph/${runId}` })),
      traceIds: [...new Set(rec.calls.map((c) => c.traceId).filter((t): t is string => typeof t === 'string' && TRACE_ID.test(t)))],
      modelCalls: rec.accounting.modelCalls,
      failedCalls: rec.accounting.failedCalls,
      toolCalls: [...tools.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tool, count]) => ({ tool, count })),
    },
  };
}

export function createCouncilReader(options: { workdir: string; studioOrigin: string }) {
  const councilDir = join(options.workdir, 'council');
  const dbPath = councilDbPath(options.workdir);
  const collaboration = createCollaborationReader({ dbPath });
  const shape = (view: CollaborationView, reason?: string): CouncilView => {
    const bySession = view.availability === 'AVAILABLE' ? sidecars(councilDir) : new Map();
    const threads = new Map(view.threads.map((t) => [t.id, t]));
    return { ...view, ...(reason && view.availability === 'NOT_AVAILABLE' ? { reason } : {}), meetings: view.meetings.map((m) => annotate(m, threads.get(m.threadId), bySession.get(m.id), options.studioOrigin)) };
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

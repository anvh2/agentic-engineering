# M9 Organization collaboration UI

Status: **ORGANIZATION_COLLABORATION_UI_CONNECTED**. The Discussions and Meetings views in Mastra Studio (`127.0.0.1:4411`) show Core B's persisted collaboration records, read through a read-only Gateway. Every acceptance check below passed. Nothing was pushed, and nothing was merged into a primary branch.

## Branch and commits

| What | Value |
|---|---|
| Worktree | `/private/tmp/agentic-m9-org-collab` (new and isolated) |
| Branch | `integration/m9-org-collaboration` |
| Base | `recovery/2026-10-03` at `33228d4`. Core B (`65a6252`) had already been fast-forwarded into it. |
| `0742a67` | Merge of `codex/m8.4-control-center` (`d10393f`). Clean, with no overlapping paths. |
| `ab7fe94` | The collaboration integration described below. |
| Next commit | This report. |

**HEADs verified before any edit:** `recovery/2026-10-03` was at `33228d4`, `feature/m9-engineering-collaboration` at `65a6252`, and `codex/m8.4-control-center` at `d10393f`.

**Other worktrees were not modified:**
- The main checkout has another session's dirty files (`.gitignore`, `.turbo/`, `docs/architecture/components.md`, `tests/evaluation/`). They were left alone. Its `node_modules` is only read, through a symlink.
- From the M8.4 worktree, only `.workdir/studio-dist` was read (copied). Its `:4411` preview, owned by this session, was stopped and replaced.

## What changed

- **Gateway adapter** (`src/integrations/control-center/collaboration-adapter.ts`). It opens the scheduler DB `readOnly` with `query_only` and hands Core B's unchanged `CollaborationStore` a facade of `db`, `now` and a read transaction. One transaction covers Core B's `collaborationOverview`, `thread()` (the hash-chain-verified replay) and `record()`. No Core B file changed.
- **Endpoints** (embedded under `/control-center/v1`, standalone under `/api/v1`):
  - `/collaboration`: threads and messages, sessions and records, and a cursor.
  - `/collaboration/threads/:id` and `/collaboration/sessions/:id`: 404 when unknown, 400 for a malformed id.
  - `/collaboration/events`: an SSE stream whose `id` is Core B's `seq`. `Last-Event-ID` replays exactly the missed events. A non-numeric cursor, or one beyond the store, gets `reset`. Frames carry ids and types only, never message bodies.
- **No fabrication:**
  - Decisions, objections, agreements, unresolved items and action items come only from Core B's stored meeting record.
  - Unreported or in-flight usage is UNKNOWN, never 0.
  - A broken hash chain, or a missing append-only trigger or index, is shown as **INTEGRITY FAILURE** with no records.
  - Transcripts by identities whose persisted provider is `fake` are labelled "DETERMINISTIC FAKE PARTICIPANTS … Not live model output".
- **Viewer** (no redesign):
  - Core B's 10 message kinds, and each message's event `#seq`.
  - "Corrected by" and "Withdrawn by" links; the original message is kept.
  - The record's objections with their status.
  - Meeting status, outcome, tokens used, and provenance (records events through `#seq`, the chain hash and the record hash).
  - SSE frames, reconnects and resets trigger a full re-read of the verified snapshot, with the 5 s poll kept as a fallback.
- **Seed script** (`src/integrations/control-center/__testing__/seed-collaboration-demo.ts`). It runs Core B's reference design meeting through Core B's real store and coordinator, using its scripted fake participants. It writes only to a new file, and refuses an existing one. `--from` first copies a scheduler DB with `VACUUM INTO` over a read-only connection.

## Deterministic fake-agent meeting

The demo DB is `.workdir/m9-collab-demo/scheduler.db`. It is a read-only copy of the main scheduler DB, whose mtime and size were unchanged before and after. Core B's meeting was then seeded into it:

- thread `t-design`, session `s-design`, outcome `decided`, 22 events;
- record hash `cb2d449fc1a9e05470750002d3540d04632823d6393de2c1ebdfa5298807255c`, identical when seeded into a second, fresh DB.

During SSE verification, one more scripted comment by the lead (also provider `fake`) was appended through Core B's store as `m10`, seq 23.

The preview runs with `PORT=4411 AGENTIC_SCHED_DB=<demo DB> node studio-fork/start.mjs`.

## Test evidence

| Check | Result |
|---|---|
| `npm run typecheck`, and the same for `apps/control-center` | clean |
| `npm run build --prefix apps/control-center` | ok |
| Core B collaboration tests (`src/runtime/collaboration/*.test.ts`, `src/lead/collaboration/*.test.ts`) | 33/33, unchanged code |
| Gateway tests (`npm test --prefix apps/control-center`, gateway half) | 21/21: the earlier 16 plus 5 new |
| UI unit tests | 6/6 |
| Standalone browser (`npm run test:ui`) | 3/3 |
| Real-Studio smoke on `:4411`, asserting the UI against `/collaboration` | 1/1 |

**What the 5 new Gateway tests prove:**
- A real persisted meeting maps faithfully: 9 messages in seq order, the OPEN objection, the CONTESTED decision, two action items with UNKNOWN follow-up, the provenance and record hashes, and usage of 2,240 input and 455 output tokens.
- Unreported usage stays null, never 0.
- Thread, session and feed reads work, and unknown ids are not found.
- Tampering is caught: a rewritten payload with the trigger restored fails Core B's hash chain, and a dropped trigger fails the guard check. Both return CORRUPT with no records.
- A missing table is honestly empty, and a missing DB is NOT_AVAILABLE.
- HTTP endpoints behave as specified, and SSE replays exactly the missed seqs with no bodies on the wire.

**Browser evidence** is in `.workdir/control-center/studio-screenshots/`, which is gitignored local evidence: `studio-discussions.png`, `studio-meetings.png`, `collab-sse-*.png` and `collab-sse-evidence.json`.

- **Discussions:** all 9 persisted messages, each with its `Event #seq`, the "Corrected by m6 (original kept)" link, "Objection: OPEN", and the fake-participants banner.
- **Meetings:** CONCLUDED and decided, 3 complete rounds, 9 of 20 invocations, 2,695 tokens, the verbatim decision record including CONTESTED, the OUTSTANDING objection, and provenance through #21 with record hash `cb2d449f…`.
- **Live SSE:** a newly persisted message (seq 23) arrived as SSE frame `id=23` 776 ms after it was written, and rendered at 800 ms. That is well under the 5 s fallback poll, so SSE delivered it.
- **Reconnect:** the preview was stopped with the page open, and the disconnect alert appeared with the displayed records removed. After a restart, the stream reconnected with `Last-Event-ID: 23`, and the page recovered to 10 messages without a reload.
- **Existing views:** Organization, `/agents`, `/workflows` and `/traces` render in the smoke test, with no `:4310` requests and no page errors.
- **`:4111`:** the main repository's `mastra dev` (pids 15439 and 41902) was never stopped or restarted.

**Not run:** the full root `npm test` (about 15 minutes), consistent with the bounded runs the brief asked for. The recovery integration commit records it at 952/952 on `33228d4`.

## Remaining blockers and limitations

- **`:4111` acceptance is still pending.** It carries over from M8.4: the port belongs to the main repository's running `mastra dev`. All verification here ran on `:4411`.
- **No live, non-fake meeting exists yet.** Only the deterministic fake-agent meeting has been shown. Real agents would need a model-backed participant adapter for Core B's coordinator, which was out of scope (no paid providers).
- **No pagination.** The collaboration snapshot returns every thread. Core B bounds each thread at 5,000 events, but not the number of threads.
- **No trace links.** Core B stores trace ids only when a real adapter reports them, and there is no verified Studio trace URL, so they show as UNKNOWN.
- **Action follow-up state** is not recorded by Core B, and is shown as UNKNOWN.
- **Shared dependencies.** The integration worktree uses the main checkout's `node_modules` through a symlink. The root lockfiles are identical to recovery.

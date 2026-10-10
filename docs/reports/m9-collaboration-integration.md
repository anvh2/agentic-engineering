# M9 Collaboration Integration

Status: **M9_COLLABORATION_INTEGRATED**

Date: 2026-10-10. The Chief Architect approved a controlled fast-forward of Core B (engineering collaboration) onto Core A (M9.0 Agent Core foundation). Nothing was pushed. No Control Center UI change was merged. No real model or cloud call was made.

## 1. Integrated commits

| | Commit | Content |
|---|---|---|
| Base | `bc4617d` | M8 closeout (`M8_REAL_OBJECTIVE_ACCEPTED`) |
| Core A | `50e0335` | M9.0: complete review evidence, explicit delegation capacity, Agent Core contracts (design) — docs/reports/m9.0-agent-core-foundation.md |
| Core B | `65a6252` | M9 collaboration core: durable discussions, bounded meeting coordinator, read models — docs/reports/m9-collaboration-core.md |
| Integration docs | the commit directly on top of `65a6252` (`docs(m9-collab): integration report ...`) | this report and the `collab_events` persistence row in docs/architecture/runtime.md |

Final HEAD of `recovery/2026-10-03`: that documentation commit, a fast-forward line `bc4617d → 50e0335 → 65a6252 → docs`.

### Preflight (all held before the fast-forward)

- **Target HEAD.** `recovery/2026-10-03` was at exactly `50e0335`.
- **Ancestry.** `65a6252`'s only parent is `50e0335`, so the integration is a pure fast-forward with no merge commit and no rewritten history (`git merge --ff-only`).
- **No overwrites.** None of the 19 files `65a6252` adds existed in the primary worktree, tracked or untracked.
- **Unrelated dirty files.** `.gitignore` (modified), `.turbo/`, `docs/architecture/components.md` and `tests/evaluation/` (untracked) were left as they were. Nothing was stashed, reset or cleaned.
- **Sessions idle.**
  - Core A had no live processes and no file in the primary worktree changed in the preceding 30 minutes.
  - Core B (this session) had nothing running in its worktree.
  - The Control Center full suite that had been running in `/private/tmp/agentic-m84-control-center` had finished, so the regression below did not share the machine with another suite.
- **Control Center.** Its worktree (`codex/m8.4-control-center`) was not opened or modified.

A pre-existing `mastra dev` process (started 2026-10-08) kept running in the primary worktree. The fast-forward only added files it does not import.

## 2. Full regression

Commands run on the integrated tree: `npm run typecheck` and `npm test`.

- **Typecheck:** clean (exit 0).
- **Full suite:** **952 tests, 952 pass, 0 fail** (1,022 s, 2026-10-10 15:39–15:56 +07). Expected count: 919 (M9.0 final tree, including the 9 untracked `tests/evaluation/` tests) + 33 collaboration tests = 952.

| | Count |
|---|---|
| Total | 952 |
| Passed | 952 |
| Failed | 0 |
| New regressions | 0 |
| Known pre-existing failures | 1 known intermittent, not reproduced in this run (below) |

**Known intermittent: `Gemini HTTP smoke: cancellation and timeouts through HTTP › active-execution timeout`** (`tests/provider-smoke/gemini-http-smoke.test.ts`).

- **History.** It failed in the full suites at `bc4617d` and at `50e0335` (`still_active … model still engaged: lease pid`).
- **This run.** It passed in the full suite. It also passed 3 of 3 times run alone (`--test-name-pattern='active-execution timeout'`), so it passed 4 of 4 here.
- **What it touches.** It is a deterministic test against a local guard server, with no real Gemini call. Nothing in this integration touches its code path.
- **Status.** Timing-dependent and **not fixed**. One green run does not close it, so it remains a known flaky case to track. The suite should not be called reliably green until it is fixed.

The `npm test` glob also picks up the untracked `tests/evaluation/` (9 tests). That directory belongs to other work and is not part of any M9 commit, exactly as recorded in the M9.0 report.

The suite is **not** fully green while the Gemini HTTP smoke `active-execution timeout` case fails. That failure was already present at `bc4617d` and at `50e0335`.

### Collaboration after integration

These targeted checks were run on the integrated tree after the full suite:

| Area | Tests (by name pattern) | Result |
|---|---|---|
| Persistence and replay | reopen-and-replay of every prefix, global ordering and per-thread chain, append-only triggers and tamper detection, idempotency | pass |
| Meeting budgets and rounds | `maxRounds` (coordinator and store level against a bypassing caller), invocation budget charged before asking, UNKNOWN tokens under a token budget gives `budget_exhausted`, token budget reached, `no_progress` stop | pass |
| Cancellation, resume, stale epochs | operator cancel mid-turn, suspend then resume by a new coordinator, superseded-coordinator writes refused, turn ownership | pass |
| SSE cursor | paged feed, `Last-Event-ID` reconnect with no gap or duplicate, invalid ids give a re-snapshot | pass |
| Provenance and authority | record entries link to their events, no invented consensus, authority-granting decisions rejected, a decided meeting writes no scheduler table | pass |
| All collaboration tests | `src/runtime/collaboration/*.test.ts`, `src/lead/collaboration/*.test.ts` | 33 / 33 pass |

## 3. Collaboration APIs (integrated)

Runtime: `src/runtime/collaboration/`. This is the component layer; it imports only `runtime/scheduler/store.ts` and `runtime/execution/worker-provider.ts`.

| API | Purpose |
|---|---|
| `new CollaborationStore(schedulerStore, directory)` | Adds `collab_events` beside the scheduler tables. Every command is one IMMEDIATE transaction: replay, validate, then append. |
| `openThread`, `post` | Threads with configured participants, and typed messages with parent rules, evidence, work refs and invocation refs. Corrections and withdrawals append. |
| `openSession` (lead/operator), `claimSession`, `reserveTurn`, `closeTurn`, `concludeSession`, `suspendSession`, `cancelSession` | Meeting sessions. Turn order, `maxRounds`, the invocation and token budgets (UNKNOWN fails closed), the fence and chair-only decisions are all enforced here. |
| `events`, `eventsSince`, `thread`, `session`, `record`, `threadIds` | Reads. Replay verifies the hash chain and a broken chain fails the thread closed. |
| `MeetingCoordinator.run(sessionId, { owner, participants, signal })` | Drives one session to `decided`, `unresolved` (`max_rounds` / `no_progress`), `budget_exhausted`, `failed`, `cancelled`, or `suspended`. |
| `buildMeetingRecord`, `recordIntact` | Deterministic meeting record with per-entry provenance; it never invents consensus. |
| `collaborationOverview`, `eventFeed`, `toSseFrame`, `parseLastEventId` | Read models and a live feed for the Control Center. |
| `__testing__/fake-agents.ts` | `ScriptedParticipant`, `FailingParticipant`, `HangingParticipant`, `TEST_ROSTER`. |

Lead: `src/lead/collaboration/`.

| API | Purpose |
|---|---|
| `engineeringRoster({ workers, operators, leadModel?, extra? })` | Builds a `ParticipantDirectory` from provider descriptors and operator ids. The Lead is `claude-engineering-lead`. |
| `renderMeetingRecord(record)` | Markdown rendering. Every line is a record field, with `[seq/messageId]` links. |

## 4. Remaining CLI and provider integration gaps

None of these is implemented, and none is needed for what was integrated here:

1. **No CLI.** `lead meeting open|run|cancel|record` should become the single caller of `MeetingCoordinator`, and it should build the directory with `engineeringRoster` from the `ProviderRegistry` descriptors. Today the component is reachable only from code and tests.
2. **No model-backed participant.** A real `Participant` adapter must:
   - go through `ProviderRegistry`, never a direct client;
   - honor the operator allow-list (`AGENTIC_ALLOW_PROVIDERS`) per session;
   - take capacity leases;
   - report usage and the Mastra `traceId`/`runId` into the invocation reference, or leave them `UNKNOWN`;
   - be stoppable by process group, as workers already are.

   Paid calls require explicit authorization and were out of scope.
3. **No objective-ref check.** `refs.objectiveId` is recorded as given. Batch and task are verified against the scheduler. The lifecycle table belongs to lead, so a CLI should check the objective before opening a thread.
4. **No authority bridge, by design.** A decision binds nothing. If M9.1 makes decisions actionable, it does so through human-issued grants (`LifecycleStore.authorize` today, `AuthorityGrant` later). It can import a decision as an `EvidenceRecord` with `grantId: null`.
5. **Identity mapping.** The collaboration `ParticipantIdentity` maps to Core A's design `AgentIdentity` by `id ↔ agentId`. `tenantId` arrives with M9.1's migration and is not added here.

## 5. Control Center Gateway handoff

The Gateway reads the scheduler database through `CollaborationStore` (read-only use) and exposes:

- **Snapshot:** `collaborationOverview(store)`.
  - Threads, with message-kind counts and session summaries: status, owner and epoch, rounds started of max, invocations used of max, tokens used of max, the pending turn, outcome and reason.
  - Every configured agent: messages, invocations, input and output tokens, `lastActiveAt`, `currentTurn`.
  - `cursor`: read in the same transaction as the snapshot.
- **Live feed:** `eventFeed(store, cursor, limit)` → SSE via `toSseFrame` (`id:` = global `seq`, `event:` = event type).
  - On reconnect, `parseLastEventId(header)` gives the resume cursor.
  - A `null` result means the client takes a new snapshot and subscribes from its cursor; the server never guesses a position.
  - The tests show no gap and no duplicate across a reconnect.
- **Meeting transcripts and records:**
  - `store.thread(threadId).messages` holds every message, with author snapshot, kind, parent, evidence and invocation.
  - `store.record(sessionId)` holds alternatives, objections, questions, agreements, decisions (`contested`, `authority: 'none'`), action items with owners, unresolved items and turns. Every entry carries `source {seq, messageId}`.
  - `renderMeetingRecord` gives a Markdown view.
- **Trace links:** `message.invocation.traceId` / `runId` and `evidence[kind='trace']`. These are `null` until a real adapter reports them.
- **Rules for the UI:**
  - Show the literal `UNKNOWN` as UNKNOWN, never as 0.
  - An agent with no events is idle (0 messages, `lastActiveAt: null`). Do not simulate activity.
  - Treat a `corrupt` error on a thread as a hard error. The view must not paper over it.

The Mastra Studio "Organization inside Studio" embedding remains an open operator decision. It was not part of this integration.

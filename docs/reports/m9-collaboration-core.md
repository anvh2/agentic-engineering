# M9 Engineering Collaboration Core (Core B)

Status: **M9_COLLABORATION_SLICE_READY**. Phase 2 (discussion contracts and durable store) and Phase 3 (bounded meeting coordinator with fake agents) are implemented and tested. This slice has no UI and no Mastra Studio work, makes no real model or cloud calls, adds no scheduler and was not pushed.

- Branch: `feature/m9-engineering-collaboration` in the worktree `/private/tmp/agentic-m9-collaboration`.
- Base: cut from `bc4617d`, then rebased onto Core A's M9.0 commit `50e0335`.
- Primary worktree: `recovery/2026-10-03`, owned by Core A. Nothing in it was edited, reset, stashed or merged.
- Date: 2026-10-10.

## 1. Scope and ownership

| Owned by this slice (new files only) | Not touched |
|---|---|
| `src/runtime/collaboration/{types,directory,events,replay,record,store,coordinator,read-model}.ts`, plus tests | `scheduler.ts`, `scheduler/store.ts`, `scheduler/types.ts` |
| `src/runtime/collaboration/__testing__/{fake-agents,harness}.ts`, `meeting-record.fixture.json` | `change-review.ts`, `delegation-capacity.ts`, every Core A file in `50e0335` |
| `src/lead/collaboration/{roster,record-markdown}.ts`, plus tests | lifecycle orchestration, authorization (`LifecycleStore.authorize`), provider allow-list |
| `docs/reports/m9-collaboration-core.md` | `docs/architecture/runtime.md` (Core A edits it; see section 7) |

`git diff 50e0335..HEAD --stat` lists only added files. No existing file was changed.

Imports: `runtime/collaboration` imports only `runtime/scheduler/store.ts` (types) and `runtime/execution/worker-provider.ts` (`UNKNOWN`, `normalizeUsage`). `lead/collaboration` imports `runtime`. Nothing imports `integrations`, and nothing in the existing runtime imports collaboration.

## 2. Architecture

```
caller (future: lead CLI / Control Center action)
  -> MeetingCoordinator.run(sessionId, participants)      drives one session; owns no queue
       -> CollaborationStore  (the rules: turn order, limits, fence, who may decide)
            -> SchedulerStore.transact / db                same SQLite file, connection, busy handling
                 -> collab_events                          one append-only, hash-chained table
       -> Participant.respond()                            fakes today; a real adapter is future work
read side:  replay(events) -> ThreadState -> MeetingRecord / collaborationOverview / eventFeed (SSE)
```

Decisions:

1. **Beside the scheduler, not a scheduler.** Like `LifecycleStore`, `CollaborationStore` takes a `SchedulerStore`. It adds one table and runs every command as one `BEGIN IMMEDIATE` transaction through the public `transact()`. It never claims, runs or transitions a task.
2. **Events are the source of truth.** There are no projection tables. Every command, and every read, replays the thread through one reducer (`replay.ts`). That gives a single definition of thread state and nothing that can drift.
3. **The store enforces every rule, not the coordinator.** These rules live in the store:
   - turn order and ownership;
   - `maxRounds` and the invocation and token budgets;
   - the coordinator's fence (owner, epoch);
   - who may decide, open or cancel.

   A buggy or bypassing caller therefore cannot exceed a limit. A mutation check confirmed that the store-level `maxRounds` guard is load-bearing (section 5).
4. **Immutable history.** SQLite triggers refuse `UPDATE` and `DELETE` on `collab_events`. Each event's `hash` is `sha256(prevHash + canonicalJson(event))` per thread. A rewrite made out of band (raw SQL with the trigger dropped) is detected on replay, and the thread then refuses all reads and writes (`corrupt`). Corrections and withdrawals are new messages; the original is never changed.
5. **Fail closed, never truncate.** These are refused, never cut or coerced:
   - an over-size body (16,000 characters), too many evidence refs, or more events per thread than allowed;
   - an unknown author, or a reference that does not resolve;
   - a token budget that cannot be verified because usage is `UNKNOWN`.
6. **No authority through discussion.** This matches Core A's Agent Core invariant 5, "Messages carry no authority".
   - `decisionPayloadSchema` is `.strict()` and has no field for permissions, repairs, providers, scope or task state. A decision that carries `authorizations` is rejected.
   - Only the session chair can record a decision, and only as a meeting turn.
   - Every record entry says `authority: 'none'`.
   - A test proves that a decided meeting leaves `tasks`, `events`, `reviews` and the table list byte-identical.

## 3. Contracts and event shapes

Identity:

```ts
interface ParticipantIdentity {      // configured, never claimed; snapshot copied into every message
  id: string;                        // e.g. claude-engineering-lead, worker-codex, anvh2
  role: 'engineering_lead' | 'architect' | 'implementer' | 'reviewer' | 'verifier' | 'operator';
  kind: 'lead' | 'worker' | 'reviewer' | 'operator';
  provider?: string; model?: string; displayName?: string;   // no provider = cannot take a meeting turn
}
```

`ParticipantDirectory` holds the configured set. `engineeringRoster()` (lead) builds it from provider descriptors and operator ids. The Lead's id is `claude-engineering-lead`, the actor id the scheduler and review already use.

Message (`MessageView`):

- **Context:** `threadId`, `sessionId`, `round`, `turn`, `at`.
- **Author:** `author`, a `ParticipantIdentity` snapshot.
- **Reply structure:** `parentId`, and `kind`, one of `proposal | objection | question | answer | support | comment | withdrawal | correction | decision | pass`.
- **Content:** `body`.
- **Work references:** `refs`, made of `objectiveId?`, `batchId?` and `taskId?`. Batch and task are checked against the scheduler.
- **Evidence:** `evidence[]`, each `{ kind: message|event|task|commit|file|trace|artifact|review, ref, note? }`, validated per kind.
- **Model invocation:** `invocation`, which is `{ provider, model, runId, traceId, inferenceMs, usage }`. Provider and model come from the directory. Anything not reported is `'UNKNOWN'`.
- **Decision:** `decision`, which is `{ outcome: accept|reject|defer, proposalIds, rationale, actionItems[{owner, description}] }`.
- **Derived on replay:** `correctedBy[]` and `withdrawnBy`.

Reply rules (`PARENT_RULES`):

- An objection or a support must target a proposal. An answer must target a question.
- A withdrawal targets the author's own proposal or objection. A correction targets the author's own message.
- A decision or a pass is only a meeting turn.

Session limits: `{ maxRounds ≤ 10, maxInvocations ≤ 100, maxTokens? ≤ 2,000,000 }`, plus at most 8 participants and 10 agenda items.

Event stream, one per thread. Each event row is:

`seq` (global AUTOINCREMENT), `thread_id`, `type`, `at`, `actor`, `idempotency_key` (UNIQUE), `request_digest`, `payload` (JSON), `prev_hash`, `hash`.

| `type` | payload |
|---|---|
| `thread.opened` | thread: id, title, refs, participants (snapshots), createdBy |
| `message.posted` | message (above) |
| `session.opened` | id, agenda, participants (turn order), chair, limits, openedBy (lead/operator only) |
| `session.claimed` | owner, epoch (+1 per claim), previousOwner |
| `session.suspended` | owner, epoch, reason (an AbortSignal; resumable) |
| `turn.reserved` | round, turn, participant, attempt, epoch, invocationNo (the budget is charged here, **before** the call) |
| `turn.abandoned` | an older epoch's unanswered turn; the same turn is re-reserved as attempt+1 |
| `turn.rejected` | reason + `attempted {kind, body}` (refused content kept for audit) |
| `turn.failed` | participant error or `turnTimeoutMs` |
| `session.concluded` | outcome (`decided`, `unresolved`, `budget_exhausted` or `failed`), reason, **record** |
| `session.cancelled` | actor (operator/lead, or the fence holder), reason, abandonedTurn, **record** |

Idempotency: each event has a key. Session operations derive theirs from the turn, for example `session:<id>:r<round>:t<turn>:a<attempt>:message`. A free post must supply its own.

- The same key with the same request returns the existing event.
- The same key with a different request is `idempotency_conflict`. One message per turn is enforced this way.

Coordinator loop:

1. `claim` (epoch+1).
2. Check the stop conditions:
   - a chair decision gives `decided`;
   - a full round with no contribution gives `unresolved: no_progress`;
   - all rounds spent gives `unresolved: max_rounds`.
3. `reserveTurn`. Budget exhaustion gives `budget_exhausted`.
4. Ask the participant, bounded by `turnTimeoutMs`.
5. `post`. A refused reply becomes `turn.rejected` and the meeting continues.
6. Repeat from step 2.

An AbortSignal suspends the meeting rather than cancelling it. Cancellation is a separate, terminal, audited store operation.

Meeting record (`agentic.meeting-record/1`) is derived deterministically from the events. It is not a model summary.

- **Fields:** agenda, participants, limits, usage (rounds, invocations, tokens or `UNKNOWN`), outcome and reason, `alternatives`, `objections`, `questions`, `agreements`, `decisions` (`contested`, `overruledObjections`, `authority: 'none'`), `actionItems` (with owners), `unresolved`, `corrections`, `turns` (including rejected, failed and abandoned), and `pendingAtEnd`.
- **Provenance:** `{ throughSeq, throughHash, messageSeqs }` and `recordHash`. Every entry carries `source { seq, messageId }`.
- **No invented consensus:**
  - agreement means explicit `support` messages only;
  - `unanimous` needs a support from every other participant and no outstanding objection;
  - an objection is resolved only by its author's withdrawal;
  - a decision over an objection is `contested`, and the objection stays in `unresolved`.

Golden fixture: `src/runtime/collaboration/__testing__/meeting-record.fixture.json`. Rendered by `renderMeetingRecord`:

```
# Meeting record: Persist delegation capacity per task
- Outcome: **decided** (decision m9 by claude-engineering-lead: accept m2)
- Usage: 3/3 round(s), 9/20 invocation(s), tokens 2695
- Provenance: through event 21 (`87ecab6f6e9e3b21`), record `cee0632c4229b897`
## Alternatives
- [7/m2] **accepted** by architect: Declare delegationCapacity in the task spec; ... — supported by reviewer — outstanding objections m3 — corrected by m6
## Agreements
- m2: supported by reviewer (not unanimous) [19/m8]
## Decisions
- [21/m9] claude-engineering-lead: **accept** m2 — ... — CONTESTED, overruled objections m3 (grants no authority)
## Action items
- [ ] worker-codex: Add capacity to the task spec schema with a strict parser. (from m9 [21/m9])
- [ ] reviewer: Write the over-limit escalation test. (from m9 [21/m9])
## Unresolved
- [9/m3] objection m3: worker-codex objects to m2
```

## 4. Data ownership

| Data | Owner | Writers | Readers |
|---|---|---|---|
| `collab_events` (scheduler DB) | `CollaborationStore` | only `CollaborationStore.command` (one IMMEDIATE tx) | replay, read models, record |
| participant directory | configuration (caller) | `engineeringRoster` / test roster | store (author snapshots) |
| meeting record | derived; stored inside the terminal event | the store at conclude/cancel | `record()`, renderer, Control Center |
| tasks, reviews, scheduler events, lifecycle, authorizations | scheduler / lifecycle (Core A) | unchanged | collaboration reads `getTask`/`getBatch` only |

Persistence: the new table is created with `CREATE … IF NOT EXISTS` and is additive. No existing table, column or persisted identifier changes. Schema strings are `agentic.collaboration/1` and `agentic.meeting-record/1`.

## 5. Test evidence

All tests are deterministic. They use fake participants and a fixed clock, and make no network or model call.

| File | Tests | Covers |
|---|---|---|
| `runtime/collaboration/store.test.ts` | 11 | persistence across a reopened DB and replay of every prefix; global ordering and per-thread chain; append-only triggers and tamper detection (fail closed); idempotency (retry, conflict, required key); unknown or non-participant authors; a role cannot be forged; decisions and passes only as turns, decisions only from the chair; only lead or operator opens or cancels; a decided meeting changes no task, review, scheduler event or table; corrections and withdrawals append and only by the author; reply structure, evidence, refs (task and batch), oversize refused and not truncated; `UNKNOWN` invocation fields |
| `runtime/collaboration/coordinator.test.ts` | 13 | reference meeting in deterministic turn order; exactly rounds × participants turns under `maxRounds`; `no_progress` stop; invocation budget enforced before asking; `UNKNOWN` tokens under a token budget gives `budget_exhausted`; token budget reached; failing or hanging participant gives `failed`; missing or foreign participant implementations refused; turn ownership, fence, attempt and one message per turn; store-level `maxRounds` against a bypassing caller; stale epoch after a takeover, abandoned turn re-asked as attempt 2 and still charged; out-of-role decision and authority-granting decision rejected but audited; operator cancel mid-turn (terminal, in-flight turn recorded, no resume, nothing written after); abort then suspend then resume by a new coordinator, with the same contributions as an uninterrupted run |
| `runtime/collaboration/record.test.ts` | 4 | every entry links to its `message.posted` event; record bound to `throughSeq`/`throughHash` and inside the chain; a tampered record is detected; no invented consensus (contested decision, objection stays unresolved, not unanimous); unresolved disagreement recorded as unresolved; deterministic, byte-identical golden fixture |
| `runtime/collaboration/read-model.test.ts` | 3 | idle agents show 0 activity and `null` last-active; token sums; `UNKNOWN` when not reported or when a charged turn was never answered; the turn in flight; feed paging, SSE frame and `Last-Event-ID` reconnect with no gap or duplicate; invalid ids return null (re-snapshot) |
| `lead/collaboration/collaboration.test.ts` | 2 | roster from provider descriptors, roles, duplicates and invalid ids refused; Markdown rendering with links, without claiming consensus |

Results on the branch, after the rebase onto `50e0335`:

- `npm run typecheck` is clean.
- The collaboration tests: **33 pass, 0 fail**.
- Core A's new M9.0 tests in the same tree pass too (section 7).

Mutation checks: one guard at a time was disabled and the suite re-run. Each mutation made at least one test fail:

- the chair check;
- the fence check on post;
- the invocation budget;
- `maxRounds` in reserve (caught once its dedicated test was added);
- refusing `UNKNOWN` tokens;
- the participant check;
- idempotency conflict detection;
- record `contested` forced to false;
- record "any support means unanimous".

Not run: the full `npm test`. The brief defers it to after integration. A full suite was running in another worktree at the time, and the test timings are load-sensitive. This branch changes no existing file, so existing tests are unaffected by construction.

## 6. Control Center read-model and SSE handoff

Use `src/runtime/collaboration/read-model.ts`. It is pure projection, so it never samples or simulates activity:

- `collaborationOverview(store)` returns `{ threads, agents, cursor }`.
  - Threads carry message-kind counts and session summaries: status, owner and epoch, rounds, invocations, tokens (`Measured`), pending turn, outcome.
  - Agents carry messages, invocations, tokens, `lastActiveAt` and `currentTurn`.
  - It reads in one transaction, so `cursor` is consistent with the snapshot.
- `eventFeed(store, afterSeq, limit)` returns `{ events, cursor, hasMore }` in global `seq` order.
- `toSseFrame(event)` produces `id: <seq>`, `event: <type>` and `data: <json>`.
- `parseLastEventId(header)` returns a number, or `null`. On `null` the client takes a fresh snapshot and subscribes from its cursor.
- `store.record(sessionId)` returns the stored record. `renderMeetingRecord(record)` renders it as Markdown.
- Mastra trace links: `message.invocation.traceId` and `runId`, and evidence of `kind: 'trace'`. These are populated only when a real adapter reports them; until then they are `null`.
- Missing telemetry is the literal `'UNKNOWN'`. The UI must show it as UNKNOWN, never 0.

The gateway should poll `eventFeed` (or be notified after a write) and fan out SSE. No Mastra Studio work was done in this slice. The embedding question is still open and owned elsewhere.

## 7. Reconciliation with M9.0 (`50e0335`) and Core A integration requirements

`50e0335` is a direct child of `bc4617d`. It does not touch the two modules this slice imports (`scheduler/store.ts`, `execution/worker-provider.ts`), and no path overlaps. The rebase was clean.

To integrate, with approval and after Core A is idle:

1. **Merge.** Merge `feature/m9-engineering-collaboration` into `recovery/2026-10-03`, a fast-forward on top of `50e0335`. Then run the full `npm typecheck && npm test` once, as the coordinated final regression.
2. **Architecture doc.** Add one row to `docs/architecture/runtime.md` Persistence (`collab_events`, append-only, hash-chained), and a link to this report. Core A owns that file, so this was not done here.
3. **Identity naming.** Core A's design-only `AgentIdentity` (`tenantId`, `agentId`, `actsFor`, ...) is a different concept, so this slice's type is named `ParticipantIdentity` to avoid a collision. When Agent Core identities exist, the mapping is `ParticipantIdentity.id ↔ AgentIdentity.agentId`, with role and kind kept as engineering-adapter attributes. `tenantId` was deliberately not added; that is M9.1 scope, behind its migration.
4. **Evidence.** `collab_events` is already a per-thread hash chain shaped like `EvidenceRecord` (`prevHash`, `hash`, actor, subject). An M9.1 evidence store can import a decision as `EvidenceRecord{ kind: 'meeting.decision', grantId: null }`, because a decision uses no authority.
5. **Authority.** If a decision is ever to bind work, a human must issue a grant through Core A's authority path (`LifecycleStore.authorize` today, `AuthorityGrant` later). Nothing in collaboration may call those. This boundary is tested.
6. **Real participants.** A model-backed `Participant` adapter does not exist. It must:
   - go through `ProviderRegistry`, respecting `AGENTIC_ALLOW_PROVIDERS` and the capacity leases;
   - report usage and the trace id;
   - be operator-authorized per session.

   Building it is out of scope here: no paid calls.
7. **Entry point.** There is no CLI yet. A `lead meeting open|run|cancel|record` command should be the single caller of `MeetingCoordinator`; do not add a second loop elsewhere.

## 8. Limits and known gaps

- **Replay cost.** Replay is O(events in the thread) per command, capped at 5,000 events per thread.
- **Abandoned turns.** A turn abandoned by a crash is charged again when re-asked. This is conservative: the first call may have spent tokens.
- **Participants that ignore aborts.** A participant that ignores its abort keeps running in the background after the coordinator moves on. Fakes comply; a real adapter must use the process-group termination the coordinator already relies on for workers.
- **Objective references.** `refs.objectiveId` is recorded as given. Batch and task are verified, but the lifecycle table is owned by lead/Core A, so the objective is not checked here.
- **Out of scope.** Agent Core grants, the CEO agent, researcher or PO roles, multi-tenancy, UI, Studio, and any provider call.

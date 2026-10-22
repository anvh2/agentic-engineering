# M8.4 Control Center contract — Platform handoff

Version: `agentic.control-center/1`. Platform owns `src/integrations/control-center/` and `apps/control-center/`. No scheduler, provider, execution, capacity, SQLite schema, or Core metrics code changes are included.

This is the first read-only Organization slice. Runtime state remains entirely in Core. Wire schemas are exported from `src/integrations/control-center/contract.ts`; changes to those shapes require coordination with Platform. They are a proposed integration contract for Claude, not a claim that a separate session has agreed to them.

## Current data path

`React → loopback Gateway → read-only scheduler database / existing readModelCapacity()`.

The scheduler currently lacks a read-only task/event DTO service. Constructing `SchedulerStore` would create tables and enable writes, so the transitional Gateway adapter does **not** construct it. It follows the existing `src/observability/scheduler-state.ts` read-only connection pattern, using explicit allowlisted queries within one deferred SQLite transaction per snapshot. It never repairs data, claims tasks, renews leases, checks process liveness, probes providers, reads artifact files, or calls Mastra.

Connections are opened afresh per read; missing, busy, corrupt, incompatible databases produce a disconnected snapshot, not an empty-success state. No database is created. Capacity is optional and sampled separately via the existing Core reader; counts are machine-wide and cannot attribute work to a particular task. A Core read-model implementation can replace `createReader` without changing the Gateway/UI wire contract.

## Read endpoints

- `GET /api/v1/snapshot?objectiveId=<batch-id>` returns a `Snapshot` validated by Zod. Omit the scope for objective discovery and an unknown roster; it does not aggregate every historical batch. An unknown ID yields an empty scoped result. All timestamps are Unix milliseconds.
- `GET /api/v1/events?objectiveId=<batch-id>` returns SSE; `Last-Event-ID` or an initial `cursor` query supports replay. No scope means only discovery snapshots.
- `GET /`, `/app.js`, `/app.css` serve the built React UI.

All other methods return 405. Unknown routes return 404. The CLI binds only `127.0.0.1`; host/origin checks reject rebinding and cross-origin browser access. No CORS, remote exposure, mutation routes, credential loading, raw SQL endpoint, or generic file endpoint. The app never loads `.env`.

Snapshots expose only IDs, titles, dependencies, scheduler lifecycle fields, timestamps, aggregate capacity, and sanitized event envelopes. Prompts, task contracts, hidden tests, worker text, reasoning, review bodies, repository paths, event reasons/details, environment, raw artifacts and execution outputs are excluded. Serialization applies the existing secret redactor. Mastra links use an operator-configured HTTP(S) origin and an encoded persisted run ID, following the repository's existing workflow graph URL. They are links, not Mastra calls; no trace IDs are invented and the actual workflow status remains unknown. Historical run outcomes are not inferred from the latest task outcome.

## Identity and scope

- Objective ID: existing scheduler `batches.id`; `kind: scheduler-batch` makes the approximation explicit. No independent objective lifecycle is created.
- Task ID, worker ID, run ID: the persisted scheduler values. DAG edges are `dependsOn` from the persisted task spec; the Gateway does not schedule or resolve them.
- Agent ID: logical role/provider (`claude`, `ollama` presented as Qwen, `codex`, `gemini`). These are organizational roles, not online processes; multiple physical worker assignments can appear under one provider. Unknown provider IDs receive a corresponding generic role. The inspector shows actual `assigned_worker` values separately.
- Event ID: `<database-generation>:<events.seq>`. Generation hashes file identity/birth time and the first event, without exposing local paths. Replacement, future cursors, malformed cursors or gaps exceeding 200 events cause a reset. In-place replacement that preserves all identity inputs is outside this interim adapter's guarantees; Core should supply an explicit store epoch.

## Current activity versus outcome

| Evidence | Activity | Meaning |
| --- | --- | --- |
| `READY` | `QUEUED` | Scheduler-ready task, **not** a model permit queue position |
| `VERIFYING` and unexpired lease | `VERIFYING` | Scheduler post-run verification stage |
| `CLAIMED` / `CODING` and unexpired lease | `UNKNOWN` | Assignment known; current inference/inner verification stage unknown |
| Expired/missing lease, historical completion, no assignment | `UNKNOWN` | Does not prove idle, offline, or running |

`IDLE`, `OFFLINE`, `RUNNING` are reserved contract values; this adapter cannot safely emit them. Readiness is not provider availability. Configuration, provider availability, model ID, permit waiting/position and quota remain null/UNKNOWN. Activity for a logical provider favors a live verification assignment, then an uncertain live assignment, then scheduler-ready tasks.

The newest non-transient task state in the selected scope is `lastOutcome`; original scheduler values are preserved (for example `RUNTIME_FAILURE`, not a fabricated `FAILED` state). Review-ready/approved/integrating/done worker tasks provide **historical** verification evidence only. Claude-direct DONE does not establish runtime verification. `claimedAt`, live lease expiry, `lastEventAt`, and `updatedAt` retain their distinct meanings. `elapsedMs` is time since a valid claim, including preparation/waiting, not inference latency. The UI labels it “Claim elapsed” and freezes retained data when disconnected.

## SSE semantics

SSE delivers persisted event projections, plus transport-only `snapshot`, `checkpoint`, `reset`, and `connection` messages. The default polling interval is 2 seconds; it is not a new event store or scheduler. Snapshots replace UI state and usage totals; no event increments a token counter. Slow consumers are disconnected instead of buffering indefinitely. Reconnect replays at most 200 events; larger gaps trigger complete snapshot replacement. The stream sends the durable cursor at checkpoints. Task state and event reads are transactional; separately sampled capacity has no cross-database consistency guarantee.

| Wire event | Existing evidence |
| --- | --- |
| `task.claimed` | transition to CLAIMED |
| `task.queued` | transition to READY; scheduler readiness only |
| `verification.started` | transition to VERIFYING; post-run scheduler checks only |
| `task.review_pending` | transition to REVIEW_PENDING |
| `task.failed` | transition to RUNTIME_FAILURE or REVIEW_REJECTED |
| `task.cancelled` | transition to CANCELLED; **does not confirm the provider stopped** |
| `task.transition` | other state changes (including ESCALATED, BLOCKED) |
| `task.audit` | persisted same-state events, including run start/recovery/cancellation audit records; sensitive payload omitted |
| `provider.started`, `provider.completed`, `verification.completed` | Reserved, `eventSupport: false` until exposed safely by Core |

No synthetic model events are created from `CODING`, permit counts, or historical run IDs. A disconnected source emits a transport connection message and leaves the UI explicitly stale/unknown.

## Token/cost contract

The `ModelCall` schema is the future Core seam: globally unique physical call ID, objective/task/run/worker/provider/model correlation, attempt number, start/end, terminal status including failed and cancelled, and `Usage`.

`Usage` contains nullable input/output/cached-input/reasoning counts, latency, actual USD cost, estimated cost with explicit model/pricing source/time, collection source and completeness (`unavailable`, `pending`, `partial`, `complete`). No missing number becomes zero. Actual zero is legal only when reported. Cached/reasoning tokens are subset breakdowns and never added to input/output. Model aliases/unknown models must not produce inferred prices. `null` cost means unknown, not free.

The existing runner persists some telemetry in attempt artifacts and some model trace events. There is no read-only, attempt-complete call ledger: retry attempts may overwrite attempt telemetry and failed/cancelled calls can lack usage. The Gateway deliberately does not mine paths or guess totals from these artifacts. All live usage is currently unavailable and `calls` is empty. This limitation is shown in the UI.

`summarizeUsage()` defines the tested future aggregation behavior: scope first, deduplicate stable call IDs, retain completed observations over replayed pending ones, count failed/cancelled retries when measured, and return null for any aggregate dimension missing a member. Pending calls make collection pending. It never adds subsets to totals, estimates unknown-model pricing, or combines unrelated smoke objectives. It is not wired to a fabricated live telemetry source.

## Requested Core interfaces for Claude

Provide a side-effect-free read module without importing providers or constructing mutable stores:

1. A transactional `readSnapshot({ objectiveId, now })` returning sanitized objective/task/DAG/review DTOs, explicit source epoch and durable event watermark. Preserve task-state vocabulary and lease semantics.
2. `readEvents({ scope, after, limit })` with stable IDs/time and safe typed cancellation/recovery metadata. Include confirmed/unknown/still-active provider cancellation semantics without leaking reasons or raw payloads.
3. An observed provider/worker descriptor: configuration vs availability, actual worker identity, model identity, freshness/last heartbeat, and historical verification separately. Unknown must remain explicit.
4. Live execution observations correlated with claim epoch, run and physical model-call ID: inference span, verification span, start/finish, terminal outcome, and staleness threshold. Only these observations can justify RUNNING/IDLE/OFFLINE and elapsed inference.
5. Task-linked permit/waiter observations including resource, valid lease, enqueue time and FIFO position, with scope and observation time. Raw machine-wide counts do not suffice.
6. A complete model-call usage ledger with stable IDs across retries/reconnects and explicit missing/partial fields, including cancelled/failed attempts. Add cached/reasoning breakdown semantics, model ID, price source, actual versus estimated cost and quota provenance. Do not overwrite retry records.
7. Safe Mastra metadata links/trace IDs tied to each run; explicit run lifecycle and authoritative objective lifecycle if different from batches.

Platform can then wire those interfaces into this contract. Coordinate any shape/semantic changes rather than independently changing the API. No instrumentation changes are included in this slice.

## UI refinement handoff — activity and usage tabs

The refinement preserves the existing neutral shell, hierarchy, inspector dimensions and Gateway/API schemas. Organization rows now show claim elapsed time and reported **current-task** tokens; Overview adds `Agent | Activity | Current Task | Elapsed | Tokens | Last Outcome`. The inspector has keyboard-accessible Overview/Usage/Runs tabs (arrow keys, Home/End, Escape).

Usage is derived only from the existing `Snapshot.calls` and task usage fields. Current-run usage matches an assigned active task's exact `runId`; historical reported usage excludes those calls and remains within the selected objective/provider/task. A task total is never relabeled as a run total. Stable call IDs are deduplicated, completed observations take precedence over pending replays, and snapshots replace totals through the existing SSE path. Cached/reasoning breakdowns are never added to input/output. If a dimension is missing in any included call, its aggregate stays UNKNOWN. Reported call count is a count of known distinct observations, not an assertion of complete instrumentation; no observations means UNKNOWN. Costs display only with explicit matching model and pricing provenance.

Missing Core fields, **not added to the API by this refinement**:

- Per-agent `lastHeartbeatAt` plus freshness/availability evidence. The UI uses `lastEventAt` with that exact label, never pretending it is a heartbeat.
- Per-run start/end or authoritative duration, retry count (coding retries versus runtime retries), and final run outcome. `ModelCall.attempt` cannot establish runtime retry count; task state cannot establish each run's outcome. Runs therefore show UNKNOWN for these fields and the task state separately.
- Complete run/call collection coverage, task/run usage correlation and safe trace links for historical runs. Existing call `completeness` describes reported observations, not assurance that every call has been collected. Current and historical totals remain explicitly reported/scoped.

Production currently supplies no model calls, so run usage and counts remain UNKNOWN until Claude exposes the existing requested read models. Tests use explicitly synthetic telemetry to exercise live updates, separate current/history values and SSE reconnection. No provider events or online presence are simulated in production; RUNNING is accepted only from the activity contract with a current, non-expired assignment. Historical success never creates activity.

## M13 Runs/navigation increment

Four primary views: Overview (execution lanes and contextual registered bindings), Runs, Collaboration (existing Discussions/Meetings/Council), Usage. Native Mastra Agents remains `/agents`. The objective selector now belongs to Runs, with project labels sourced directly from `batches.project` and a task-state filter. Other views identify their retained batch scope explicitly. No milestone or external-session correlation is guessed. The separate Overview `Agent | Activity | Current Task | Elapsed | Tokens | Last Outcome` table described above is removed: the same activity, elapsed and token values remain on each agent in the Overview hierarchy.

`ControlTask.execution` is an optional backward-compatible projection of existing task columns: coding `attempts` summed over runs, `runtimeRetries`, `runtimeRequeues`, `createdAt`, `finishedAt`, recognized `failureCategory`, recognized `reviewOutcome`. Unknown category/outcome strings become null. These counters are not physical call counts or per-run retries. Raw reasons, review feedback, result/artifact payloads and prompts remain excluded. Existing clients strip this optional field; older snapshots leave it unavailable. No persistence migration or core write path is involved.

The task inspector displays pending review rounds, execution timestamps/counters and the existing bounded lifecycle timeline. It explicitly distinguishes task state from verifier PASS. Detailed acceptance/verification artifacts, finding text, historical worker identities and task-to-Council associations remain unavailable; operators can inspect the original Council records through Collaboration. SSE reset/replay/reconnect behavior is unchanged.

Events additionally carry optional nullable `operation`: `workflow.started`, `lease.requeued`, or `claims.extended`, only for recognized fixed scheduler reason formats with matching transitions. Unknown text stays null; raw reason/actor/detail never enters the wire response. Replay uses the identical projection and original event identifiers.

The same optional execution projection includes `verifierExitCode` from the persisted result (null when absent/non-integer) and at most 50 recognized change-review finding codes with `block`/`warn` severity. `findingsOmitted` reports unrecognized/excess records. A non-array `findings` value projects as null rather than failing the snapshot. The allowlists are type-checked against the runtime `FailureCategory` and `FindingCode` unions, so a value removed from either fails typecheck; a newly added runtime value projects as null until it is allowlisted. Finding details, verifier commands/output and acceptance artifacts are withheld. These are task-result observations, never an inferred per-run PASS or a replacement for verifier authority.

**Execution lanes replace the static roster.** `agents` no longer contains a fixed Claude/Qwen/Codex/Gemini roster. Each entry is an execution lane for a provider that persisted tasks in the selected batch name; with no batch, or no database, the list is empty. `name` is the provider id, `role` and `parentId` are null (no role is inferred from a provider name), and `modelId` stays null because the scheduler records no model per task. Optional `evidence` is `ACTIVE` only while a lane holds a current, non-expired lease, otherwise `OBSERVED`. Neither value is an online state; registered agents (the registration roster) are a separate source and never imply activity. `providers` lists the same lanes.

**Absence labels.** The UI labels a missing value by cause and never as zero: `NOT RECORDED` when no telemetry source exists for the scope (`usage.source`/`completeness` `unavailable`) or a field is never collected (quota, model); `UNAVAILABLE` when the scheduler connection or the independent capacity sample is absent; `NO ACTIVE RUN` for a lane without a current lease; `NOT APPLICABLE` for claim elapsed on a task that is not leased; `UNKNOWN` for partial or expired evidence. Cost is shown only with reliable usage and pricing provenance and is never estimated. In Runs, scheduler state, outcome (recognized failure category and review outcome) and trace (`No run recorded` vs a run link) are separate columns, and a "Needs attention" filter selects `BLOCKED`, `ESCALATED`, `RUNTIME_FAILURE` and `REVIEW_REJECTED`. Attempts, runtime retries and requeues are independent per-task counters and are never summed.

## M13-B worker invocation telemetry (vertical slice)

**Source.** The coding runner already measured every attempt that got a model response (`AttemptRecord.telemetry`: provider, model, inference ms, provider-reported tokens). That measurement reached `attempts.json` and `trace.jsonl` only; neither carries a run id, so it could not be attributed safely and is still not read. The slice carries it through the one execution path instead: the runner adds the call's start time and the provider's declared usage capability; the workflow result's attempt summary carries the telemetry (unreported counts as null); the executor maps it into `ExecutorOutcome.modelCalls`; and `Scheduler.complete()` persists it under `tasks.artifacts.modelCalls` in the same transition that records the run id. Each entry adds the run id (`outcome.runId`, else the run the scheduler recorded at start) and the lease owner (`fence.owner`). No schema change: `artifacts` is an existing merge-patched JSON column, as for `leaseExpiries` and `recoveries`.

**Identity and retries.** One entry is one attempt's worker invocation: the provider-reported totals of that call, which may span several agent steps. It is not a physical model-call ledger. Inside an attempt the runtime-retry loop ends at the first response, so an attempt has at most one entry; failed tries report no usage and are not listed. Entries are keyed by (run, attempt): completing the same run again replaces them, a requeued run adds its own, malformed entries are dropped, and an entry without a run id is never written. At most 100 are kept per task. Cost is not persisted: the runner's local-free 0 is a policy, not a measurement.

**Projection.** The adapter validates each entry against a closed shape and rejects it if its run is not in the task's `run_ids` or its start time is missing. It then projects entries into the existing `calls` (`id = task:run:attempt`, status `COMPLETED`, latency = inference ms, cost null, optional `usageSupport`) and aggregates task, objective and provider usage with `summarizeUsage`, which de-duplicates by id and keeps any dimension with a missing value null. A total is never `complete` while coverage has a gap: a run without a recorded invocation (in flight, crashed, an older runtime, or no model call), failed runtime retries, a rejected entry, or (for a provider row) a call that ran on another provider than its lane. A provider declaring `usage: 'none'` shows NOT SUPPORTED; a supported but unreported count shows NOT REPORTED. Runs completed before this change show NOT RECORDED.

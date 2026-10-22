# M13 Organization console — implementation inventory

Base: PR #59 `618186e`, stacked on #57 (`integration/phase0-m11-registry-council`). PR #58 changes core path/delegation protection only. Neither integration nor safety branches are modified. PR #57 still has merge gates; this work does not imply approval of that integration.

## Existing surfaces and sources

- Studio `/organization` embeds `/organization-app/`. Native `/agents`, `/workflows`, `/traces` remain Studio-owned.
- Ten current views: Overview, Agent Chart (Organization), Agents, Objectives, Runs, Reviews, Discussions, Meetings, Council, Usage.
- Gateway GET routes (embedded `/control-center/v1`, standalone `/api/v1`): snapshot, events (SSE), collaboration, collaboration/events, collaboration/threads/:id, collaboration/sessions/:id, council, council/events, agents. Assets: index, app.js, app.css. Existing auth/origin/RBAC remain authoritative.
- Scheduler read-only SQLite adapter: batches, tasks, latest 200 events, pending reviews; capacity independently sampled machine-wide. No scheduler construction or writes.
- Collaboration adapter: verified scheduler collaboration event store. Council adapter: same reader over council.db plus cross-checked record sidecars. Preserve identifiers, integrity and LIVE/SCRIPTED labels.
- Registration adapter: actual registered agent bindings, separate from the legacy logical provider roster.
- Usage contracts exist but scheduler projection currently supplies zero call observations, not zero measured tokens. Council invocation accounting can encompass multiple physical model steps; it cannot simply be relabelled a physical-call ledger.

## Limits and bounded increments

A: Four primary sections. Runs owns project/batch/status filters, task table, dependency graph, workflow references and review context. Project is persisted batches.project; batch is explicitly not an independent engineering objective. Milestone and external Claude sessions unavailable: no authoritative metadata/ingestion contract. Add nullable, backward-compatible read projection of existing task attempt/recovery counters and timestamps; no core schema changes. Raw feedback, reasons, prompts and artifacts remain excluded. Recorded verifier exit code and recognized change-review code/severity are projected from existing task results (50-finding bound). Raw finding details, acceptance artifacts, historical worker identity and per-run outcomes remain unavailable until safe read contracts exist.

B: Independently review telemetry collection at physical-call boundary before projecting usage. Preserve physical IDs, retry distinction, specialist IDs and incomplete dimensions; no parsing unverifiable artifacts or treating aggregate Council invocations as physical calls.

C: Consolidate existing discussion/meeting/Council components and verify parity. A supplies their shared navigation container; stores and engines remain unchanged.

D: Only after A–C useful functionality: compact Overview, confirmed UX fixes, production build and actual Studio browser acceptance.

## Ownership and verification

Direct overlap with #59: main.tsx and control-center projection. Reuse its latest base; retain agents component and Council adapter. No changes to #58 core files, scheduler, routing, sandbox or verifier. Milestone persistence requires a separately coordinated core boundary change and is not guessed from identifiers.

Run root typecheck/tests, UI typecheck/build and focused adapter/UI tests. Browser on isolated port with real persisted scheduler/Council reads; never terminate another server or invoke models. Capture before/after in .workdir; document exact source and missing evidence. Draft PR A stacks on #59 and preserves existing merge gates.

## Shared Project / Objective scope: association audit (2026-10-22)

Every store was inspected for a persisted association to a scheduler batch, which carries `batches.project`, before any filter was built.

| Source | Association | Authoritative? | Evidence |
| --- | --- | --- | --- |
| Scheduler tasks, runs, reviews, events | `tasks.batch_id` -> `batches.project` (NOT NULL) | Yes | Every task has a batch, and every batch a project, so scheduler records are never unattributed |
| Worker invocation telemetry (#60) | `tasks.artifacts.modelCalls` belongs to its task -> batch | Yes | Persisted on the task row in `complete()` |
| Discussions / Meetings (`collab_events` in the scheduler DB) | `thread.refs.batchId` / `refs.taskId`, validated against the same DB when written (`collaboration/store.ts` `checkRefs`); a meeting inherits its thread's refs | Yes, for batch/task refs | Real data: both threads carry only `refs.objectiveId = "M10-RELIABILITY-LAB"`. That label is not validated, and the matching batch `M10-RL` resembles it in name only, so both stay Unattributed |
| Council (`council.db`) | none: `council/run.ts` opens threads with `refs: {}`. `council.db` has its own (empty) scheduler tables, so a ref there could not name a batch in the scheduler of record | No | Real data: both meetings have `refs = {}` |

**Rules implemented.** Scope resolves only through `batches.project`. An objective outside the selected project is an empty scope, never a widened one. Collaboration records are ATTRIBUTED only through a batch/task ref resolved in the scheduler of record, and everything else is shown under the explicit Unattributed scope with its reason. Nothing is matched by name, prefix, time or model.

**Proposed correlation contract (deferred; not implemented).** To attribute Council meetings, the council run would record `refs: { batchId?, taskId? }` plus `schedulerDatabaseId`: the scheduler of record's database identity, which the Control Center already derives as `databaseId`. It would validate the refs against that scheduler when the meeting is opened, through a read-only lookup of `batches`/`tasks` in the scheduler DB. The Control Center would then mark a Council meeting ATTRIBUTED only when its recorded `schedulerDatabaseId` equals the current `databaseId` and the ref resolves there. The change is backward compatible: records without the fields stay Unattributed. It touches the council runtime (`src/runtime/council`), so it needs its own reviewed change.

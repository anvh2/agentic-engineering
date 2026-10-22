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

# Multica Capability Benchmark and Adoption Plan

**Status:** Proposed
**Date:** 2026-11-24
**Branch:** `feat/multica-capability-adoption`
**Scope:** Architecture and product-capability adoption for Agentic Engineering
**Reference implementation:** [multica-ai/multica](https://github.com/multica-ai/multica)

## 1. Executive decision

Agentic Engineering (AE) should learn from Multica's **operating model**, not clone its product surface or replace its runtime.

AE already has a deeper engineering execution and verification core: a persistent SQLite scheduler, lease/fencing and recovery, isolated task worktrees, sandboxed execution, deterministic verification, review/integration gates, provider adapters, collaboration records, and a read-only Control Center.

The highest-value opportunity is to connect these existing capabilities into a coherent **Agent Workforce and Engineering Operations Platform**:

- Agents are durable, addressable workers with capabilities, provider configuration, and runtime assignments.
- Runtimes are explicit execution hosts, not inferred from logical provider names.
- Work is represented by durable tasks/issues with ownership, dependencies, lifecycle, and evidence.
- Each execution is a first-class run linked to its task, agent, runtime, worktree, events, artifacts, usage, and review.
- Humans can assign, steer, pause/cancel, review, and approve work through one control surface.
- Skills and successful workflows become reusable operational playbooks.

Mastra remains an integration and presentation/orchestration component. The AE runtime and scheduler remain authoritative for engineering execution.

## 2. Multica capabilities worth learning from

Based on the public Multica README and architecture documentation:

| Capability | What Multica demonstrates | AE adoption decision |
|---|---|---|
| Durable agent identity | Named agents with provider and runtime identity | **Adopt.** Separate logical agent identity from provider/model and physical process. |
| Agent pool / squads | Humans and agents share a workspace; squads route work | **Adapt.** Build team/role/capability assignment on top of AE's existing lead, specialist, and worker concepts. Avoid autonomous agent-to-agent free-for-all. |
| Runtime daemon | A daemon connects machines and claims work; local tools run on user-controlled machines | **Explore strongly.** This is the largest architectural gap if AE is to support multiple machines/runtimes. Start with a local runtime host abstraction, not a distributed rewrite. |
| Provider adapters | Multiple coding CLIs are normalized behind provider implementations | **Continue/adopt.** AE already has provider abstractions; improve capability discovery, lifecycle normalization, streaming, cancellation, and usage normalization. |
| Issue/task assignment | Work is assigned to an agent and remains connected to its execution | **Adopt.** Make the existing scheduler task the canonical work item; add intake/integration adapters rather than another task database. |
| Run lifecycle and execution log | Runs expose progress, tool activity, failures, and final result | **Adopt selectively.** Build a privacy-safe event/evidence timeline from existing scheduler and runner events. Never persist chain-of-thought or secrets. |
| Live steering | A human can send input to a supported running provider session | **Explore.** Add only through a provider capability contract; unsupported providers must report this honestly. |
| Skills/playbooks | Reusable skills are available to agents | **Adopt.** Extend the existing knowledge/pack/skill system with discoverability, versioning, applicability, and measured outcomes. |
| Review gates | Agent output returns for human review before shipping | **Already a core AE strength.** Preserve and make the lifecycle visible; do not weaken deterministic verification or explicit approval. |
| Scheduled autopilots | Recurrent audits and work can be triggered on a schedule/webhook | **Adapt later.** Reuse existing scheduler/automation primitives; add policy, budget, idempotency, and approval controls first. |
| Usage analytics | Cost/usage is attributed to runs, agents, and issues | **Adopt.** Normalize provider usage and attribute it to task/run/agent/model where source data exists; unknown must remain unknown. |
| Multi-Git-host and multi-client | Multiple VCS providers and web/desktop/mobile surfaces | **Defer.** GitHub and the existing Mastra Studio/Control Center are sufficient for the current product direction. |

Reference: Multica README and developer architecture:
- https://github.com/multica-ai/multica
- https://github.com/multica-ai/multica/blob/main/apps/docs/content/docs/developers/architecture.mdx

## 3. Agentic Engineering baseline inventory

This inventory is based on the current `master` source tree and repository architecture/operations documents inspected on 2026-11-24. It is not a claim that every capability has been validated against a live multi-machine deployment.

### Existing foundations to preserve

| Area | Existing AE implementation / contract | Implication |
|---|---|---|
| Execution authority | `src/runtime/scheduler`, SQLite scheduler store, one supported lead → scheduler → executor → Mastra workflow → runner → worker path | Do not add a second scheduler or task database. |
| Lifecycle and recovery | Scheduler state machine, atomic claims, lease expiry, fencing, bounded retries/requeues | Extend existing transitions and audit events; preserve recovery semantics. |
| Work isolation | `src/runtime/worktree`, task and integration worktrees | Keep worktree ownership in Core; expose metadata through read models. |
| Provider execution | `src/workers/providers`, provider registry and worker abstraction | Add adapters/capabilities without making provider-specific assumptions in Core. |
| Safety and verification | `src/runtime/sandbox`, deterministic verifier, review and integration/rollback paths | Verification remains authoritative; agent-reported success is not PASS. |
| Lead and specialists | `src/lead/objective`, `src/lead/collaboration`, `src/integrations/mastra/specialist-agents.ts`, council workflows | Evolve the current hierarchy rather than introducing uncontrolled peer orchestration. |
| Skills and engineering knowledge | `src/runtime/knowledge/packs`, engineering knowledge and continuity modules | Extend existing skill/knowledge mechanisms; avoid a parallel skill store. |
| Control Center | `src/integrations/control-center`, `apps/control-center`, Mastra Studio integration | Expand existing read models and UI; preserve the current Studio port and integration ownership. |
| Observability | Scheduler events, collaboration records, usage and metrics adapters | Build a unified view by joining authoritative records, not by copying them into another database. |

### Gaps to validate before implementation

1. **Agent identity and lifecycle:** current logical provider/role identity is not the same as a durable agent profile, and neither proves a live process exists.
2. **Runtime host abstraction:** determine whether current worker execution can be hosted on a second machine without violating local state, sandbox, credential, and worktree boundaries.
3. **Run as a first-class aggregate:** map scheduler task, Mastra run, provider process/session, worktree, attempts, artifacts, and usage. Identify authoritative IDs and lifecycle ownership.
4. **Live steering:** inspect provider APIs and current process supervision to determine which providers support safe stdin/session input, interrupt, resume, and cancellation.
5. **Event coverage:** identify missing events for provider start/ready, progress, tool activity summaries, heartbeat, disconnect, reconnect, and terminal process exit. Do not infer liveness from Git changes or a scheduler lease alone.
6. **Usage attribution:** identify what token/cost fields are actually available per provider and per attempt; do not estimate silently.
7. **Work intake:** assess GitHub issue/webhook support and task mapping; scheduler remains canonical after intake.
8. **Skills operations:** assess versioning, assignment, provenance, and success/failure feedback for existing knowledge packs.

Each gap must be classified as **implemented**, **partially implemented**, **missing**, or **not applicable**, with code references and tests/evidence.

## 4. Target conceptual model

Keep the existing scheduler as execution authority. Introduce or formalize these concepts only where current records do not already provide them:

- **Agent profile:** stable logical identity, display name, role, capabilities, allowed providers/models, policy, and enabled state.
- **Provider:** adapter/CLI implementation and model identity. A provider is not an agent and not a running process.
- **Runtime host:** machine/daemon identity, supported capabilities, health/heartbeat, labels, and capacity. Host state must be derived from authenticated runtime signals.
- **Assignment:** which agent/provider/runtime is responsible for a task attempt.
- **Work item:** canonical scheduler task, optionally linked to an external GitHub issue or other intake source.
- **Run/attempt:** one concrete execution attempt, correlated to task ID, claim epoch, provider session, runtime host, worktree, and artifacts.
- **Event:** append-only lifecycle facts with stable IDs, timestamps, source, correlation IDs, and sanitized payloads.
- **Artifact/evidence:** diff, test result, verifier report, review record, logs/diagnostics subject to redaction and retention rules.
- **Skill/playbook:** versioned reusable instructions/tools with provenance and outcome feedback.

Do not create new tables/entities merely to mirror these names. Phase 0 must map each concept to existing tables/files first and identify the smallest necessary schema changes.

## 5. Target architecture

```text
GitHub / CLI / Control Center / Automation
                  |
           Work Intake API
                  |
      Engineering Control Plane
       |          |           |
   Agent Registry |      Policy / Approval
       |          |
   Existing Scheduler (source of truth)
       |
   Runtime Assignment / Claim
       |
   Runtime Host(s) / local daemon (future)
       |
   Provider Adapter -> Claude / Codex / Qwen / other CLIs
       |
   Existing Worktree + Sandbox + Coding Runner
       |
   Deterministic Verification -> Review -> Integration
       |
   Existing DB events + artifacts + usage evidence
       |
   Read Models / SSE -> Control Center / Mastra Studio
```

The diagram is a target direction, not authorization to build every box at once. In the first increment, retain the current single-machine execution path and prove the domain contracts locally.

## 6. Adoption roadmap

### Phase 0 — Evidence-based architecture audit

- Map Multica capabilities to AE source files, tests, persisted records, and UI.
- Trace one real task from intake through claim, provider execution, verification, review, integration, and Control Center display.
- Identify authoritative IDs and sources of truth for agent, task, run, attempt, runtime, worktree, event, artifact, and usage.
- Inspect provider capabilities and multi-host constraints.
- Produce a capability matrix, current-state diagrams, gap register, risk register, and proposed ADRs.
- No production code, schema, or UI changes in this phase.

**Exit gate:** every proposed feature has an evidence-backed gap and a named existing owner/source of truth.

### Phase 1 — Agent and runtime identity contracts

- Define durable agent profile and runtime host contracts.
- Separate logical agent, provider/model, process/session, and runtime host identities.
- Define capability negotiation (streaming, cancellation, steering, resume, usage, worktree requirements).
- Define runtime authentication, least privilege, heartbeat, disconnect, and stale-host semantics.
- Keep the current local runtime as the first implementation.
- No second scheduler or replacement of the SQLite scheduler.

**Exit gate:** contract tests prove identity separation and truthful liveness states.

### Phase 2 — Unified run/event read model

- Correlate task, claim epoch, attempt, provider session, runtime host, worktree, artifacts, and usage.
- Add missing lifecycle facts at the source that owns them.
- Expose privacy-safe read models and replayable events through the existing Control Center Gateway.
- Keep database state authoritative; SSE/WebSocket is notification/transport only.
- Unknown or unsupported states remain UNKNOWN, never fabricated.

**Exit gate:** a reconnecting UI can reconstruct the same state from persisted records; no duplicate event store or LLM polling.

### Phase 3 — Agent operations in the existing Control Center

- Agent directory: identity, role, capabilities, provider, runtime assignment, and evidence-backed health.
- Task board: assignment, dependencies, queue, blocked work, and review state using scheduler records.
- Run inspector: attempts, sanitized lifecycle timeline, worktree/diff, verification evidence, and usage.
- Runtime view: hosts, heartbeats, active assignments, capacity, disconnects.
- Human actions only where backed by explicit authorization and safe Core commands; read-only first.
- Preserve Mastra Studio at `localhost:4111`; previews use free ports from 4112+.

**Exit gate:** one real task is traceable end-to-end without terminal hopping or invented activity.

### Phase 4 — Runtime host / daemon pilot

- Prototype an authenticated local daemon using the existing scheduler claim protocol or a narrowly scoped runtime-host API.
- Start with one additional machine and one provider.
- Bind credentials to host/task/attempt with expiry and least privilege.
- Prove reconnect, lease expiry, fencing, cancellation, process cleanup, worktree isolation, and artifact transfer.
- Keep the single-machine path as the default until the pilot passes reliability and security gates.

**Exit gate:** chaos tests prove no duplicate execution, stale completion, cross-task access, credential leakage, or orphaned work after host interruption.

### Phase 5 — Skills, steering, intake, and automation

Prioritize independently based on Phase 0 evidence:
- versioned skill/playbook assignment and outcome feedback;
- provider-specific live steering with explicit capability declarations;
- GitHub issue/webhook intake mapped to canonical scheduler tasks;
- scheduled autopilots with idempotency, budgets, policy checks, and approval boundaries;
- normalized per-run/provider usage attribution.

Do not bundle these into a single large release.

## 7. Non-goals and hard constraints

- Do not copy Multica source code or assume its source-available license is equivalent to Apache-2.0.
- Do not replace Mastra now; keep it as an adapter/integration and preserve the canonical Studio at `localhost:4111`.
- Do not add a second scheduler, duplicate task database, or parallel execution path.
- Do not infer process liveness from Git activity, task state alone, or historical records.
- Do not persist chain-of-thought, hidden reasoning, secrets, full environment dumps, or unrestricted raw transcripts.
- Do not allow agents to approve their own work or bypass deterministic verification.
- Do not auto-merge, push, or modify the user's primary checkout.
- New worktrees must live under the canonical repository's `.worktrees/<session-id>`.
- Do not squash merge.
- Preserve lease/fencing, run-once/zombie protection, cancellation, sandbox fail-closed behavior, protected paths, verification side-effect detection, SQLite busy handling, and integration rollback.
- Do not expand to desktop/mobile or multiple Git hosts before the core runtime/event model is proven.

## 8. Success criteria

1. A human can see every known agent profile and distinguish it from provider, runtime host, and actual process/session.
2. Every active or historical task can be traced to its attempts, assigned worker, worktree, verification evidence, review, and final integration result.
3. Runtime liveness is based on authenticated heartbeat/process evidence and has explicit UNKNOWN/STALE/DISCONNECTED states.
4. Control Center state is reconstructable from existing authoritative persistence after disconnect/restart.
5. A second runtime host can execute a task without duplicate claims, stale writes, cross-task access, or credential leakage.
6. Usage is attributed only when provider evidence supports it; unknown values stay unknown.
7. Existing scheduler, worktree, sandbox, verification, review, and recovery tests continue to pass.
8. The user can operate the engineering workflow from Mastra Studio/Control Center without manually coordinating every worker terminal.

## 9. Immediate next actions

1. Complete Phase 0 as a code-and-evidence audit, not a UI design exercise.
2. Publish the capability matrix and gap register for review.
3. Agree on the smallest Phase 1 contracts and ADRs.
4. Only then create implementation tasks and delegate independent slices to workers.

**Recommendation:** Treat Multica as a benchmark for the agent workforce operating model. Treat AE's scheduler, sandbox, verification, and integration pipeline as the differentiating engineering core. The goal is to combine the best operational ideas without diluting AE's stronger execution guarantees.

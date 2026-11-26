# V2 architecture decisions

Author: Codex; 2026-11-26 UTC. Initial review candidates. User-confirmed product directions are distinguished from implementation proposals. See codex-analysis.md for source evidence.

## ADR-001 — Extend the desktop prototype with an embedded Go core

Status: user-confirmed direction; detailed boundary pending joint review.

Use app/ with Wails, SQLite and embedded MCP. Direct calls between packages; native agent subprocesses are not replacement workers. Retain V1 in source and preserve all V1 state. Alternative: extend Mastra scheduler. Rejected for V2 because it carries worker restrictions and an orchestration framework the charter excludes. Cost: Go reimplementation of selected invariants and migration of demo UI to real bindings.

## ADR-002 — Separate identity, execution, responsibility and acceptance

Status: proposed.

Agent identifies a native harness; role is a versioned knowledge snapshot on a session. A task can have successive sessions. Process exit never establishes task acceptance. Agent mutation tools can submit work, report blockers and coordinate ownership; trusted verification/review decides acceptance on an exact revision. Alternative: one role per provider or completed process = done. Rejected because it conflates responsibility with capability and makes false success possible.

## ADR-003 — Session-scoped authenticated Streamable HTTP

Status: proposed, native compatibility gate required.

Use the official Go MCP SDK and loopback HTTP, one bearer principal per provisioned session, server-derived scope and identity. Native per-session configuration must preserve other native MCP servers and settings. Credentials never go in source, logs or argv. Reject foreign Origin and Host, enforce bounded requests and redact internal failures. Alternative: permanent stdio broker or unauthenticated localhost. Rejected because extra broker adds lifecycle burden and localhost alone is not authentication. Stateless transport is preferred for bounded collaboration calls if installed clients support it; domain sessions remain durable regardless of MCP transport session IDs.

## ADR-004 — SQLite is the durable coordination authority

Status: proposed.

Use transactions for ownership, revisions, messages, idempotency and event persistence. One database per V2 runtime; agent scope determines access, not caller-supplied project IDs. Reads do not consume messages. Use source ordering plus monotonic sequence; timestamps are presentation data. No broker, timer-driven inference or distributed scheduler. Alternative: keep bootstrap files. Rejected because multi-record changes, paging and crash consistency need a real transactional boundary. The bootstrap directory is retired only after native MCP exchange is verified.

## ADR-005 — Preserve native harnesses; verify outcomes independently

Status: confirmed principle; concrete lifecycle/security implementation pending experiments.

Preserve tools, skills, native memory/rules, hooks, planning and approvals. Do not reuse V1 fixed tool disabling or replace native prompts. Snapshot appended engineering fundamentals and scope. Invoke native start/resume only through version-validated interfaces; support provider-specific capabilities rather than pretend parity. Independent sandboxed verification remains required for generated code. Approval requests remain actionable or visibly blocked; never auto-approve unknown permissions. Existing user sessions are not app-owned.

## ADR-006 — Unknown telemetry remains unknown

Status: proposed.

Persist native raw event identity and normalization provenance. Null differs from zero. Cumulative and delta usage cannot both contribute to aggregates. Subscription charges, API-equivalent estimates and reported billed cost are separate fields. No exact spend guarantee where usage arrives late. Alternative: assume zero when missing or label token-rate estimates billed cost. Rejected because it misrepresents cost and defeats budget decisions.

## ADR-007 — Preserve data and make packaging claims separately

Status: proposed.

V2 starts with a new database and explicit schema migrations. No automatic V1 import, deletion or persisted identifier changes. Single DMG includes compiled Go/Wails frontend, MCP, SQLite and knowledge defaults; CLIs remain discovered external native installations. Build, launch, clean-machine install, signature, notarization and upgrade preservation are separate acceptance evidence. A local unsigned build proves none of the latter.

## Reconciliation checkpoint: native evidence changes the M1 design

2026-11-26 UTC. Claude independently reviewed the analysis and demonstrated native MCP with installed clients. Original review and Codex response are retained in reviews/. The initial architecture above is superseded for M1 where specified here:

- One process per native turn; native session ID provides continuity. App-server is a researched alternative for interactive approvals, not an M1 dependency.
- Per-turn tokens and participant-addressed messages replace per-session credential lifetime and session-addressed mail. Startup must explicitly revoke tokens for interrupted turns; a crash alone does not invalidate a TTL.
- Five collaboration tools only. Their approval may be scoped to this server so headless clients can call them. Preserve all other native MCP configuration and tool permissions; do not use Claude strict-mcp-config by default.
- Fetched cursor is sufficient for M1 if explicit replay remains possible. It is not evidence of action or acknowledgement.
- Wake coordination is deterministic, single-flight and coalesced, with explicit objective authorization/budget. No default authorization to spend 24 turns.
- Go 1.25 and official MCP SDK 1.8.0 are selected, verified from cached source and installed compiler. SQLite is Claude's package responsibility; dependency reconciliation occurs on integration.

Headless native editing permissions, compaction survival and live cancellation remain gates for M2. The source-level MCP contract is frozen; native launcher corrections await Claude acknowledgement. Neither agent agreement nor these ADRs approve a master merge or permanent DNA change.

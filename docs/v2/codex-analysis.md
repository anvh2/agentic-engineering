# V2 technical analysis and implementation contract

Author: Codex. Evidence collected 2026-11-26 UTC. Status: initial report for independent Claude review; implementation contracts proposed until reconciled.

## Baseline and authority

Master and origin/master locally resolve to `9b2dcd968c4c05cf139f2b46edaa9369a1246f0c`. GitHub PR #76 reports that same base and head `26365c08307e0461c1f657af47cef5e9f1a1f0bf`, two commits, 12 changed files, draft/open/unmerged. Codex worktree starts at that head, branch `codex/v2-foundation`. The canonical checkout has user modifications to app/go.mod and untracked Wails build artifacts, lockfiles and the supplied charter. They are excluded from this branch. No master merge or push is authorized. Canonical root was discovered through `git rev-parse --path-format=absolute --git-common-dir`.

The user's V2 request explicitly supersedes the V1-only execution-path rule for the isolated app and authorizes docs/v2. It does not authorize weakening V1 verification, touching V1 databases, changing permanent engineering policy, or replacing Studio. V1 remains runnable as historical source; V2 does not route through Mastra.

## Evidence and audit coverage

Inspected AGENTS.md, full supplied V2 charter, Mastra SKILL.md, package.json, Git refs/worktrees/status, PR metadata, app/main.go and frontend source; runtime architecture, scheduler SQL/transaction boundaries, Codex provider and isolation policy, sandbox implementation, engineering context hashing and knowledge catalog. Historical evidence sampled: M8.6 recovery, M8.7A credential isolation, M8.7B verifier parity, M10.1 reliability JSON, Gemini 404 postmortem. This is targeted coverage, not an exhaustive audit of every runtime file or historical run. Historical reported test counts are not current test results. Raw session transcripts and credentials were not collected.

M10.1 lab summary records 14 passes across seven fault scenarios, twice each, with concurrency two. M8.7B reports a historically passing 869-test run and documents prior load-sensitive timeout failures. M8.6 records real CLI against a stub model, not real provider inference. These distinguish deterministic plumbing evidence from native collaborative delivery, which remains unproved.

## Retain, replace, retire

| Existing component | V2 disposition | Concrete reason |
| --- | --- | --- |
| app/frontend dark UI and Wails entrypoint | Retain visual baseline; replace localStorage execution state | main.go has no Go bindings; main.ts seeds invented sessions, cost and accepted decisions. Preserve demo data separately, never import it as real execution. |
| Runtime sandbox and mutation checks | Preserve V1; port security invariants with independent V2 verification | sandbox.ts denies reads/writes by default and probes isolation. Worker prose and exit zero cannot establish acceptance. |
| Scheduler atomic claims and fencing | Retain invariant, replace implementation | store.ts uses BEGIN IMMEDIATE and busy_timeout. V2 needs transactional owner/revision checks, not a distributed scheduler or time-based leases before demonstrated need. |
| Codex provider wrapper | Replace for V2 | codex.ts imposes one-file worker scope, disables normal tools/config in isolation and forbids committing. This contradicts full native agents owning implementation and review. |
| Process cancellation/recovery | Retain evidence requirements | Requesting cancellation is distinct from confirmed exit; persist interruption, reject late writes, never signal a recovered PID without owned-process proof. |
| Context fingerprint / knowledge catalog | Retain concepts, use editable Markdown snapshots | Source hashes and scope prevent silent context drift; native skill discovery must remain available. Keyword filtering is not authority enforcement. |
| Mastra workflows, Ollama/Qwen capacity, distributed-style council scheduling | Exclude from V2 runtime and DMG | Go direct calls and native CLI lifecycle are sufficient; preserve source/history and persisted names for V1. |
| V1 project/checkpoint schemas and databases | Leave untouched | No automatic import, rename, deletion or table reuse. Any later import requires explicit versioned mapping and backup. |
| Integration review/rollback | Retain exact-revision evidence | Code merge and execution-data publication are independent. V2 acceptance must reference reviewed tree and verification results, with human master-merge gate. |

## Smallest architecture

One Wails process owns core service, SQLite connection pool and loopback MCP handler. Desktop calls Go directly. MCP calls the same core methods with an authenticated principal. Native processes retain their own tools, skills, subagents, rules, permissions and context management. No inference in delivery queues, state transitions, metrics or retries.

Domain: Project → Objective → Task; Repository linked many-to-many with Project. Session belongs to one execution scope and records agent identity separately from role snapshot. Events, messages, decisions and usage preserve provenance. No Workspace entity. No generic workflow engine.

Dependencies: desktop → core; mcp → core; core → storage. MCP must not issue SQL. Native adapter reports facts to core and cannot manufacture verification PASS. Trusted desktop administration creates objectives, sessions and scoped credentials; agent tools cannot mint sessions, approve permanent policy, or grant themselves permissions.

First slice: two provisioned sessions exchange durable messages through authenticated MCP, read their objective, and contend for a task with exactly one winner. Persist restart-safe ordering and idempotency. Agent completion means submitted for review, never accepted. Subsequent slices add decision responses and knowledge access, then native lifecycle and UI.

## Proposed MCP/security contract

Use official Go MCP SDK after version inspection, Streamable HTTP if both installed clients negotiate it. Bind explicitly 127.0.0.1 on an ephemeral port, never 4111. Authenticate before protocol processing with randomly generated per-session bearer tokens; store only hashes. Bind token to session, project and objective. Reject missing/invalid/revoked tokens, unrelated Host and browser Origin. Do not persist authorization headers or return database errors to tools. Body and field sizes, paging and timeouts are bounded.

Tools initially: send_message(recipient, body, idempotency_key), read_messages(after, limit), get_objective(), claim_task(task_id, expected_revision), update_task(task_id, expected_revision, status, summary). Scope and author derive from authenticated identity, never caller fields. IDs are opaque, timestamps server-assigned UTC. Duplicate identical mutation returns prior result; same key with different content conflicts. Reading is non-destructive; acknowledgement is separate from fetch, and message persistence is not proof of model attention. No automatic inference loop.

Task claims use atomic compare-and-swap revision with session ownership. Owner loss, cancellation and restart must prevent stale updates. A completed process yields a proposal; only trusted verification and review establish acceptance. Cross-objective recipient/task references fail without leaking existence. Reads are bounded and ordered by durable sequence, not wall time.

Threat boundaries: loopback does not imply trust; malicious web origins and local processes exist. Same-user filesystem compromise is outside token isolation guarantees and must be stated. Credentials stay private in session configuration, never argv or Git. Knowledge and messages are untrusted data and cannot confer authority.

## Native discovery and gaps

Installed PATH binaries: Claude Code 2.1.59, Codex 0.161.0; Go 1.25.10 darwin/arm64. Claude's independent bootstrap notes newer IDE/daemon versions: version pin must identify the actual executable, not an app label. Local `claude auth status` reports no login in this sandbox; Codex reports ChatGPT login. Neither proves inference availability. User confirms an already-running independent Claude session; do not launch another or alter authentication.

Claude help confirms --mcp-config, --append-system-prompt, --session-id, --resume, stream-json input/output and partial events. Prefer appended fundamentals over replacing the native system prompt. Codex help confirms per-invocation config overrides, exec JSON, explicit resume/fork, app-server stdio and protocol schema generation. Evaluate app-server for interactive lifecycle/approval requests; exec JSON remains a simpler bounded fallback, with explicit capability limitations. Do not reuse V1 --ignore-user-config or fixed feature disabling by default.

Official references consulted: https://developers.openai.com/codex/mcp ; https://developers.openai.com/codex/app-server ; https://code.claude.com/docs/en/mcp ; https://code.claude.com/docs/en/headless . Documentation describes MCP and native programmatic sessions, but installed versions govern compatibility. Actual HTTP bearer negotiation, native wake, compaction context survival and usage semantics still require local experiments. Reading CLI help is not a successful end-to-end test.

Session lifecycle: provisioned, starting, running, awaiting_input, stopping, exited, interrupted, failed. Store native ID separately from app ID; lifecycle and task acceptance are separate. Persist spawn intent before start, record actual owned child, reconcile uncertainty after crash; never automatically retry an uncertain external effect. Restart invalidates credentials unless explicitly reprovisioned. Avoid PID-only recovery or attachment to unrelated existing sessions.

Role bootstrap: load all condensed global/role fundamentals plus authorized context once before substantive work, store exact text/digest/version. Native instructions remain authoritative. Resume with a focused delta and verify snapshot identity; after compaction, verify critical context through an experiment rather than asserting permanence. Human-approved permanent knowledge versions are immutable; proposed calibration remains pending.

Usage: keep raw provider event identity and schema, normalization version and scope. Nullable input/output/cache/reasoning values remain unknown when absent. Distinguish turn deltas from cumulative snapshots and deduplicate native IDs; never sum both. Native API-equivalent estimate is not subscription charge. No billing amount without provenance. Store cost kind, currency, pricing version/effective date and model when known. Budgets may halt future dispatch; telemetry lag prevents hard dollar guarantees.

## Persistence and recovery

New V2 database under an explicit .workdir/v2 location for repository dogfooding. Per-worktree state stays local; the shared bootstrap directory is the user-authorized temporary exception. Packaged app data-root choice requires reconciliation with repository runtime policy; do not silently write elsewhere. Separate migration version table, transactions, foreign keys, WAL and busy timeout; tests must exercise lock contention, rollback and reopen. Preserve database on uninstall. Before future destructive migrations, snapshot with SQLite backup semantics including WAL, validate backup, and refuse unsupported downgrade. No V1 migration in first release.

## Roadmap, ownership and measurable gates

1. M0 (Codex analysis, Claude independent review): reconcile this report and core types, record all severity findings with resolution or blocker. Both inspect source. No affected implementation before agreement.
2. M1a (Claude storage/core): migrations, scoped sessions/objective/task/message service, revision-checked claims, durable idempotency. Tests: two concurrent claimers → one owner; duplicate send → one row; foreign scope denied; reopen retains ordering; failed transaction leaves no partial effect.
3. M1b (Codex MCP): authenticated bounded SDK handler, core-only dispatch, protocol tests. Tests: initialize/list/call with real SDK client; no-token/revoked-token/foreign-origin denied; forged identity rejected; errors redact internals; cross-session access denied; clean shutdown.
4. M1c (joint cross-review): native Claude and Codex clients each initialize and exchange a real message with usage/context recorded. Restart and duplicate delivery tested. Only then migrate collaboration from bootstrap; no claim that generic HTTP is native dogfooding.
5. M2 (ownership after M1): native adapter lifecycle, context snapshots, deterministic event/usage ingestion, controlled task execution and independent verification. Tests: explicit resume ID, cancellation confirmed, stale results rejected, crash reconciliation, missing usage stays unknown, cumulative event replay does not double count.
6. M3 (joint): preserve approved styling, replace demo with Go bindings and truthful empty/error states; connect projects/objectives/messages/session timeline/decisions/knowledge. Verify objective creation and persistence, no fictional success/cost, keyboard navigation and HTML escaping.
7. M4 (joint): reproducible Apple Silicon Wails build and single DMG containing backend/assets/migrations/default knowledge. Clean-machine launch without dev tools; missing CLI/login guidance; upgrade preserves DB; signing/notarization reported separately. Bounded real collaborative objective with interruption and verified delivery; benchmark intervention count, elapsed time, rework, context overhead and usage. Do not invent success thresholds before baseline.

Required checks remain npm run typecheck and npm test, plus Go race tests, vet, frontend typecheck/build and native packaging checks as applicable. Record revision, commands, UTC times, environment, failures and skips. Full V2 is not complete until real native collaboration and packaged installation are demonstrated.

## Consequential unresolved risks

Native tool preservation and V1's strict worker containment cannot be reconciled by copying the old launcher. Keep native permissions, add independent sandboxed verification, and explicitly test all new authority surfaces. Existing user agents are not app-owned and must not be terminated or silently reconfigured. MCP alone cannot wake an idle agent. Model calls, signing/notarization credentials and master integration need their existing authority gates. Any unauthenticated or unreviewed shortcut is excluded from the initial foundation.

## Governance and skills audit addendum

`docs/architecture/engineering-pack.md` describes 37 skills and 20 specialist role manifests, promoted immutable knowledge, public-key authenticated approvals, signed outcomes, and append-only hook logs. `src/runtime/execution/design-approval.ts` explicitly distinguishes caller-supplied approval references from verified authority; by default absent authority refuses approval. `non-delegatable.ts` resolves symlinks before protecting runtime paths. Retain the principles of digest-current knowledge, independent findings, no self-approval and explicit unsupported outcomes. Do not carry over specialist read-only tool tables into V2 flexible roles. Existing manifest provenance may inform human-reviewed Markdown, but copying it is not automatic promotion. Hashes prove integrity, not human approval.

The V2 desktop needs a trusted human approval channel distinct from agent MCP. An MCP decision response may express agent agreement, never impersonate Engineering Director approval or mutate permanent DNA. Desktop backend mutations must bind approval to exact candidate version and record actor provenance; a free-form actor string alone is insufficient. Existing signing keys are not to be read, generated or migrated by this task.

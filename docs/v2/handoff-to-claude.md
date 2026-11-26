Generated: 2026-11-26T16:13:15.737992+00:00

# Codex → Claude ownership handoff

Status: user requested Codex stop and hand over to the existing Claude session. Claude is now the continuing implementation lead. Codex will make no further implementation edits. V2 is NOT complete.

## Location and source status

- Codex branch: `codex/v2-foundation`, worktree `.worktrees/v2-codex`, base `26365c08307e0461c1f657af47cef5e9f1a1f0bf` (PR #76 head).
- ALL Codex work is currently UNCOMMITTED. Branch HEAD alone does not contain it. No push, merge, canonical checkout modification or V1 data migration occurred.
- Read source from this worktree or import the accompanying `codex-handoff-source.tar.gz` into YOUR OWN worktree after reviewing its manifest. Do not modify the Codex worktree. The archive contains only app/go.mod, app/go.sum, app/internal source/tests and docs/v2; no credentials, runtime state or node_modules.
- `app/internal/core/api.go` and `app/internal/agent/agent.go` were copied from Claude's reviewed contract for compilation. Keep your authoritative versions and reconcile changes; these are not competing implementations.

## Delivered work

1. Detailed audit/architecture/gaps/roadmap: `docs/v2/codex-analysis.md`.
2. ADR candidates and reconciliation: `docs/v2/decisions.md`; testable task breakdown: `docs/v2/acceptance-matrix.md`.
3. Native probes and verification ledger: `docs/v2/native-capability-evidence.md`, `docs/v2/verification.md`.
4. Independent Claude analysis review and Codex reconciliation retained under `docs/v2/reviews/`; shared response is `codex-reconciliation.md`.
5. `app/internal/mcp/server.go`: official SDK v1.8.0 stateless JSON HTTP, loopback/exact Host/no Origin, per-request token authentication, bounded concurrency/body/time, five strict tools, safe error mapping, endpoint lifecycle. Consumer-side Core interface only; no SQL.
6. `app/internal/mcp/server_test.go`: official SDK client over in-process HTTP, protocol/list/calls, forged fields, bounds, origin/host/auth, revocation, principal isolation, concurrent requests, error redaction.
7. `app/internal/agent/codex.go` + test: launch argument builder, explicit resume, native config preservation, scoped MCP preapproval, known-token redaction, native identity/terminal evidence, tool failure detection despite zero exit, usage normalization/replay checks.
8. Go module upgraded to 1.25, MCP dependency/sums resolved offline. Reconcile SQLite dependency from your branch with go mod tidy.

## Exact validation completed

- Root `npm run typecheck`: exit 0.
- Frontend typecheck and build: exit 0.
- Baseline desktop Go build using isolated baseline modfile and explicit Go1.25: exit 0. No app launch, Wails packaging or DMG proof.
- `go test ./internal/agent ./internal/mcp`: PASS.
- `go test -race ./internal/mcp`: PASS.
- `go vet ./internal/mcp ./internal/agent`: exit 0.
- Root npm test with explicit Node22 PATH: 1609 tests, 1273 pass, 288 fail, 47 cancelled, 1 skipped (~199s). Numerous local listen EPERM and sandbox_apply EPERM, plus dependent failures. NOT a passing baseline; not every failure individually classified.
- Earlier subprocess PATH picked Node20 (glob/TypeScript failures) and Go1.20 (tidy failed). Pin binaries and PATH. Logs are in Codex worktree `.workdir/v2/evidence/`.
- No inference calls made by Codex. Codex app-server with isolated empty CODEX_HOME successfully initialized, created thread and listed MCP status. Immediate resume before any turn failed “no rollout found”: native ID is not resumability proof.

## INCOMPLETE code / required integration

- Codex adapter has NO Adapter.Run implementation yet; needs your shared RunProcess/CleanEnv helpers. Current CodexArgs puts prompt in argv; prefer adding stdin support to shared launcher. Instructions are also config argv; consider sensitive context handling.
- MCP tests use fake Core and in-process transport, not actual SQLite or sockets. Add `var _ Core = (*core.Service)(nil)` once integrated; real core/SDK/native-client tests are mandatory.
- No desktop binding, trusted provisioning UI, live runtime, dogfood migration, packaging or end-to-end native objective implemented by Codex. Shared bootstrap is still the live collaboration channel.
- Our five-tool boundary is agreed; your corrections acknowledgement and implementation cross-review are still pending. Do not treat this handoff as code approval.

## High-priority source review findings for Claude (snapshot at handoff)

These are based on direct reads of your in-progress core, not final reviewed defects. Resolve before foundation acceptance:

1. **HIGH — revoked principal can still mutate:** SendMessage/insertMessage, ClaimTask and UpdateTask currently trust passed Principal and do not revalidate live turn/token/scope inside the write transaction. Authentication at HTTP admission is insufficient if FinishTurn/recovery revokes it before commit. Add shared transactional principal validation, including expiry and all linked IDs; test Authenticate → revoke → mutation fails, and concurrent revoke/commit serialization. ReadMessages/GetObjective also need stale-scope checks.
2. **HIGH — success derivation:** FinishTurn marks failed for StartErr/NativeError/exit, but not ToolFailures > 0. Adapter returns error for tool failure, but core should not mark a TurnResult with ToolFailures > 0 successful if caller misses StartErr.
3. **MEDIUM — late native ID writes:** RecordNativeSessionID updates session without requiring turn state running; FinishTurn calls it BEFORE transactional terminal-state check. A late callback after interruption can mutate session state. Fence it by live turn and reconcile native ID atomically with finish.
4. **Contract mismatch:** Core added AfterUnread=-1; MCP read input currently rejects all negative cursors (original agreed contract). Decide/advertise -1 as unread and add explicit replay tests, or keep only explicit >=0 cursors. Do not silently diverge.
5. **Resumability:** RecoverInterrupted comment says native sessions stay resumable; my actual zero-turn probe disproves that as a blanket claim. Persist capability/evidence or handle native missing-rollout recovery explicitly.
6. **Usage edge:** Codex uncached=input−cached is proven for observed cache-write=0. Nonzero cache-write overlap semantics are not independently validated; don't claim disjoint totals without checking it. Unknown fields stay nil.

## Reconciled direction / remaining conditions

Accepted one process per turn, per-turn hashed token, participant mail, single-flight/coalesced deterministic wake, Go1.25/SDK1.8.0 and the five tools. See codex-reconciliation.md for full disposition of F1–F14.

- Do NOT use Claude --strict-mcp-config by default: preserve user/native MCP configuration. Detect reserved-server name collision.
- Wake budgets must be explicit objective authorization; default 24 must not authorize inference implicitly.
- Startup must explicitly revoke credentials of interrupted turns; a crash does not invalidate a future expiry by itself.
- Native tools remain intact; headless editing permissions and compaction survival remain M2 gates.
- Preserve user changes in canonical checkout, V1 history/data, Studio port 4111, other worktrees/processes. No master merge without human approval.

## Suggested next steps

1. Read this handoff and reconciliation; fix transactional authorization and terminal-state issues in your own core.
2. Import/review Codex source snapshot in your worktree or create integration worktree under canonical .worktrees; retain provenance and commit changes without squash when integrating actual branches. No branch merge can import currently uncommitted files.
3. Finish shared launcher and Codex Run wrapper, resolve cursor contract, add core-backed adversarial MCP tests and race tests.
4. Validate actual native clients over authenticated loopback; provision explicit scope/context/usage; then move collaboration to V2. Generic SDK tests are not native dogfooding.
5. Continue desktop, verification and DMG roadmap; report unresolved gates honestly. User asked to transfer leadership, not declare completion.

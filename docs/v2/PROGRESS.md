# Agentic Engineering V2 — Progress Report

- **Author:** Claude Code (Opus 5.5), current implementation lead after Codex's handoff (2026-11-26 16:13 UTC).
- **Written:** 2026-11-26, about 17:00 UTC.
- **Status:** consolidation checkpoint. Implementation and investigation are **paused at the Director's request**,
  pending approval.
- **Audience:** the Engineering Director, and any agent resuming the work.

This report distinguishes four kinds of evidence:
- **Verified**: run here, with its output inspected.
- **Advertised**: from CLI help, schema or documentation, not exercised.
- **Historical**: V1 records, not re-run.
- **Environment-blocked**: could not run in the environment that tried it.

Nothing below claims V2 works end to end. **No native agent has yet collaborated through the V2 application itself.**

## 1. Where the code is

| Item | Value |
| --- | --- |
| PR | #76 `feat/v2-desktop-app` (draft). The integration of this checkpoint is pushed there as a merge commit. |
| PR #76 head before integration | `75a45de` (UI refactor plus native CLI discovery). Then `7dae341` (Codex stderr auth detection, harness test console, native chat page), pushed during integration and merged in `28bf6dd`. All PR commits are preserved. |
| Consolidated V2 backend branch | `v2/m1-integration` = `claude/v2-core` (fast-forwarded) at `549a4c3` |
| Claude commits | `52cddde` storage, core, evidence and review; `f1481ed` launcher, live-turn fencing, fixture |
| Codex commit | `6cc2ec8`: an import of Codex's **uncommitted** worktree, byte-verified against its handoff manifest (16 files, archive sha256 `c7f0b45e…2c7f59`). Codex's worktree was not modified and still holds its uncommitted files. |
| Merges | `e698a88` (claude/v2-core), `549a4c3` (codex import, conflicts resolved and explained in the message), then the PR #76 integration merge |
| Worktrees (all kept) | `.worktrees/v2-claude`, `.worktrees/v2-codex` (Codex, untouched), `.worktrees/v2-codex-import`, `.worktrees/v2-m1`, `.worktrees/v2-pr76` |
| Canonical checkout | Not modified. It holds the Director's uncommitted Wails build artifacts and a running app. |

Repository rules respected: no master merge, no force-push, no deleted worktrees, no discarded changes, no global CLI
configuration changes, and V1 source and data untouched.

## 2. Architecture as built

One Go process: the Wails UI, the core, SQLite and an embedded MCP endpoint. Native CLIs run as separate processes,
**one process per turn**. Continuity between turns is the native session id, so no child process outlives its turn.

```
Wails UI ──bindings──▶ app (AgentConnection → agentdiscovery)        [PR #76]
                       core.Service ◀── direct calls ── mcp handler  [V2 backend]
                          │                  ▲ bearer (per turn)
                          ▼                  │ Streamable HTTP, stateless JSON, 127.0.0.1:<ephemeral>
                       storage (SQLite)    claude -p / codex exec   ◀── agent.RunProcess (clean env, own pgid)
```

| Package | Owner | State | Purpose |
| --- | --- | --- | --- |
| `internal/storage` | Claude | done (M1 scope) | modernc SQLite (pure Go), WAL, foreign keys, `BEGIN IMMEDIATE`, embedded forward-only migrations, refuses a newer schema, `VACUUM INTO` snapshot before migrating |
| `internal/core` | Claude | done (M1 scope) | Projects, objectives, participants. Messages: durable sequence, read cursor, idempotency. Tasks: CAS claims, owner updates, trusted verdicts. Turns: DB-enforced single flight, per-turn hashed tokens, opt-in wake budget, usage rows, crash recovery. |
| `internal/core/coretest` | Claude | done | Exported fixture for end-to-end tests |
| `internal/mcp` | Codex | done, with open findings | Official Go MCP SDK v1.8.0. Stateless JSON. Exact Host, Origin refused, auth before protocol, bounded body, concurrency and time. Five tools. Error redaction. |
| `internal/agent` (contract, launcher) | Claude | done | `Adapter` contract; `CleanEnv` (allowlist plus resolved PATH); `RunProcess` (stdin prompt, process group, SIGINT then SIGKILL, bounded lines) |
| `internal/agent/codex.go` | Codex | **partial** | Argument builder and stream parser done; `Run` not implemented |
| `internal/agent/claude.go` | Claude | **not started** | |
| `internal/agentdiscovery`, `app/agent_connection.go` | PR #76 | present | Binary discovery, version and login probe, exposed to the UI |
| Wake coordinator, turn runner, desktop bindings to core | — | **not started** | |

Agent tools (MCP): `send_message`, `read_messages`, `get_objective`, `claim_task`, `update_task`. Agents can never
mint sessions, grant permissions, or set a task `accepted` or `rejected`. Only the trusted core API
(`SetTaskVerdict`) does that, after independent verification. This is the **human acceptance boundary**.

## 3. Milestones

| Milestone | Status | Evidence / what is missing |
| --- | --- | --- |
| M0 Discovery and review | **Done** | Codex analysis, Claude independent review (F1–F14), reconciliation, ADR candidates (`decisions.md`), acceptance matrix |
| M1 Collaboration vertical slice | **~55%** | Storage, core, MCP and launcher are done and tested. **Missing:** Claude adapter, Codex `Run`, turn runner, a core-backed MCP test over a real socket, live two-agent run through V2, dogfood migration off the bootstrap directory |
| M2 Collaborative engineering | Not started | Gated on F4 (headless permissions), compaction survival, live cancellation |
| M3 Desktop integration | Not started | PR #76 UI and discovery exist; no bindings to core yet; UI data is still demo |
| M4 Distribution and dogfooding | Not started | No `wails build`/DMG evidence from this checkpoint (§5) |

Acceptance-matrix rows (`acceptance-matrix.md`):
- **Passed by unit or integration test:** F01–F05.
- **Passed against a fake core only:** F06–F07. Real-core and real-socket tests are pending.
- **Not done:** F08–F10.
- **Partial:** N01–N05 (launcher only).
- **Not started:** V, U, D, E.

## 4. Verified native capabilities

Full tables are in `claude-native-evidence.md` (E1–E11, Claude) and `native-capability-evidence.md` (Codex). Probes
used Haiku and low-effort Codex. The provider-reported API-equivalent estimate was well under $0.10 in total.

| Capability | Claude Code 2.1.332 | Codex 0.161.0 | Kind |
| --- | --- | --- | --- |
| Local Streamable HTTP MCP with bearer token from environment | yes (`headers` + `${AE_TOKEN}`) | yes (`bearer_token_env_var`) | Verified |
| Stateless + JSONResponse server | yes (2.1.332 and 2.1.59; 2.1.59 tolerates a 405 on GET) | yes | Verified |
| Headless MCP tool calls | needs `--allowedTools mcp__<server>__*` | **refused by default and exits 0**; needs `mcp_servers.<name>.default_tools_approval_mode="approve"` | Verified |
| Wake an idle session with a new turn | `-p --resume <id> "<msg>"`, same id | `exec … resume <id> "<msg>"`, same thread id | Verified |
| MCP config persists across resume | **no**; must be re-passed every turn | per invocation | Verified |
| Role bootstrap persists across resume | yes (`--append-system-prompt`; secret never printed) | yes (`developer_instructions`) | Verified |
| Native login with a clean `env -i` launchd PATH | yes (keychain, `apiKeySource: none`) | yes (native binary) | Verified |
| npm Codex shim under launchd PATH | n/a | **fails**: `env: node: No such file or directory` | Verified |
| Parent harness env leaks to children | yes: `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_TOKEN`, … | — | Verified (fixed by `CleanEnv`) |
| Resume of a thread with zero turns | — | fails, "no rollout found" | Verified (Codex, app-server) |
| Options placed before `resume` | — | parse; after `resume` they are rejected | Verified (no inference) |
| Sandbox and cwd applied to a resumed thread | — | unknown | Not tested |
| Context survival after compaction | unknown | unknown | Not tested |
| Unattended Bash/edit permissions in headless mode | unknown | `workspace-write` is advertised (network off) | Advertised / open (F4) |
| Codex app-server (approvals, interrupt, token notifications) | — | initialize, thread/start and mcpServerStatus/list succeed with isolated home | Verified no-inference; turns untested |

### Usage semantics (verified from raw streams)

- **Claude:**
  - `input_tokens` excludes cache tokens.
  - **The invocation total is `result.modelUsage[model]`, not `result.usage`.** In one run `result.usage.output_tokens`
    was 182 while `modelUsage.outputTokens` was 452 and `cacheReadInputTokens` was 201,441 versus 101,693.
  - `modelUsage` reconciles with `total_cost_usd` and includes API calls absent from `result.usage`.
  - `total_cost_usd` is an API-equivalent estimate. Under subscription login it is not a bill.
- **Codex:**
  - `input_tokens` **includes** `cached_input_tokens`, so uncached input = input − cached.
  - This is proven only for `cache_write_input_tokens = 0`.
  - No cost is reported.
- **Native context floor on a trivial turn:**
  - Claude: about 33k tokens.
  - Codex: about 55–63k tokens.
  - A wake re-reads the whole history (cached): Claude about 100k cache reads, Codex 63.7k → 90.3k input.
  - So wakes must be batched and coalesced, never one per message.

## 5. Quality gates on the integrated tree (this checkpoint)

Run in `.worktrees/v2-pr76` on the PR #76 head merged with `claude/v2-core`, darwin/arm64, 2026-11-26.

| Gate | Command | Result |
| --- | --- | --- |
| Go toolchain | `GOTOOLCHAIN=local go version` | go1.25.10 |
| gofmt (V2 packages) | `gofmt -l internal/{core,storage,agent,mcp}` | clean |
| gofmt (PR #76 Go files) | `gofmt -l internal/agentdiscovery *.go` | 4 files unformatted; left unchanged (debt T1) |
| Go build | `go build ./...` | pass |
| Go vet | `go vet ./...` | pass |
| Go tests | `go test -race -count=1 ./...` | pass: core 14, storage 3, agent 15, mcp 6, agentdiscovery 3 test functions |
| Frontend | `npm install && npm run typecheck && npm run build` in `app/frontend` | pass (vite 6; dist 25 kB JS) |
| Root typecheck | `npm ci && npm run typecheck` | pass |
| Root V1 tests | `npm test` | partial, not awaited by the Director's decision; see §5.1 |
| `wails build` / app launch / DMG | — | **not run at this checkpoint** |

### 5.1 Root V1 test suite

**Not awaited to completion, by the Engineering Director's decision** ("V1 is code to be discarded; push"). At push
time (2026-11-26 16:35 UTC) `npm test` had run for 14 min 26 s: 630 top-level test files reported `ok`, 0
`not ok`, and no suite summary yet. This is a partial result, not a pass. The merge changes no file outside
`app/` and `docs/v2/`, so V1 source is byte-identical to the PR #76 head.

Historical, for comparison: inside Codex's sandbox the same suite reported 1609 tests (1273 pass, 288 fail,
47 cancelled, 1 skip). Codex attributes most failures to loopback-listen and nested-sandbox EPERM
(environment-blocked). They were not individually triaged.

## 6. Review findings still open

The full reviews are in `claude-review.md` (F1–F14), `.workdir/v2-bootstrap/claude-code-review-1.md` (C1–C7), and
the Codex handoff findings (H1–H6). Resolved items: F1, F3, F5, F8, F10, F12 by design or code; H1 by `f1481ed`,
in-transaction live-turn check.

| ID | Severity | Area | Open finding | Planned fix |
| --- | --- | --- | --- | --- |
| C1 | High | Codex adapter | Any failed item, including a red `command_execution`, counts as a tool failure and fails the turn | Count only failed `agentic_engineering` MCP calls; treat an approval refusal as a native error; `Run` errors only when there is no usable result |
| H3 | Medium | core | `RecordNativeSessionID` is not fenced by a running turn, and `FinishTurn` records the id before its terminal-state check | Fence it, and move the id into the finish transaction |
| H5 | Medium | runner | A missing native session ("no rollout found" / no Claude transcript) is not handled | Detect it, then fail the session, start a new one with bootstrap and a focused handoff (once) |
| C2/H4 | Medium | MCP contract | MCP rejects `after < 0`, but core offers `AfterUnread`; omitting `after` rereads all history | `after` becomes optional; absent means unread; explicit replay still works; add tests |
| C3 | Medium | MCP errors | CAS detail ("revision is 4") is stripped | Core returns an explicit `PublicError` for agent-safe detail; everything else stays redacted (keeps Codex's redaction test) |
| C4 | Medium | Codex adapter | Non-fatal `error` events become a generic failure and lose their message | Keep a redacted, truncated message; only `turn.failed` is fatal |
| H6 | Medium | usage | Codex uncached = input − cached is unproven when cache writes are nonzero | Store uncached as unknown when `cache_write > 0` |
| H2 | Low | core | A turn with collaboration-tool failures is recorded `succeeded` | Decided: keep the failure count; the C1 approval-refusal path marks it failed |
| N1 | Medium | core | `requireLiveTurn` does not re-check token expiry; `GetObjective` has no stale check | Add both |
| N2 | Medium | Claude usage | The adapter must use `modelUsage` (per model) for totals | Implement in `claude.go` |
| F4 | High, decision | permissions | Headless native permission model for edits and Bash | Experiment first (Claude `acceptEdits` plus native sandbox settings; Codex `workspace-write`, network off); then a Director decision (§8) |
| F9 | Medium | context | Compaction survival is unproven | Experiment before M2 |
| C5 | Medium | Codex | Sandbox and cwd on resumed threads are unproven | Live test in the first two-agent run |

## 7. Technical debt

1. T1: PR #76 Go files are not gofmt-formatted.
2. T2: Two candidate-path lists exist (`agentdiscovery.candidates`, `agent.ResolvedPATH`); converge them on one.
3. T3: `agentdiscovery.probe` runs with the full inherited environment (E10) and picks the first `LookPath` hit. In a
   GUI app that is Homebrew's stale Claude 2.1.59 while 2.1.332 is installed. It records no realpath. The launcher
   should take its `Binary` from discovery, which must record realpath and version.
4. T4: `go mod tidy` without `GOTOOLCHAIN=local` silently downloaded go1.26.0 earlier. Build scripts must pin it, or
   `go.mod` should get a `toolchain` line.
5. T5: `app/frontend` has no committed lockfile, and `tsconfig` has `strict: false`.
6. T6: The UI renders demo data only, from localStorage. It must stay visibly separate from real execution data.
7. T7: Docs overlap: `claude-review.md` and `reviews/claude-analysis-review.md` both exist (kept for provenance).
   `decisions.md` needs a consolidated ADR pass after the M1 run.
8. T8: Raw native streams are planned as per-turn log files (`turns.log_path`), but no writer exists yet. Retention
   and redaction are undefined.
9. T9: The bootstrap directory is still the live coordination channel. Codex is stopped, so no MCP dogfooding has
   happened.

## 8. Blockers and decisions that need the Director

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Headless permission policy for app-launched agents (F4) | Native-only mechanisms, scoped to the session's worktree. Codex `workspace-write` with no network by default. Claude permission mode chosen after the experiment. Never bypass flags. |
| D2 | Default automatic wake budget | 0 (disabled) is implemented. The Director sets a budget per objective. |
| D3 | Packaged data directory | Dev: `<worktree>/.workdir/v2/`. Packaged: `~/Library/Application Support/Agentic Engineering/`. `AE_DATA_DIR` overrides. |
| D4 | Which Claude binary the app uses when several exist | Show all; default to the newest version; allow an explicit choice. |
| D5 | Signing, notarization and update channel | Open (charter §12); not needed until M4 |

None of these blocks finishing M1's message slice except D2, which is already conservatively defaulted.

## 9. Recommended next steps (in order, after approval)

1. Fix C1, H3, C2/H4, C3, C4, H6 and N1, each with a test. These are small and local to existing files.
2. Implement `claude.go` (stream-json parsing with `modelUsage`) and Codex `Run` on `RunProcess` with stdin prompts.
   Add a minimal turn runner in core: `BeginTurn` → `Adapter.Run` → log file → `FinishTurn`, with missing-session
   fallback (H5).
3. Add a core-backed MCP test over a real loopback socket (`mcp.Start` + `coretest`), plus `var _ Core = (*core.Service)(nil)`.
4. Run the first **live two-agent exchange through V2** (gated by `AE_LIVE=1`, Haiku / low effort, run by Claude):
   - Claude and Codex read the objective.
   - Each claims a different task.
   - They exchange a message, with usage recorded.
   - Then restart, recover, and resume; this also covers C5.
   This is the M1 exit evidence.
5. Wake coordinator: single flight, coalescing, notice-only prompts, opt-in budget. Then the F4 and compaction
   experiments.
6. Migrate collaboration from `.workdir/v2-bootstrap/` to V2 MCP (dogfooding); retire the bootstrap directory.
7. M3: Wails bindings from the existing PR #76 pages to core (projects, objectives, collaboration, sessions, usage),
   replacing demo data page by page. Reuse `agentdiscovery` for Settings and the launcher.
8. M4: `wails build`, a clean-user launch on Apple Silicon, the DMG, and an upgrade that preserves the database.

## 10. Coordination state

- Codex stopped at 16:13 UTC and handed implementation ownership to Claude (`.workdir/v2-bootstrap/codex-handoff.md`).
- Codex's raw evidence stays in its worktree's gitignored `.workdir/v2/evidence/` (schema, initialize and thread
  probes, build and test logs). It was not copied or deleted.
- Claude's probe server and its logs live in the session scratchpad and are not durable. The conclusions are recorded
  in `claude-native-evidence.md`.

# Independent review of Codex V2 analysis

Author: Claude Code (Opus 5.5). Written 2026-11-26 ~16:05 UTC.

- **Reviewed:** `.worktrees/v2-codex/docs/v2/codex-analysis.md` (83 lines, read in full) and
  `.workdir/v2-bootstrap/codex-interface-notes.md`.
- **Base:** PR #76 head `26365c0`.
- **Evidence:** my own experiments in [claude-native-evidence.md](claude-native-evidence.md), cited below as E1–E11.
  I also inspected `app/` at the PR head in full and the V2 charter in full. The V1 audit is Codex's; I did not
  repeat it. Its retain/replace/retire table matches what I sampled (`codex.ts` worker restrictions, Mastra
  exclusion) and I accept it.

## Verdict

The analysis is sound on security boundaries, idempotency, revision-checked claims, usage honesty and V1
disposition. I agree with the core-only MCP boundary, per-session bearer tokens checked before protocol handling,
identity never taken from tool arguments, and the five-tool M1 set.

It has four gaps that would make M1 fail or grow complex:
1. Headless Codex silently blocks MCP tools (F1).
2. There is no concrete wake design (F2).
3. The lifecycle is heavier than the evidence requires (F3).
4. The headless permission model is unresolved (F4).

## Findings

| ID | Severity | Finding | Evidence | Recommended correction |
| --- | --- | --- | --- | --- |
| F1 | **High** | Headless Codex refuses every MCP tool call by default and still exits 0. The report does not mention it, so M1 collaboration would fail silently. | E5: `"MCP tool call requires approval, but approval policy is never"`, exit 0. E6: passes with the fix. | Launcher passes `-c mcp_servers.<ae>.default_tools_approval_mode="approve"` (our server only; native approvals untouched). Claude equivalent: `--allowedTools mcp__ae__*` (our tools only; native tools untouched). Turn success comes from structured item status, never from exit code. |
| F2 | **High** | "MCP alone cannot wake an idle agent" is correct, but no mechanism is proposed. A working one is proven. | E3 and E7: `claude -p --resume <id> "<prompt>"` and `codex exec resume <id> "<prompt>"` keep native identity and run a new turn. Each wake re-reads the full history (Claude about 100k cached; Codex 63.7k → 90.3k input). | Deterministic wake coordinator in core, no inference. **Single-flight per participant**: concurrent resume of one native session is never allowed. **Coalesce** messages that arrive while a turn runs into one follow-up turn. The wake prompt carries only a notice ("N unread messages; call `read_messages`"), never message bodies; bodies arrive as tool data. Never wake an author for its own message. A **per-objective wake budget**; when exhausted, escalate to the human. That budget prevents agent ping-pong loops. |
| F3 | **High** (complexity) | The 8-state session lifecycle and an app-server evaluation for M1 both assume long-lived child processes. The evidence supports a much simpler model. | E3, E4, E7: native session persistence carries continuity across separate processes. | **One process per turn.** Between turns no process exists; continuity is the native session id. Session states: `active`, `closed`, `failed`. Turn states: `running`, `succeeded`, `failed`, `interrupted`. Desktop quit cancels only in-flight turns. Crash recovery marks a turn still `running` as `interrupted`; the next wake resumes the native session. No PID reattachment is ever needed. Codex app-server stays a later option, adopted only if interactive approvals require it (F4). Both CLIs use their symmetric `-p`/`exec --json` path in M1. |
| F4 | **High** (consequential) | In headless mode nobody can answer a native permission prompt. Codex: `--sandbox workspace-write` is native and sufficient. Claude `-p` denies non-allowed tools, so Bash and edits need a launch-time decision. "No fixed tool allowlists" forbids the easy hack. | Not tested; listed as open in the evidence file. | Prefer native mechanisms. Candidate: Claude `--permission-mode acceptEdits` plus native sandbox settings via `--settings` (sandboxed Bash auto-allowed), scoped to the session's worktree. **Experiment before M2.** If no native mechanism yields safe unattended Bash, escalate to the human: options, recommendation and evidence. Not needed for the M1 message slice. |
| F5 | Medium-High | The report does not specify the child environment. A child of any agent or IDE process inherits that harness's session identity and messaging credentials. | E10: inherited `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDECODE`; UA changed `claude-vscode` → `sdk-cli` under `env -i`. E8: native keychain login works with a clean env. | Build the child env from an **allowlist**: `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`/`LC_*`, `SHELL`, `TERM`, a resolved `PATH`, plus `AE_TOKEN`. User-configured additions are explicit. Unit-test that `CLAUDE*`, `CODEX_*`, `VSCODE_*` and `*_TOKEN` are stripped. |
| F6 | Medium | Binary discovery: the GUI launchd PATH breaks the npm Codex shim, and the Homebrew Claude cask is stale. | E9: `env: node: No such file or directory`. `/opt/homebrew/bin/claude` → 2.1.59 while 2.1.332 is installed elsewhere. The same probe estimated 10× the cost on 2.1.59 (cause unverified). | Resolve symlinks. For the Codex npm shim, resolve the vendored native binary rather than requiring Node. Record realpath and `--version` per session. Show every candidate in Settings, and allow explicit selection. Do not use IDE-extension binaries implicitly (they are user-visible but owned by the IDE); list them only. |
| F7 | Medium | Usage semantics differ in a way that double counts if normalized naively. The report states the principle but not these facts. | Claude `input_tokens` **excludes** cache (6 vs `cache_read` 66,393). Codex `input_tokens` **includes** cached (63,701 includes 55,552). Claude `total_cost_usd` is an API-equivalent estimate under subscription auth. Claude `assistant` events repeat per-message usage that `result` already aggregates. | Normalized fields: `uncached_input`, `cache_read`, `cache_write`, `output`, `reasoning` (nullable), with `normalization_version`. For Codex: `uncached = input − cached`. Take Claude usage from `result` only. Store `cost_usd_estimate` with `cost_kind = provider_reported_api_equivalent`; never label it billed. Codex cost stays null (unknown). |
| F8 | Medium | Credential lifetime: "restart invalidates credentials unless reprovisioned" adds a reprovisioning path. The evidence makes it unnecessary. | E2: Claude MCP config is not persisted across resume (global servers load instead). Codex config is per invocation. Both must be re-passed every turn anyway. | **Mint a fresh token per turn** (stored hashed; revoked at turn end or on cancel). Restart then needs no special credential logic: any token from before the crash is simply expired. The config is re-passed every turn with `--strict-mcp-config` on Claude. Codex has no strict mode, so user-global servers load too (acceptable under native-first; our isolation rests on the token, not on config). |
| F9 | Medium | Role bootstrap persistence is proven for resume, and the report's "resume with a focused delta" can drop re-injection. | E4 (`HERON-42`) and E7 (`OSPREY-9`) recalled after resume without re-injection. | Inject full fundamentals **once**, at session creation (`--append-system-prompt` / `developer_instructions`); store text, digest and version. Resume sends only the delta. **Compaction survival remains untested** and is required before M2 exit. |
| F10 | Medium | Transport: stateless plus JSONResponse is confirmed for all three installed clients. | E8. | Agree with Codex. Adopt it. Tolerate the GET from Claude 2.1.59 (the SDK returns 405 itself). |
| F11 | Medium | Codex's "local `claude auth status` reports no login in this sandbox" reflects the Codex sandbox's view, not the user's state. | E1–E8: Claude headless runs authenticate via keychain. | Capability discovery must run from the app process (outside any agent sandbox). Never record "not logged in" from a sandboxed probe. Report "unknown" when a check cannot run. |
| F12 | Low-Medium | Address messages by session, and a replacement attempt (new session after failure) loses its mail. | Design gap. | Address messages to a **participant** (objective × agent × role). Sessions are attempts of a participant. `read_messages` advances a per-participant `read_seq` (meaning fetched, not acted upon). No separate ack tool in M1; this satisfies Codex's "fetched ≠ acknowledged" note by documentation and cursor. |
| F13 | Low | The data root is unresolved. | AGENTS.md: runtime state belongs in `.workdir/`. Packaged apps cannot write inside a repository. | `AE_DATA_DIR` override. Dev default: `<worktree>/.workdir/v2/`. Packaged default: `~/Library/Application Support/Agentic Engineering/`. Same code path. Record as an ADR. |
| F14 | Low | PR #76 does not build from a clean checkout. | No `go.sum`; `go 1.23` while MCP SDK v1.8.0 needs Go ≥1.25; frontend `strict: false`; all state is demo data in localStorage (`agentic-v2-app-demo`). | Bump to `go 1.25` once, in the integration change. Keep the demo seed behind an explicit demo flag, never mixed with real state (agrees with Codex's table). |

## Points where I disagree with the report

- **Codex app-server for M1** → no (F3). One symmetric per-turn model for both CLIs. Revisit only for F4.
- **"Restart invalidates credentials unless explicitly reprovisioned"** → per-turn tokens make this automatic (F8).
- **Separate ack tool** → not in M1. A cursor plus documentation is enough (F12).
- **8 lifecycle states** → 3 session states plus 4 turn states (F3).

## Ownership proposal (amends Codex's)

- **Claude:**
  - `internal/storage`: SQLite via `modernc.org/sqlite` (pure Go, no extra cgo surface), migrations, WAL, busy
    timeout.
  - `internal/core`: domain, `Authenticate`, messages, tasks, objectives, per-turn tokens, the wake coordinator and
    the usage ledger.
  - `internal/agent`: the shared launcher (env allowlist, binary discovery, process-group cancellation) and
    `claude.go` (stream-json parsing, usage).
- **Codex:**
  - `internal/mcp`: SDK handler, auth before protocol, Host/Origin checks, bounded tools, error redaction.
  - `internal/agent/codex.go`: `exec --json` parsing, resume, usage, approval config.
- **Rationale:** each agent adapts its own CLI.
- **Joint:**
  - `go.mod` reconciliation, in one reviewed change.
  - The live two-agent integration test (gated by `AE_LIVE=1`; it spends a small amount of model quota and is never
    in default `go test`).
  - ADRs under `docs/v2/adr/`.
- **The interface I propose freezing** is in `claude-interface-proposal.md`, and as compilable Go on branch
  `claude/v2-core` (`app/internal/core/api.go`, `app/internal/agent/agent.go`) once pushed to the worktree.

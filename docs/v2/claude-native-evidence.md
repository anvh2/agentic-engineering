# Native CLI capability evidence (Claude, independent)

Author: Claude Code (Opus 5.5). Collected 2026-11-26 15:56–16:01 UTC on darwin/arm64, Go 1.25.10.
Base revision: PR #76 head `26365c08307e0461c1f657af47cef5e9f1a1f0bf`. Experiments ran in a session scratch
directory, outside every repository; no global CLI configuration was changed.

## Setup

- Probe server: ~110 lines of Go on the official MCP Go SDK `v1.8.0`. It serves Streamable HTTP on `127.0.0.1:47911`
  (stateful default) and `127.0.0.1:47912` (`Stateless: true, JSONResponse: true`), using
  `auth.RequireBearerToken` with a token→scope map. The tools are `whoami` (returns the scope the token resolved to)
  and `send_message`. Every HTTP request and tool call is logged to JSONL.
- Binaries:
  - Claude 2.1.332 (VS Code native binary)
  - Claude 2.1.59 (`/opt/homebrew/bin/claude` → Homebrew cask)
  - Codex 0.161.0 (`/opt/homebrew/bin/codex`, a Node shim, and its vendored native binary under
    `@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`)
- Models: Claude `--model haiku` (resolved `claude-haiku-5-5`) and Codex default model with
  `model_reasoning_effort="low"`. Measured provider-reported estimates were about $0.003–$0.03 per Claude turn.

## Results

| # | Experiment | Result |
| --- | --- | --- |
| E1 | Claude 2.1.332, `--mcp-config` file with `"headers":{"Authorization":"Bearer ${AE_TOKEN}"}`, `--strict-mcp-config`, `--allowedTools mcp__ae__whoami mcp__ae__send_message`, `--session-id <uuid>`, `--append-system-prompt <role>` | PASS. `init.mcp_servers=[ae connected]`. Server resolved scope `session-claude`, and both tool calls were recorded. The native session id equals the `--session-id` passed. The token came from the environment, not argv. |
| E2 | Claude `--resume <id>` with no `--mcp-config` | The session resumed, but the user's global MCP server (`claude-artifacts`) loaded and `ae` did not. **The MCP config does not persist across resume.** |
| E3 | Claude wake: `--resume <id>` plus `--mcp-config` plus a new prompt | PASS. Same session id, tool called. Usage was `cache_read 101693`, `cache_creation 540`, `out 182`, about $0.0092. **Each wake re-reads the whole history** (cached). |
| E4 | Clean role test: `--append-system-prompt` holding a codeword that is never output; resume **without** re-passing it | Codeword recalled (`HERON-42`). **The appended system prompt persists across resume.** Re-passing it also works. Duplication cost was not measured. |
| E5 | Codex `exec --json`, `-c mcp_servers.ae.url=…`, `-c mcp_servers.ae.bearer_token_env_var="AE_TOKEN"` | Connected with bearer auth (UA `codex-mcp-client/0.161.0`), but **every MCP tool call failed: "MCP tool call requires approval, but approval policy is never"**. The process still **exited 0**. |
| E6 | E5 plus `-c mcp_servers.ae.default_tools_approval_mode="approve"` | PASS. Scope `session-codex`, both tools completed. Auto-approval applies to this server only. |
| E7 | `codex exec resume <thread_id>` with no `developer_instructions` and no MCP config | `developer_instructions` codeword recalled (`OSPREY-9`); same `thread_id`. Input grew from 63,706 to 90,341 tokens (76,800 cached). |
| E8 | Stateless + JSONResponse server; all three clients under `env -i` with launchd's default PATH `/usr/bin:/bin:/usr/sbin:/sbin` | PASS for Claude 2.1.332, Claude 2.1.59 and the Codex native binary. Claude 2.1.59 issues one GET (405) and continues. Native login worked without inherited environment (`apiKeySource: none`, keychain). |
| E9 | `/opt/homebrew/bin/codex --version` under launchd's PATH | **FAIL: `env: node: No such file or directory`.** The npm shim needs Node on PATH; the vendored native binary does not. |
| E10 | Environment inherited by a child of an agent session | Child received `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT` and `VSCODE_*`. With inherited env the UA was `claude-code/2.1.332 (claude-vscode, …)`; under `env -i` it was `(sdk-cli)`. The inherited env changes child identity and leaks the parent's messaging credentials. |
| E11 | Unauthenticated POST | `401` from the SDK bearer middleware before any MCP handling. |

## Usage semantics observed (raw, not normalized)

- **Claude `result.usage`** for one `-p` invocation: `input_tokens 6`, `cache_creation_input_tokens 33355`,
  `cache_read_input_tokens 66393`, `output_tokens 127`.
  - `input_tokens` **excludes** cache tokens.
  - `modelUsage[model]` carries a per-model split and `costUSD`.
  - `total_cost_usd` is a client-side API-equivalent **estimate**; under subscription auth (`apiKeySource none`) it is
    not a bill.
  - Per-message usage also appears on `assistant` events. Summing those together with `result` would double count.
- **Codex `turn.completed.usage`**: `input_tokens 63701`, `cached_input_tokens 55552`, `cache_write_input_tokens 0`,
  `output_tokens 124`, `reasoning_output_tokens 0`.
  - `input_tokens` **includes** cached tokens.
  - No cost field is reported.
- **Native context floor on a trivial turn**: Claude created about 33k cached tokens; Codex used about 55–63k input
  tokens. A 2.7–6.5k-token bootstrap is therefore roughly 5–15% overhead on the first turn.
- The same probe cost $0.0318 on 2.1.59 and $0.0031 on 2.1.332. The cause is unverified; the `haiku` alias may
  resolve differently across versions.

## Not yet tested

- Context survival after native compaction, on either CLI.
- Interactive approvals in headless mode beyond our own MCP tools: Claude Bash under `-p`, and Codex
  `workspace-write` with a real repository edit.
- Cancellation (SIGINT/SIGTERM to the process group) mid-turn, and transcript integrity after it.
- Two concurrent resumes of one native session.
- The Codex app-server protocol (Codex reports that it generated the schema; there is no end-to-end run).

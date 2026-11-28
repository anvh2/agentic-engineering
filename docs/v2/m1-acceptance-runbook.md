# M1 collaboration acceptance runbook (Issue #78)

Author: ChatGPT / GPT-6, 2026-11-28 UTC. Status: **implementation candidate awaiting native macOS acceptance**. The CI result must be recorded at the exact commit; mock and socket tests are not proof of two authenticated native model turns.

## Baseline and invariants

- Base: merged PR #77. Candidate: PR #79 `feat/v2-agent-runtime`.
- Engineering knowledge: local `engineering-knowledge` pack **1.0.0**. Approved rule-level decisions remain binding; documents explicitly marked `draft` are not silently promoted.
- Desktop: Wails v2, Go 1.25, Node 22. MCP binds randomly allocated IPv4 loopback port and requires per-turn bearer tokens; credentials must never be committed, passed in argv, or recorded in evidence files.
- Native permissions stay enabled. Do not pass `--dangerously-skip-permissions`, alter global CLI config, or disable approvals. No existing processes are terminated and worktrees are preserved for inspection.
- Work > **M1 Runtime** is backed by the SQLite core, unlike historical demo cards. Insight pages show a distinct *Live M1* section, not fabricated history.
- Agent submission is not independent verification, review, or Director acceptance.

## CI / local verification

Run from checkout at the exact reviewed PR head:

```bash
cd app/frontend
npm ci
npm run typecheck
npm run build
cd ..
go version
go vet ./...
go test -race ./...
go build ./...
wails dev
```

Record command, exit status, commit SHA and log path. When CI has not completed, report `pending`, never `passed`. Local native launch requires authenticated Claude and Codex with their native login; `discovery.Scan` verifies login before execution. The Go CI checks do **not** prove Wails DMG packaging.

## Live acceptance matrix

**Run A — Codex Developer → Claude Reviewer**

1. In Work > M1 Runtime, select an isolated *test repository root* with no unrelated uncommitted changes. Create a new objective with explicit acceptance criteria and task list. Set Developer **Codex**, Reviewer **Claude**; set a small bounded wake budget (for example 2). Select local engineering-knowledge v1.0.0.
2. Start the Codex Developer turn: ask it to read `get_objective`, claim the implementation task, make a small verifiable code edit in *its own worktree*, run applicable tests, submit the task with actual command/exit evidence, and `send_message` to Claude Reviewer.
3. Start Claude Reviewer manually if it has not yet established a session. Reviewer reads MCP messages and objective, inspects the developer worktree **read-only**, checks the patch and tests, then communicates findings by `send_message`. Reviewer cannot claim independent verification that did not occur or update the developer's owned task.
4. When a revision is needed, the Director sends feedback or rejects a submitted task; Developer performs a new turn with corrections and renewed test evidence. Observe durable messages, revision increments, native session continuity, event JSONL, Git patch/status digest and usage on Insights.
5. Enter **actual** test/build result and **actual** independent reviewer evidence; explicitly accept (or reject) as Director. Verify accepted status is not set merely because an agent requested acceptance.

**Run B — Claude Developer → Codex Reviewer**

Repeat with a new objective and reversed roles. Confirm MCP tools actually succeed (not merely provider process exit 0), native login is authenticated for both, the reviewer cannot change the developer worktree, and messages remain scoped to this objective.

**Failure and recovery**

- Missing/unauthed provider: execution refuses to start; no fabricated success.
- Cancel in-flight turn: only its owned process group is interrupted; token revoked; state `interrupted` (not accepted).
- Restart app during an in-flight turn: `RecoverInterrupted` marks unfinished turns interrupted; revoked token remains unauthorized. Do not retry uncertain side effects automatically.
- Explicit concurrent turn of same participant: rejected without racing native session.
- MCP without bearer, forged host/origin or wrong objective: refused; confirmed via real socket integration tests; verify native clients' actual authenticated MCP calls in live logs.
- Automatic wake: never exceeds configured SQLite wake budget; disabled when budget zero; no cross-objective delivery or model polling. Bootstrap each agent once manually before wakes can resume it.
- Observe failure handling when native events are invalid or incomplete, rate/port failure, nonzero exit, and Git evidence unavailable.

## Evidence report template

- Commit SHA / CI run URL / `go vet`, `go test -race`, `go build` / frontend build result:
- macOS version / architecture / Wails build result:
- Native Claude binary/version/auth status and MCP tool call:
- Native Codex binary/version/auth status and MCP tool call:
- Run A objective/task IDs, worktree, diff hash, test result, reviewer findings, message IDs and human verdict:
- Run B same fields:
- Failure and restart scenarios:
- Known gaps, unverified claims, security exceptions (must not be silently approved):
- Director decision: **accepted / rejected / pending**, with timestamp.

Keep raw logs and evidence paths **outside Git tracking**, protect them with 0600 permissions, and review them for private data before sharing. Mark Issue #78 complete only after both live role assignments and explicit Director acceptance.

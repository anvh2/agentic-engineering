# M1 collaboration acceptance runbook (Issue #78)

Status: **implementation candidate; owner E2E and Director acceptance pending**. Record the CI result at the exact commit. Scripted or socket tests are not proof of authenticated native model turns.

## Baseline and invariants

- Candidate: PR #79 `feat/v2-agent-runtime`. Engineering knowledge pack **1.0.0**; draft documents stay provisional.
- Desktop: Wails v2, Go 1.25, Node 22. MCP binds a random IPv4 loopback port and requires per-turn bearer tokens.
- **Execution** runs from **Work > Working**. The Go runtime is the only authority for execution state, which is held in memory: after a restart an unfinished or unaccepted issue shows *Interrupted by restart* and needs Retry. Turns, messages, tasks, reviews and usage stay in `collaboration.sqlite`.
- Migration 003 adds participant duty, reviews and session-cumulative usage. A pre-migration `.bak` snapshot is written next to the database; older builds refuse the migrated database.
- **Native permissions:** no bypass flag is used. Unattended turns run inside each harness's own sandbox: Codex `--sandbox workspace-write`; Claude `--settings` sandbox with `allowUnsandboxedCommands: false`, plus `--permission-mode acceptEdits` for the assignee only. User hooks and deny rules still apply. This permission posture needs Director approval (decision D1).
- Agent submission and reviewer approval are not acceptance. Only **Accept** in the desktop UI moves an issue to Done.

## Flow

1. Team: create two agents (any names, roles and harnesses). Connect an Engineering Knowledge source.
2. Projects: link one or more local Git repository roots. Every linked repository is inherited by its issues; the default repository is the primary working directory.
3. Working: create an issue, select Assignee and Reviewer, move it to In Progress.
4. The runtime creates one worktree per participant and repository under `<repository>/.worktrees/`, from the current `HEAD`. Uncommitted changes in your checkout are not included.
5. Assignee implements, runs tests, submits the task and messages the reviewer through MCP. The runtime captures the change (including new files and any agent commit) as a snapshot commit.
6. Reviewer gets exactly that snapshot in its own worktrees and records `submit_review`. Requested changes return to the assignee, for at most three review rounds.
7. The issue moves to In Review. A Director comment with an `@handle` starts that agent; a code change withdraws the approval and requires a new review.
8. **Accept** verifies the assignee worktrees still match the approved snapshot, then marks the task accepted. Apply the change with the `git cherry-pick` command shown under Changes & evidence.

## Verification

```bash
cd app/frontend && npm ci && npm run typecheck && npm run build
cd .. && gofmt -l internal main.go issue_runtime.go && go vet ./... && go test -race ./... && go build ./...
wails dev
```

To keep a test run away from your real collaboration data, start with `AE_DATA_DIR=/absolute/empty/directory wails dev`.

## Evidence report template

- Commit SHA / CI run URL / Go and frontend results:
- macOS version / Wails build result:
- Native Claude and Codex versions and login status:
- Per issue: assignee and reviewer harness, snapshot commits, observed test commands, review verdict, usage, Director decision:
- Stop, retry and restart observations:
- Known gaps and unverified claims:

Keep raw logs and evidence outside Git, mode 0600, and review them for private data before sharing.

# M1 — Team Agent Identity Refactor (PR #79)

## Investigation

Before this change, the M1 UI exposed `Claude` and `Codex` as the only two participant choices. The Wails `CreateM1Objective` method and the SQLite domain constrained the `agent` column to these two values and derived participant handles from `<provider>-<role>`. Meanwhile Team profiles had separate IDs, handles, roles, models and knowledge assignments, persisted in frontend demo state. This disconnected objective execution from Team configuration and prevented multiple Team agents using the same native harness.

## Decision and implementation

- **Agent identity**: Team profile `id`, `name` and `handle`, independent of its native harness. A participant also captures its Team role and model.
- **Harness**: Only the native execution provider; the existing SQLite `participants.agent` column remains a native harness kind for adapter compatibility. The distinct `agent_id` is the business identity. Neither the selected role nor handle is derived from a provider.
- **Knowledge**: Capture the Team agent's source root, languages and assigned document IDs at objective creation. M1 turns resolve this per-participant snapshot; the previous per-turn knowledge-path field remains only for old objectives.
- **Creation**: Working lists configured Team agents, not harnesses, as Assignee and Reviewer. Two distinct Team agent IDs are required, but both may use the same harness.
- **Persistence**: Migration 002 adds additive participant columns, defaulting old records to empty IDs and preserving their original handles/native sessions. A profile edit applies to **new** objectives; an existing objective's agent snapshot is immutable to avoid changing a running/resumable session unexpectedly.
- **Execution and evidence**: Native model option is passed to the existing Claude/Codex adapter (the UI's `Default` defers to the CLI). MCP principals, objective participants, snapshots and Insights carry Team identity. Worktrees, bounded wakes, Director verdicts and native permissions remain as before.

## Verification

- `app/internal/core/team_agents_test.go`: same-harness agents with independent names/handles/IDs, JSON serialization, MCP principal and objective view; duplicate identities/handles rejected.
- `app/collaboration_runtime_test.go`: real Git worktrees for two Team agents sharing Codex; objective snapshot preserves agent IDs and per-agent worktree isolation.
- Existing core, collaboration and MCP tests must stay green; frontend typecheck/build and Go race/vet/build are required in CI.
- Manual macOS acceptance is still required: create/edit two Team agents (including same-harness pair), connect Engineering Knowledge v1.0.0, create and execute an objective, verify agent names in Work and Insights, and restart/resume a native session.

## Update: Working execution

Execution now starts from Working. The UI syncs configured Team agents into an in-memory Go registry and an issue refers to its Assignee and Reviewer by Agent ID only. Duty (assignee or reviewer) is stored per participant and is independent of role name and harness.

## Known boundaries

Team profiles currently originate in the frontend demo-store/localStorage; this change uses those existing Team entities and persists an immutable validated snapshot into the M1 SQLite database. A single canonical server-side Team registry is **not** implemented by this PR. Similarly, unifying the Project Selector and Work → Projects or changing the repository access model is separate scope.

Do not mark M1 accepted solely because automated checks pass; actual native runs and Director acceptance remain required.

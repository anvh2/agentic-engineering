# Agentic Engineering V2 — engineering rules

- English for code, documentation, commits, reports and handoffs.
- Native harness first: preserve Claude Code and Codex native tools, skills, permissions and context management. Roles are configurable and independent of harness identity. Load condensed role fundamentals and relevant project context; load specialized knowledge progressively.
- Keep one Go application with Wails, SQLite and embedded MCP. Do not introduce external brokers or a replacement harness without explicit approval.
- Preserve human acceptance and permanent knowledge approval boundaries. Never bypass native permissions or expose credentials. Do not start paid inference without authorization.
- Isolate new worktrees under the canonical checkout's .worktrees/ directory. Do not modify another checkout, terminate another session, delete local runtime evidence, force-push or merge master without authorization.
- Repository evidence wins over reports. Distinguish mock, build, integration and authenticated native E2E evidence. Never claim unrun tests passed.
- V2 implementation lives in app/. Read docs/v2/PROGRESS.md and the V2 design/evidence documents before changing runtime contracts. Historical V1 docs are reference only; do not follow obsolete Mastra instructions. Preserve engineering/ as reference knowledge until its V2 integration is designed.
- Verify frontend with npm run typecheck and npm run build in app/frontend; verify Go with gofmt, go vet ./... and go test -race ./... in app after frontend build. Verify Wails build and native behavior on macOS separately.

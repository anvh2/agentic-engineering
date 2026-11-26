# Agentic Engineering v2 — Desktop UI

This folder is an isolated **Go/Wails macOS desktop UI foundation**. It does not modify or replace the existing v1 runtime.

## Development

Requirements: Go 1.23+, Node 22+, macOS build tools, and Wails v2.

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.2
export PATH="$(go env GOPATH)/bin:$PATH"
cd app
go mod tidy
wails doctor
wails dev
```

Build the application with `wails build` inside `app/`.

For a browser preview, run `cd app/frontend && npm install && npm run dev`.

## Screens

Overview, Projects, Objectives, Collaboration, Sessions, Decisions, Engineering DNA, Team, Usage & Cost, Settings.

Projects can reference shared repositories; role assignment is configurable per objective. Role base knowledge and global knowledge are editable. All content in the UI is illustrative demo data, stored in browser localStorage.

## Boundaries

- **No agent processes are launched.** MCP, SQLite, native CLI integration and live usage collection are not implemented.
- No changes to the existing Mastra, scheduler or worker runtime.
- No external services or message brokers are required for this demo.
- Native harness capabilities of Claude Code and Codex must be preserved in future integrations.
- No macOS native build has been verified in this environment.

## Verification

Run `cd app/frontend && npm install && npm run build` to compile the UI. Run `cd app && wails build` on macOS to verify the desktop bundle.

# Agentic Engineering V2 — engineering rules

- English for code, documentation, commits, reports and handoffs.
- Native harness first: preserve Claude Code and Codex native tools, skills, permissions and context management. Roles are configurable and independent of harness identity. Load condensed role fundamentals and relevant project context; load specialized knowledge progressively.
- Keep one Go application with Wails, SQLite and embedded MCP. Do not introduce external brokers or a replacement harness without explicit approval.
- Preserve human acceptance and permanent knowledge approval boundaries. Never bypass native permissions or expose credentials. Do not start paid inference without authorization.
- Isolate new worktrees under the canonical checkout's .worktrees/ directory. Do not modify another checkout, terminate another session, delete local runtime evidence, force-push or merge master without authorization.
- Repository evidence wins over reports. Distinguish mock, build, integration and authenticated native E2E evidence. Never claim unrun tests passed.
- V2 implementation lives in app/. Read docs/v2/PROGRESS.md and the V2 design/evidence documents before changing runtime contracts. Historical V1 docs are reference only; do not follow obsolete Mastra instructions. Preserve engineering/ as reference knowledge until its V2 integration is designed.
- Verify frontend with npm run typecheck and npm run build in app/frontend; verify Go with gofmt, go vet ./... and go test -race ./... in app after frontend build. Verify Wails build and native behavior on macOS separately.

## Active V2 engineering baseline

- Treat **all `app/` V2 code as actively developed**, not legacy. The legacy-convention exception (GEN-06) does not excuse violations of current engineering standards. Refactor the affected code to conform when modifying it; keep unrelated scope changes reviewable.
- Use [engineering-knowledge/main](https://github.com/anvh2/engineering-knowledge/tree/main) as the authoritative knowledge contract. Match `manifest.json` fields `load`, `roles`, `languages`, `status`, and stable document IDs; never infer applicability from paths or hardcode provider identities as roles.
- Pack-level `approved` does not approve individual `draft` documents. Keep per-entry status visible; do not treat Markdown policy as permission to bypass native harness, sandbox or human approval.
- Mandatory bootstrap means engineering DNA, matching role and applicable standards within the 24 KB document-body budget. On-demand skills, references, profiles, guides and lessons must remain scoped by role, language and assignment; never inject every assigned document into each prompt.
- Report actual native usage separately from byte-based context estimates. Trace `selected`, `available`, `injected` and observed tool reads as distinct evidence; do not present an available document as read.
- Follow the Go, testing, delivery, security and autonomy standards even for pre-existing V2 files: format with `gofmt`, group related declarations, propagate context/cancellation, verify error paths, use read-only inspection by default and report executed checks. No broad refactor outside the requested engineering workstream without an explicit rationale.

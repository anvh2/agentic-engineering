# Verification ledger

Codex, 2026-11-26 UTC. Base revision: 26365c08307e0461c1f657af47cef5e9f1a1f0bf. Worktree codex/v2-foundation. Only analysis documents added at this checkpoint; no V2 backend implemented yet.

| Command / probe | Result | Meaning |
| --- | --- | --- |
| npm run typecheck | Exit 0 | Existing TypeScript source typechecks |
| npm test (initial environment) | Exit 1 before tests: quoted glob not found | npm selected older Node through subprocess PATH |
| Explicit test file inventory (initial Python environment) | 159 file-load failures: Node 20.16.0 cannot load .ts | Not test assertion failures; unusable environment |
| PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin npm test | 1609 tests: 1273 pass, 288 fail, 47 cancelled, 1 skip | Sandbox denies local listeners and nested sandbox-exec; further failures need triage. Not a passing baseline. |
| npm --prefix app/frontend run typecheck | Exit 0 | Prototype frontend checks |
| npm --prefix app/frontend run build | Exit 0 | Prototype assets generated; not a DMG or app launch |
| Codex schema generation | Exit 0 | Installed 0.161.0 schema captured |
| Codex app-server initialize with normal home | Exit 1: cannot initialize SQLite state under sandbox | No successful handshake |
| Codex initialize with isolated CODEX_HOME | Exit 0, real JSON-RPC response | Startup protocol works without inference |
| Codex thread/start and mcpServerStatus/list, isolated home | Success | Actual native ID allocation and status calls |
| Codex thread/resume before any turn | -32600 no rollout found | ID allocation does not prove resumability |
| Baseline Go tidy/build, initial subprocess PATH | Failed: Go 1.20 cannot tidy Go1.23 module | Toolchain skew; retried with explicit Go1.25 |

Raw logs: worktree-local `.workdir/v2/evidence/`. Full test log contains 77 occurrences of loopback listen EPERM, plus denied sandbox self-tests and dependent failures; these occurrences are diagnostic counts, not disjoint test totals. Do not label all failures environmental without individual triage. No unsandboxed rerun or paid model call was used to hide failures. Existing user processes remain untouched.

## First implementation checkpoint

MCP server and Codex argument/event parser implemented against jointly reviewed types. `go test ./internal/agent ./internal/mcp` passes. `go test -race ./internal/mcp` passes. Protocol coverage includes official SDK client through in-process HTTP, initialization/tool listing/calls, principal isolation, foreign Host/Origin, absent/invalid/revoked credentials, input bounds, forbidden acceptance, forged authority fields, and redacted errors. These tests do not use a real socket or SQLite service yet.

Codex parser tests cover native configuration preservation, explicit resume identity, env-only token reference, usage normalization, repeated terminal usage, missing fields, malformed/negative counters, known-token redaction and false-success prevention. Shared process launcher and actual adapter Run are not wired at this checkpoint.

Baseline Go1.25 offline dependency resolution and `go build` completed with exit 0 using a separate modfile under .workdir (canonical checkout untouched). This is compilation, not packaged startup or clean-machine installation.

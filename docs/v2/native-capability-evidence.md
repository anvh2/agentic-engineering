# Native capability evidence

Author: Codex. Captured 2026-11-26 UTC on darwin/arm64. No inference call, authentication change, global configuration change or existing daemon control was performed.

| Probe | Actual result | Limit |
| --- | --- | --- |
| claude --version | 2.1.59 | PATH binary; separate IDE session may differ |
| claude --help | mcp-config, append-system-prompt, resume, session-id, stream-json input/output, partial events, native permission modes | Advertised, not yet exercised |
| claude auth status | loggedIn false in execution sandbox | Does not describe separate running Claude session |
| codex --version | codex-cli 0.161.0 | Warning: PATH aliases could not be created under sandbox |
| codex login status | Logged in using ChatGPT | No credentials read; does not prove inference access |
| codex exec --help | JSON output, resume/fork, config overrides, sandbox; ignore-user-config is optional | Preserve native config by default in V2 |
| codex app-server --help | stdio transport and schema generation | Experimental surface; do not control an existing daemon |
| codex app-server generate-json-schema --out .workdir/v2/evidence/codex-schema | Exit 0, generated local protocol schema | No inference; not proof of method execution |
| go version | go1.25.10 darwin/arm64 | Development host only |

Generated schema includes thread/resume, turn/start, turn/interrupt, mcpServerStatus/list, thread/tokenUsage/updated and developerInstructions. Raw generated schema is local evidence in the worktree's gitignored .workdir. Use this exact schema to validate adapter payloads instead of copying a potentially newer web example.

Cached official Go MCP SDK versions include 0.8.0, 1.4.0 and 1.8.0. Source inspected for 1.8.0: requires Go 1.25, supports stateless Streamable HTTP, JSON responses and authenticated request context. It explicitly returns 405 for stateless GET/DELETE. Domain-session persistence must not depend on transport-session IDs. Version pin remains pending contract reconciliation; choosing it changes the prototype's Go 1.23 minimum.

Sources: [Codex MCP](https://developers.openai.com/codex/mcp), [Codex app-server](https://developers.openai.com/codex/app-server), [Claude MCP](https://code.claude.com/docs/en/mcp), [Claude programmatic usage](https://code.claude.com/docs/en/headless), [official Go MCP SDK](https://github.com/modelcontextprotocol/go-sdk), [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Current web docs describe capabilities; installed CLI/schema probes establish only the advertised local surface. Native HTTP auth, role snapshot after compaction, cancellation and message-triggered resume remain unverified.

## Additional actual probes

Codex app-server initialization succeeded (JSON-RPC id 1, exit 0) using a fresh worktree-local CODEX_HOME containing no login or copied configuration. No thread or turn was created. An initial attempt with the normal home failed because this sandbox cannot initialize Codex SQLite state there; it did not establish a connection. The isolated result proves executable/protocol startup, not authenticated inference or preservation of the user's existing configuration.

Baseline testing exposed PATH skew: the interactive shell reports Node 22.23.2, while Python/npm subprocess resolution initially selected Node 20.16.0. The first npm test invocation failed on quoted glob handling; explicit inventory then failed loading TypeScript in Node 20 (159 failed file loads, not 159 failed assertions). A new prescribed npm test invocation explicitly prefixes the installed Node 22 directory. Results remain pending. No repository test script was changed to conceal the environment issue.

A second no-inference app-server experiment succeeded for initialize, thread/start (workspace-write, on-request, appended developerInstructions marker), and mcpServerStatus/list in isolated CODEX_HOME. Immediate thread/resume returned -32600, "no rollout found for thread id". No turn was requested. Therefore native ID allocation does not establish resumability; persist resumability evidence separately. This does not test inference, context behavior, configured real MCP servers, or recovery after a real turn.

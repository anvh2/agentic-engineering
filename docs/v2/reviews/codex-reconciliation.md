# Codex reconciliation / interface freeze

2026-11-26 16:07 UTC. Read Claude review, interface proposal, actual core/api.go and agent/agent.go, and native evidence.

ACCEPT core exported types and five method signatures plus Authenticate, errors/bounds; official SDK v1.8.0 + Go1.25; consumer-side Core interface. ACCEPT ownership incl Codex adapter, Claude launcher/core/storage. I will copy only the reviewed contract types into my isolated worktree for compilation; do not edit your tree. Merge identical contract definitions later.

F1 accept server-scoped MCP preapproval for the five bounded collaboration tools only; detect structured failures despite zero exit. F2 accept deterministic single-flight/coalescing and notice-only wake. Wake count must be explicit objective policy, not implicit permission to consume 24 turns: default disabled until objective has authorization/budget. F3 accept per-turn CLI processes for M1; app-server stays researched alternative for native approvals, not M1 dependency. F4 remains M2 gate, no native-tool allowlist or bypass.

F5/F6 accept clean environment and realpath/version; configurable explicit additions required for native auth providers/proxies, never silently copy provider credentials. F7 accept observed normalization, invalid cached>input yields unknown/error not negative. F8 accept per-turn tokens WITH startup transaction interrupting running turns/revoking their tokens. A crash does not magically expire a future TTL; this needs explicit recovery test.

F9 accept initial snapshot + resume delta; compaction remains unproved. F10 accept stateless JSONResponse. F11 agree sandbox auth is unknown (report already qualified execution sandbox). F12 accept participant-addressed mail and fetched cursor, but dropped HTTP response must be replayable via explicit after, do not destructively consume. F13 defer packaged data-root exception ADR until needed; dev own .workdir now. F14 accept Go1.25/module sums and separate demo.

ONE correction: DO NOT use --strict-mcp-config by default for Claude. It discards native/user MCP servers, unlike Codex, and violates preservation. Repass AE config each turn without replacing other servers. Test collision with an existing ae server; choose reserved unique name or detect conflict.

Task ownership must be session/turn-fenced internally even if UI displays participant: older live attempt cannot mutate successor claim. Core mutations revalidate token/turn in same transaction as write. Revocation between HTTP authentication and commit must fail.

Proceeding MCP implementation against frozen core signatures. Please ack these corrections; native adapter helper contract can proceed after launch.go exists. Please provide an exported test fixture/provisioning API for end-to-end MCP+SQLite tests.

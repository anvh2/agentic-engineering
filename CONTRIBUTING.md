# Contributing

Thank you for helping improve Agentic Engineering. This is an experimental system that runs model-generated code: safety changes require strong, reproducible evidence.

## Setup

Use Node.js >=22.13, npm, Git and **macOS** for the supported sandbox implementation. Work in a feature branch or isolated worktree with disposable, secret-free fixtures.

```sh
npm ci
npm run typecheck
npm test
```

Full regression can be slow and sensitive to local subprocess/sandbox conditions. If it fails, report the exact command, commit SHA, environment and sanitized failure output. Do not weaken existing protected safety assertions to achieve a green result.

## Pull requests

- Keep diffs scoped and explain the behavior, tests and risk.
- Identify changes to leases, run ownership/fencing, cancellation, sandbox rules, secrets, provider costs, persistence schemas or integration authority.
- Provide deterministic negative/positive tests and independent acceptance evidence for safety-sensitive changes; state which tests actually ran.
- Describe migrations, rollback and compatibility when persisted behavior changes.
- Do **not** commit private source code, credentials, absolute personal paths, raw provider prompts, production logs or private evidence.
- Do not push or merge from an autonomous agent without explicit operator approval. A PR does not authorize paid provider usage.

Follow [AGENTS.md](AGENTS.md) for the runtime's agent safety boundaries and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

Only submit material you have the right to license. Contributions to original repository-owned code are submitted under the project's Apache-2.0 license unless expressly documented otherwise. Retain required third-party and Studio upstream attributions/notices.

# Security Policy

## Support status

Agentic Engineering is an **experimental local-first runtime**. No released version or branch is certified for unattended production usage, and there is no formal security maintenance SLA.

## Reporting vulnerabilities

Use this repository's **GitHub Private Vulnerability Reporting** / **Report a vulnerability** when enabled. If unavailable, contact the maintainer privately through a verified channel rather than publishing an exploit report or credentials in a public issue. Coordinate disclosure timing with maintainers.

## Threat model and limitations

- Model output, prompts, tool results, repository content and GitHub issues are untrusted data, **not authority** to increase tool access or spending.
- The current verifier relies on macOS `sandbox-exec` and must fail closed when isolation cannot be proven. It is neither a hardened VM nor a Linux/Windows isolation guarantee.
- Experiment first on a **disposable, secret-free repository**, ideally in an OS account/VM without access to sensitive data. Keep backups and review generated diffs.
- SQLite databases, worktrees, prompts, traces, screenshots and regression evidence can contain source code, tokens or personal/host details. Treat them as private unless audited.
- The embedded Studio/Organization UI and Gateway are for trusted **loopback-only** use, **not** an Internet-facing or multi-tenant control plane.
- Prompts sent to external model providers may include selected code/context. Store API keys in local protected configuration; never add them to version control or published evidence.
- Never disable fencing, cancellation, sandbox, permissions, spend caps or acceptance gates merely to make tests pass.

## Before public release

Review [the OSS release checklist](docs/operations/oss-release-checklist.md). In particular, scan **all Git history and archived artifacts** (not only the current source tree), verify third-party licenses and resolve or explicitly document regression risks. This policy does not claim these audits have already passed.

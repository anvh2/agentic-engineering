# OSS release gate — NOT completed

This is a **release-readiness checklist**, not a statement that verification has passed.

## Source and governance

- [ ] Reconcile local `main` and GitHub default `master` branch naming before a release.
- [ ] Tag and document the exact version/commit; retain upstream and third-party license notices, including pinned Mastra Studio and any enterprise-subtree restrictions.
- [ ] Audit README, installation instructions and contributor/security channels against the exact release.
- [ ] Enable required CI checks, review/branch protection and protected release tags.

## Confidential data and supply chain

- [ ] Scan current source **and complete Git history**, including committed `.tgz`, patches, archived logs, transcripts, screenshots, traces and other evidence for API keys, source snippets, host paths and sensitive/private data.
- [ ] Audit pre-existing public releases/history before announcing OSS availability; coordinate any necessary history rewrite and credential rotations.
- [ ] Verify upstream/dependency licenses, notices and transitive bundled assets. Inspect package and lockfile provenance and CI permissions.
- [ ] Ensure distributed artifacts exclude ignored `.env`, `.workdir`, caches, DBs, local prompts, personal info and provider credentials.
- [ ] Confirm local Studio/Gateway is bound to loopback; public deployment requires a separately verified authentication/authorization design.

## Engineering and acceptance

- [ ] Run `npm ci`, `npm run typecheck` and appropriate scoped tests on the exact release commit.
- [ ] Obtain a reliable full-regression gate; M10.1's reported intermittent cancellation failure and test hang remain unresolved.
- [ ] Validate a fresh macOS install without machine-specific paths or undocumented dependencies.
- [ ] Prove deny-default sandbox behavior for read/write/network and no fail-open fallback.
- [ ] Execute one disposable real coding mission with bounded explicit model spend, independent oracle, review and verified integration.
- [ ] Verify crash/restart, cancellation and recovery without leaked processes or model permits.
- [ ] Document known security limits, model costs, operational diagnostics, rollback and release notes.

## Deferred from this documentation-only PR

Headless Supervisor, production multi-provider delegation, Linux/Windows sandbox implementation, SaaS billing/credits, multi-tenant auth and enterprise features are **not shipped** as part of OSS docs.

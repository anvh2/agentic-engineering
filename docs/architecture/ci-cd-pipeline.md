# CI/CD pipeline: quick PR feedback, post-merge safety gate, deploy, real canary

The pipeline contract is:

```text
PR -> typecheck + four-shard fast suite -> merge to master
   -> complete post-merge smoke/E2E regression (all tests, including Oracle/security)
   -> deployment (BLOCKED unless the exact master SHA passed post-merge)
   -> bounded real workflow canary -> evidence + report
```

## Current implementation

- `.github/workflows/ci.yml` runs on pull requests, with reusable `validation.yml` in `fast` lane.
- Fast lane includes all `src/**/*.test.ts` and `apps/**/*.test.ts` files across **four macOS shards**, plus TypeScript typecheck on Ubuntu.
- Fast lane excludes `tests/**/*.test.ts` (the smoke/E2E suites are explicitly grouped under `tests/smoke-e2e/`; other test harnesses include Go ladder, reliability and independent Oracle checks). These remain covered post-merge; they are **not removed** from the repository or `npm test`.
- `.github/workflows/post-merge-e2e.yml` runs on **push to master**, with the reusable `full` lane across ten macOS shards; covers `src`, `apps` and `tests` including M8.6 mock-provider full lifecycle.
- Both macOS lanes install native Node and Go outside `HOME` to preserve the fail-closed runtime sandbox. Neither lane executes paid LLM APIs.
- Manual `workflow_dispatch` supports running both CI lanes when desired.

## Deployment and real-run gates (NOT YET IMPLEMENTED)

No deployment target, runner, environment, release command or real workflow invocation has been specified. Do not introduce a fake deploy step or run agents on a live host.

Before wiring deployment:
1. Configure a protected environment with explicit secrets and deployment target.
2. Require the post-merge smoke/E2E workflow to have `success` for the **exact commit SHA** being deployed; a stale prior green commit cannot authorize a newer one.
3. Ensure deployment uses that SHA and is idempotent, supports rollback, and leaves the existing Mac Studio development instance untouched.
4. After deployment, execute a small operator-approved canary objective with limited provider budget, bounded task attempts, dedicated worktree, pinned acceptance, and no auto-merge or auto-deploy.
5. Always publish a report with deployed SHA, objective/task IDs, PASS/FAIL/escalations, verifier/Oracle results, token/cost telemetry, elapsed time, artifacts, cleanup, and link to CI. Canary failure blocks promotion and surfaces a human-actionable report.

## Caveats

This separation **moves full E2E gating after merge**, so a defective merge can reach `master` before the heavier checks detect it. The deployment MUST remain blocked until full post-merge checks pass. Branch protection on master should require the fast PR checks and disallow bypass.
The 5–10-minute fast CI target is an SLO to validate with actual Actions timings; changing shard count does not guarantee the time.
For safety-sensitive runtime changes, manually run the full E2E lane **before** merging (or require a conditional high-risk PR gate).

## Smoke/E2E suite layout

- `tests/smoke-e2e/*.test.ts` owns the nine provider smoke and full-lifecycle safety suites, including M8.6 repeatability, failure injection, and Oracle isolation.
- Shared smoke helpers, fake-provider executables and pinned fixtures remain in `tests/provider-smoke/` so existing CLI tools and fixture references continue to work.
- `npm run test:smoke-e2e` runs the E2E test lane explicitly; `npm test` and post-merge full regression still discover the moved tests via `tests/**/*.test.ts`.
- The M8.6 parallel independent-run optimization from PR #50 is incorporated in this PR, based on M11's current SHA.

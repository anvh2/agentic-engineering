# Workspace: registration and repository setup

## Identity

| Item | Value |
| --- | --- |
| Project ID | `cloudfarm` (stable; used as `batches.project` and the project record name) |
| Checkout | `<workspace>/cloudfarm` (sibling of this repository; recorded as `../cloudfarm`) |
| Root commit | `311f9a4f0940d4c31ce8cee8aab9d1b243204447` (authoritative identity: a mismatch refuses project commands) |
| GitHub | https://github.com/anvh2/cloudfarm, private (Architect decision D-001), default branch `master` |
| Merge policy | merge commits only (squash and rebase disabled at repository level); merges to `master` need Architect approval |

## Registration (existing mechanisms, no new registry)

1. **Project record**: `.workdir/projects/cloudfarm/project.json` (`agentic.project/1`, local runtime state, never committed):

   ```json
   {
     "schema": "agentic.project/1",
     "repo": "../cloudfarm",
     "identity": { "rootCommit": "311f9a4f0940d4c31ce8cee8aab9d1b243204447" },
     "test": { "command": ["go", "-C", "tools/docscheck", "test", "./..."], "timeoutMs": 300000 },
     "expectedLocal": []
   }
   ```

   The test command becomes the Go service's test suite once it exists (CloudFarm #5).

2. **Scheduler scope**: every CloudFarm batch is created with `"project": "cloudfarm"`. This is what makes CloudFarm a
   project in Studio: the Control Center resolves scope only through `batches.project`.

3. **Batches per milestone wave**: batches are append-only, so each wave of missions is a new batch
   (`CF-M0`, then `CF-M0b`/`CF-M1`...). A batch may target another repository while staying in the `cloudfarm`
   project (for example go-kit work for CloudFarm #4 and #12).

## Repository setup performed

| Step | Result |
| --- | --- |
| `git init -b master` in the existing empty directory | First commit `311f9a4` (README, AGENTS.md, .gitignore) |
| `gh repo create anvh2/cloudfarm --private --source . --push` | Created after confirming it did not exist |
| Repository settings | `allow_squash_merge=false`, `allow_rebase_merge=false`, `allow_merge_commit=true`, wiki off |
| Labels | `type:{docs,spike,feature,infra}`, `area:{api,data,security,portal,codegen,simulator}`, `decision-needed`, `mvp` |
| Milestones | #1 "M0 — Discovery & Foundations", #2 "M1 — First Vertical Slice: Farm Structure" |
| Branch protection | Not configured: protection rules on private repositories need a paid GitHub plan; the merge policy is enforced by review practice |

## Source-of-truth boundaries

| GitHub is authoritative for | Agentic Engineering is authoritative for |
| --- | --- |
| repository, branches, commits | engineering discussions and meeting records |
| issues and milestones (scope, acceptance criteria, open/closed) | engineering decisions as recorded in discussions/meetings |
| pull requests and their reviews | missions (scheduler tasks), their lifecycle and attempts |
| CI checks, releases | worker assignments, model routing, traces, tool usage |
| | runtime verification results, review decisions, engineering metrics |

Rules:

- A mission never restates an issue's scope as a second, independently edited record. It references the issue and adds
  only execution facts (contract, assessment, attempts, verification, review).
- One issue may have many missions (re-plans, corrections, retries, different workers); their history is never
  overwritten (scheduler batches and tasks are append-only, events are an audit log).
- Product and architecture decisions are written into CloudFarm's docs (ADRs, PRD) through PRs, so GitHub holds the
  merged decision; the discussion that led to it stays here.

## Branch and worktree conventions

- CloudFarm missions run through the runtime: Lead-owned tasks commit on `lead-integration/<batch>` in the managed
  worktree `.workdir/worktrees/<batch>/_integration`; worker tasks get `lead-task/<batch>/<task>`.
- The integration branch is pushed and proposed as a PR; the Architect merges with a merge commit.
- No other worktree, fork or clone is created for CloudFarm.

# Evidence

## Contract

Every claim in this case study points at evidence held by its authoritative system. Documentation stores references,
not copies.

| Evidence | Authoritative location | Stable reference |
| --- | --- | --- |
| Original request | this directory | [kickoff-brief.md](kickoff-brief.md) |
| Discussions, decisions | CloudFarm `docs/discussions/`, ADRs, PRD (merged by PR); later collaboration threads in the scheduler DB | file path at a commit; thread ID |
| Issues, milestones, PRs, commits, CI, releases | GitHub `anvh2/cloudfarm` | `anvh2/cloudfarm#N`, commit SHA, workflow run ID |
| Missions and lifecycle | scheduler DB `.workdir/scheduler/scheduler.db` (`batches`, `tasks`, `events`) | batch ID, task ID, event `seq` |
| Lead-direct verification | `tasks.artifacts.claudeDirect` (commit, note, integration command exit codes and output tails) | task ID |
| Worker runs | `.workdir/lead-delegations/<taskId>-<ts>/` (`trace.jsonl`, `attempts.json`, `result.json`), Mastra workflow run | task ID, run ID |
| Reviews | scheduler `reviews` table; GitHub PR reviews | review ID; PR URL |
| Metrics | scheduler timestamps and counters; model-call usage where providers report it | task ID |

Rules: no metric is estimated or reconstructed; a missing value is reported as "not measured". A task state is never
presented as a verifier PASS unless the verifier's own record says so. Failures stay in the ledger.

Retention: the scheduler DB and `.workdir/` are local runtime state (gitignored). They are not backed up by this
repository; the ledger below keeps the identifiers needed to find each record, and GitHub keeps the code-side record.
A durable export of execution data is part of the platform's separate publication gate (AGENTS.md).

## Ledger

| ID | When (UTC) | What | Reference | Result |
| --- | --- | --- | --- | --- |
| E1 | 2026-11-09 | Workspace and platform discovery | [DISCOVERY.md](DISCOVERY.md) | Findings recorded; no changes made during discovery |
| E2 | 2026-11-09 | CloudFarm repository created (private, after Architect decision) | https://github.com/anvh2/cloudfarm, root commit `311f9a4` | `visibility=PRIVATE`, default branch `master`; squash/rebase merges disabled |
| E3 | 2026-11-09 | Labels, 2 milestones, issues #1–#11, then #12 (go-kit finding) | anvh2/cloudfarm milestones 1–2, issues #1–#12 | Created once; the script refused to run if any issue existed |
| E4 | 2026-11-09 | Project record | `.workdir/projects/cloudfarm/project.json` | `agentic.project/1`, `repo ../cloudfarm`, rootCommit `311f9a4…` |
| E5 | 15:14:16 | Batch `CF-M0` (`project=cloudfarm`, base `311f9a4`, integration commands = docscheck test + run) | scheduler batch `CF-M0`; tasks `CF-M0.gh1`, `.gh3`, `.gh5` | 3 tasks; `gh1` READY, others BACKLOG on `gh1` |
| E6 | 15:14:16 → 15:19:32 | Mission `CF-M0.gh1` (anvh2/cloudfarm#1): READY → CODING → DONE | task `CF-M0.gh1`, events (6 for the batch), `artifacts.claudeDirect` | Runtime ran `go -C tools/docscheck test ./...` exit 0 and `go -C tools/docscheck run . -root ../..` exit 0 (`docscheck: ok`) on commit `81e2364` |
| E7 | 2026-11-09 | PR for #1 | https://github.com/anvh2/cloudfarm/pull/13 (`lead-integration/CF-M0` → `master`) | Open, awaiting Architect review; not merged |
| E8 | 2026-11-09 | Studio 4111 visibility | `GET http://127.0.0.1:4111/control-center/v1/snapshot?project=cloudfarm` | `source: connected`, scope `{project: cloudfarm, objectiveIds: [CF-M0]}`, 3 tasks; project list contains `CF-M0 → cloudfarm`; `CF-M0.gh1` shown DONE with its transitions |
| E9 | 2026-11-09 | Platform verification before committing the case study on `master` | `npm run typecheck`, `npm test` | typecheck exit 0; 1609 tests, 298 suites, 1609 pass, 0 fail (814 s) |

### Execution facts for `CF-M0.gh1`

| Fact | Value |
| --- | --- |
| Executor / model routing | `claude` (Engineering Lead, Claude Opus 5.5). Kept reason recorded on the task: discovery/HLD/ADRs are Lead-owned and outside the local worker's delegation gate |
| Worker | none (no local worker involved) |
| Attempts / retries / escalations | 1 / 0 / 0 |
| Wall clock (task created → DONE) | 315.9 s (`finished_at - created_at` = 315885 ms) |
| Independent review | Not yet: Architect review on PR #13 is the review gate. No agent reviewer was run |
| Tokens and cost | Not measured: the runtime records model usage only for worker-provider calls; this Lead session's usage is not captured |

### Failures and recovery

| When | What | Recovery |
| --- | --- | --- |
| Discovery | One verification command failed to run (Python quoting error in an inline script), not a platform failure | Re-run with a heredoc script |
| Meeting for the kickoff | Not possible: no model-backed participant available (Ollama down) | Recorded as a discussion document; meeting deferred |

## Lessons so far

1. The platform's project concept already exists (`batches.project` + `agentic.project/1`); CloudFarm needed no new
   registry, only conventions.
2. Making a Lead-owned documentation task verifiable required a real verifier (`docscheck`). Without one, the runtime would
   have accepted the Lead's claim, which the brief forbids.
3. Inspecting go-kit's source, not its API surface, found a fail-open authorization risk (#12) before any CloudFarm code
   depended on it.
4. The missing GitHub link is the main gap between "missions exist" and "missions are linked to issues as data".

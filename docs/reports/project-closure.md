# Project closure report: Agentic Engineering

Written 2026-11-07 by the Engineering Lead. **Status: NOT COMPLETE.** Every number below comes from a command in [Gate evidence](#gate-evidence) or from GitHub and runtime state read on the date above. Two things block the label COMPLETE: the Engineering Director has not yet reviewed and merged the two documentation PRs (#63, #69), and one mandatory gate in `AGENTS.md`, **execution-data publication, is not satisfied** and needs a Director decision ([below](#execution-data-publication-gate)). Separately, four housekeeping categories await the operator's authorization; none of them is a safety blocker ([classification](#leftovers-safety-blockers-versus-housekeeping)). The :4111 handoff is done and verified.

## Architecture and capabilities

One supported execution path ([runtime.md](../architecture/runtime.md)):

`lead CLI → scheduler (SQLite) → executor → Mastra workflow → coding runner → worker → sandboxed verifier → review → integration`

| Capability | Where | State |
| --- | --- | --- |
| Task lifecycle, atomic claim, lease + fencing, recovery | `src/runtime/scheduler` | verified |
| macOS `sandbox-exec` verifier, fail closed, credential isolation | `src/runtime/sandbox`, `tests/smoke-e2e/m87-*` | verified |
| Mutation policy, protected paths, forbidden-mutation audit | `src/runtime/execution`, `src/workers/tools` | verified |
| Review independent of the worker; bounded correction chain | `src/runtime/review`, `src/lead/review.ts` | verified |
| Integration with rollback; oracle acceptance on the integration tip | `src/runtime/integration`, `src/lead/lifecycle` | verified |
| Machine-wide model capacity (FIFO permits) | `src/runtime/capacity` | verified |
| Provider routing with operator allow-list and budgets, no fallback | `src/runtime/execution/provider-routing.ts` (#62) | verified, on master |
| Headless supervisor with objective queue, fails closed | `src/lead/supervisor` (#64) | verified, on master |
| Meeting suggestions (advisory; a person accepts or dismisses) | `src/lead/collaboration/suggestions.ts` (#66) | verified, on master |
| Collaboration store, council, Control Center, Studio sidebar | `src/runtime/collaboration`, `src/integrations`, `apps/control-center`, `studio-fork` | verified |
| **Execution-data publication** (`AGENTS.md` gate) | none | **not implemented; mandatory gate unmet** (see [below](#execution-data-publication-gate)) |
| Languages with a worker | Go, JavaScript (TypeScript adapter disabled pending human approval) | as designed |

## Merged work

On `master`: #43 to #49, #52, #53, #57 to #62, #64 to #68. Closed unmerged and superseded: #50, #51, #55, #56.

Closure merges, all normal merge commits (never squash or rebase):

| PR | Merge commit | Parents | Notes |
| --- | --- | --- | --- |
| #66 | `bb01119` | `6db44d9`, `0dd6669` | Head `0dd6669` is master `6db44d9` merged into the PR branch. Merged with the repository-admin bypass of the `protect-master` ruleset (it requires one approving review and there is one reviewer, who is the author), on the Engineering Director's explicit instruction. |

Not merged yet: **#63** (docs-only M12 evidence). This report is #69; its own merge commit and the post-merge CI result for it are recorded in the PR #69 closing comment, because a commit cannot contain its own SHA.

## Gate evidence

Node v22.23.2, macOS.

| Gate | Command | Tip | Result |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` | master `6db44d9` | PASS |
| Full regression | `npm test` | master `6db44d9` | PASS 1578/1578 (0 fail, 0 skipped), 13.8 min |
| Typecheck | `npm run typecheck` | `0dd6669` | PASS |
| Full regression | `npm test` | `0dd6669` | PASS 1609/1609 (0 fail, 0 skipped), 13.2 min |
| Targeted: collaboration, lifecycle, supervisor, control-center | `node --test` over those directories | `0dd6669` | PASS 203/203 |
| Control Center app | `npm run typecheck`, `build`, `test --prefix apps/control-center` | `0dd6669` | PASS (53 + 17 tests) |
| Control Center browser (installed Chrome) | `npm run test:ui --prefix apps/control-center` | `0dd6669` | PASS 5/5, including Suggested Meetings |
| Reliability lab | `npm run reliability -- --scenario all --repeat 2 --concurrency 2` | master `6db44d9` | PASS 14/14, 7 scenarios |
| Studio build | `npm run build --prefix apps/control-center`; `MASTRA_TELEMETRY_DISABLED=1 npm run build -- --studio` | `bb01119` | PASS; runtime contains `studio: true` |
| PR CI for #66 | `CI` workflow on head `0dd6669` | `0dd6669` | run 42360458323 **cancelled** (superseded on the same SHA when marking the PR ready re-triggered CI under the workflow's concurrency group), then run 42360482904 **success**: typecheck + 4 test shards |
| PR CI for #63 | `CI` workflow | `7d4500f` | PASS: typecheck + 4 shards |
| Post-merge CI | `Post-merge smoke and E2E` (10-shard full regression), run 42361360126 | `bb01119` | **PASS** (typecheck and all 10 shards) |

`bb01119` and `0dd6669` have the identical git tree (`48eea24`), so the regression, app and browser results for `0dd6669` apply to the merged master exactly. The reliability lab and the baseline ran on `6db44d9`, whose differences from `bb01119` are the #66 files only; they were not re-run on `bb01119`.

Smoke and E2E on disposable repositories (`tests/smoke-e2e`: `m85-objective`, `m86-recovery`, `m87-credential-isolation`, `m8final-objective`) are part of `npm test` and passed in both full runs. Real-provider smokes are opt-in and were **not** run: no paid provider was called, and Ollama was not running during closure. A normal full run leaves no processes behind (checked before and after).

## Acceptance gates

| Gate | Assessment |
| --- | --- |
| A. Execution correctness | Transitions are enforced in one function (`SchedulerStore.transition`); a worker PASS ends at `REVIEW_PENDING`, only a recorded decision reaches `APPROVED`, only verified integration reaches `DONE`. Covered by the scheduler, lifecycle and E2E suites. |
| B. Security and mutation boundaries | Sandbox fails closed with no opt-out; credential isolation, forbidden-mutation and protected-path tests pass; a provider is denied unless the operator allows it, and a budget is required for any non-free provider. |
| C. Supervisor and recovery | Read independently (`src/lead/supervisor/cli.ts`): every exit other than verified normal completion keeps the gate, the leadership lock and the objective claims for a human; ownership is re-asserted after each lifecycle run; one objective runs under one supervisor. Queue, restart and ownership-loss tests pass; `m86-recovery` and the reliability lab pass. |
| D. Review and acceptance | Meeting suggestions open no meeting; security, authorization, budget, cancellation and dirty-tree stops are classified `operator` or `none` and never suggested; acceptance writes the meeting and the decision in one transaction; the table is append-only with database triggers and a CHECK tying status to decision. |
| E. Operations | **Partly met.** Met: :4111 is the read-only canonical Studio and now runs the `bb01119` build (verified by endpoint checks and a write-method refusal); preview ports and worktrees follow `AGENTS.md`. **Not met:** "represent verified activity across worktrees, including live and historical evidence" and the separate execution-data publication gate. :4111 reads only the canonical `.workdir/scheduler/scheduler.db`, so isolated-state runs (the M12 execution) are not shown on it. See [Execution-data publication gate](#execution-data-publication-gate). |

## :4111 handoff (done, verified 2026-11-07)

- **Before:** PID 37720 (server) under PID 37718 (`node studio-fork/start.mjs`, detached, parent 1), same user, started 2026-10-24 22:09 from the `studio-sidebar` worktree at `c8e2b94`. It lacked `meeting-suggestions`. Chrome (PID 41216) held two connections to it.
- **Ownership:** same OS user; launched by the repository's own launcher; its originating session no longer exists; no other live agent session (two Codex processes, one Claude) has a working directory or open file in the repository or claims the port or worktree.
- **Procedure:** built `bb01119` in `.worktrees/studio-master` (Control Center assets, Mastra runtime with `--studio`, the unchanged `studio-dist` copied from the old worktree because `studio-fork/` is identical between `c8e2b94` and `bb01119`); proved it on port 4112 (all seven endpoints 200, same objectives as :4111, POST refused with 405); stopped my 4112 preview; sent SIGTERM to launcher 37718 (it forwards the signal; server and launcher exited cleanly, port freed); copied the old isolated Mastra trace storage; started the new launcher on 4111.
- **Interruption:** between the stop and the new listener (which started at 17:04:25 +07) :4111 was down; the exact gap was not timed. The two open Chrome connections were dropped.
- **After:** launcher PID 90403 (parent 1) and server PID 90405, `.worktrees/studio-master`, log `.workdir/studio-4111.log`. `/`, `/organization`, `snapshot`, `council`, `agents`, `meeting-suggestions` and `/api/system/packages` all 200; snapshot lists the same objectives; the served app contains the Suggested Meetings client; POST to the gateway returns 405.
- **Rollback:** the old worktree `.worktrees/studio-sidebar` is untouched; start it with `AGENTIC_SCHED_DB=<canonical scheduler.db> node studio-fork/start.mjs` after stopping launcher 90403.
- **Limit:** the browser UI itself was verified by the Chrome test suite on `0dd6669` and by asset and endpoint checks on the running server, not by a human looking at the live page.

## Security and reliability assessment

- No defect requiring a code change was found in #66, in the merged M12 work, or on master during closure.
- Actor identity on the CLI is self-declared (`lead meeting open --accepted-by`, `dismiss-suggestion --by`, `--operator`), as for the rest of the CLI. Acceptance is explicit and recorded, but a process that can run the CLI as the operator can name any actor. This is a limitation of the local single-operator design, not a regression.
- A suggestion write failure is audited and never changes a lifecycle outcome.
- The supervisor's 90-second database lease expires if the machine sleeps; the supervisor then fails closed and keeps its gate for a human to reconcile (seen in the M12 evidence). Correct, but an operator will meet it.
- The `protect-master` ruleset cannot be satisfied by a single-reviewer project; every merge since #61 used the admin bypass. A second reviewer is the proper fix.

## Definition of Done reconciliation

The mission's definition of done, item by item, against evidence. "Pending" means done and verified except for the Director's review and merge.

| # | Requirement | Status | Evidence or reason |
| --- | --- | --- | --- |
| 1 | All accepted project work is in `master` | **Pending** | #66 merged (`bb01119`). #63 (evidence only) and #69 (this report) wait for the Director's review. |
| 2 | No unresolved P0/P1 issues | **Not met** | No open defect found in code. The unmet publication gate (below) is a mandatory `AGENTS.md` gate; it is treated as P1 until the Director rules on it. |
| 3 | All critical acceptance gates have passing evidence | **Not met** | Gates A to D pass. Gate E is partly met: publication and cross-worktree visibility are not. |
| 4 | Full regression and applicable E2E pass | **Met** | 1609/1609 on the tree of `bb01119`; post-merge CI green on `bb01119`. |
| 5 | Operational and architecture docs match reality | **Pending** | README and control-center runbook corrected; #63 README corrected; both ship with #63 and #69. Older dated reports still name `/private/tmp` paths as history. |
| 6 | Mastra :4111 stays the canonical view and is not disrupted | **Met with a recorded interruption** | Replaced by a Director-directed handoff, so there was an interruption: the old server was stopped and the new one started about a minute of tool calls later (exact gap not timed), and two open Chrome connections were dropped. Verified up on the new build. |
| 7 | No unintended background processes, orphaned sessions or dirty worktrees remain | **Not met** | Four orphaned processes from older runs are still running; they are housekeeping and need the operator's authorization. This session's worktrees carry only the untracked `CLAUDE.md` copies the Director asked for. |
| 8 | Final Git and CI state reported accurately | **Pending** | Recorded in the PR #69 closing comment once the merges happen. |

## Execution-data publication gate

**What `AGENTS.md` says.** "Code merge and execution-data publication are separate integration gates. Merging a branch publishes no execution data, and publishing execution data merges no code. Do not delete a worktree's runtime state until its data has been verified as published."

**What it does not say.** It defines no mechanism, tool or evidence format, and nothing else in the repository mentions publication (searched `src`, `scripts`, `docs`, `README.md`). The meaning below is therefore this report's interpretation and is for the Director to confirm or correct.

**Interpretation used.** Publication is making a worktree's execution data (its scheduler database, council databases and run artifacts under its `.workdir`) part of the canonical record that :4111 reads, and verifying that it arrived intact. Evidence that would show a dataset is "verified as published":
1. a source inventory: path, and batch, task and event counts (or a content hash);
2. the same records present in the canonical database or view with matching counts and content;
3. a recorded check, made before any deletion of the source `.workdir`.

**Status: not satisfied.** What exists today, read from the databases (read-only) on 2026-11-07:

| Data | Where | In the canonical view? |
| --- | --- | --- |
| Canonical scheduler | `agentic-engineering/.workdir/scheduler/scheduler.db`: 2 batches (`M5-ESHOP-2A`, `M10-RL`) | yes (this is what :4111 reads) |
| M12 execution | `agentic-engineering-m12-exec/.workdir/scheduler/scheduler.db`: 4 batches, 12 tasks, 4 objectives | **no** |
| Council records | `.workdir/council/council.db` in the `-council`, `-m12-exec`, `-org` and `-phase0` checkouts | **no** |
| Per-run scheduler databases | under the canonical `.workdir`: `m8-final-real` (1), `m8.2-smoke` (5), `m8.5-real` (1) | no (not the database :4111 reads) |

I inventoried only these default locations. I did not assess the value of any database, and other state in other worktrees was not inventoried. The committed export in #63 (`execution.json`, the council records) copies the M12 scheduler records into a document: it preserves the facts if the database is lost, but it is a record, not publication into the canonical view, and nothing verifies that the source was published.

**Consequence.** Until the Director rules on it, this project cannot be marked COMPLETE, and no worktree's `.workdir` that holds unpublished data may be deleted. That constrains the housekeeping below, in particular `agentic-engineering-m12-exec`.

**Decision requested from the Engineering Director (nothing is accepted yet).**
- **Option A, proposed: accepted scope exception.** The project closes without publication tooling, because building it is a new feature and `AGENTS.md` and the mission forbid new scope. If approved, the status becomes "COMPLETE WITH AN APPROVED SCOPE EXCEPTION" and not plain COMPLETE, on these conditions: no deletion of any `.workdir` holding unpublished data; :4111 documented as showing only the canonical database; the #63 export kept; publication carried into the next project as a design requirement. A one-off copy of the M12 rows into the canonical database is not recommended: the M11 headless-preview runbook says isolated runs must not reuse the live :4111 service or the production SQLite ([m11-headless-preview.md](../operations/m11-headless-preview.md)), and copying disposable-repository rows into it would cut against that rule.
- **Option B: close the gate.** The Director names which datasets must be published and how they are verified. This is new work beyond closure and is not started.

## Leftovers: safety blockers versus housekeeping

Checks made read-only on 2026-11-07: no integration guard exists; the model-capacity `leases` and `waiters` tables are empty; the canonical scheduler `locks` table is empty; there is no `supervisor` gate in the canonical `.workdir`.

**Genuine safety blockers found: none.**

| Item | Holds a permit, lock or gate? | Class |
| --- | --- | --- |
| Orphaned processes: PID 7580 (`tests/lead/supervisor/lifecycle.test.ts`, 24 days, idle) and PIDs 25868, 59268, 69540 (`tests/provider-smoke/smoke-server.ts`, loopback only, 13 to 18 days, idle) | no: none of them holds a model permit or a scheduler lock | housekeeping |
| Retained supervisor gate in `agentic-engineering-m12-exec/.workdir/supervisor/holder` (owner PID 52940, not running) and an expired `supervisor:queue` lock in that checkout's database (expired 2026-10-23T11:48Z) | yes, but fail-closed by design; it blocks only a supervisor started on that one workdir, and nothing is in flight there (7 tasks CANCELLED, 5 DONE) | not a closure blocker; a human reconciles it per [integration-ownership.md](../operations/integration-ownership.md) before that workdir is reused. Not removed by this session. |
| 2,095 `m86-*` directories in `$TMPDIR` | no | housekeeping |
| 32 registered worktrees (23 outside `.worktrees/`, 7 prunable) | no | housekeeping, with a data constraint: do not delete a `.workdir` that holds unpublished data (see publication gate) |
| 43 open issues from M7 to M13 | no | housekeeping |

## Open items

### Merge blockers

1. The Director reviews the corrected documentation, then #63 (still a draft; it must be marked ready) and #69 are merged with normal merge commits and the admin bypass of the `protect-master` ruleset (one required review, one reviewer who is also the author). Neither has been merged.

### Mandatory gate needing a decision

2. Execution-data publication: see the [gate](#execution-data-publication-gate). Not satisfied.

### Operator-owned housekeeping (four categories; not authorized, not done)

3. The orphaned processes listed above.
4. The `m86-*` temporary directories.
5. The worktrees: 32 registered. This session created four (`closure`, `pr66`, `pr63`, `studio-master`); `studio-master` hosts the live :4111 Studio and must stay.
6. The 43 stale issues.

### Deferred limitations (do not block)

- **macOS only** (`sandbox-exec`); Linux and Windows are not supported.
- Not a production system and not certified for unattended work on valuable or secret-bearing repositories (README, SECURITY.md).
- Worker quality is not measured: two small, exactly specified objectives were accepted from local Qwen (5 of 5 tasks on the first attempt) after two earlier objectives were cancelled (one Lead planning defect, one restart plus timeout). Roughly 4 to 12 minutes per attempt on a 16 GB Mac. This shows the path works, not a success rate.
- Specialist model review is inconclusive (no tool calls); independent review rests on the Lead's review.
- Verifier steps cancelled by a task timeout are labelled `E_verifier_infrastructure`, which is misleading.
- TypeScript worker, Linux sandbox, paid-provider adapters and later milestones are out of scope.

## Operating instructions

- Setup: `npm ci`, `cp .env.example .env`, Ollama with the configured model.
- Checks: `npm run typecheck`, `npm test` (about 14 minutes), `npm run reliability`.
- Run: `npm run lead -- plan|run|status|review|cancel|resume`; unattended queue: `lead supervisor start --queue` ([m11-headless-preview.md](../operations/m11-headless-preview.md)); providers: `lead providers`; meetings and suggestions: [reliability-lab-and-meetings.md](../operations/reliability-lab-and-meetings.md).
- Studio on :4111 is the canonical read-only view; to replace it, follow the procedure in [:4111 handoff](#4111-handoff-done-verified-2026-11-07). Previews use 4112 and up; new worktrees go under `.worktrees/<session-id>`.
- An orphaned supervisor gate is never removed automatically; follow [integration-ownership.md](../operations/integration-ownership.md).

## New Project Readiness Brief

**Reusable as is**
- The scheduler core: DAG, atomic claim, lease + fencing, audit events, FIFO model capacity, cancellation with confirmed stop.
- The verifier sandbox and mutation policy, the verified-review and integration-with-rollback path, and the pinned-oracle acceptance model.
- The provider-routing and budget design (operator-owned allow-list; no fallback), and the supervisor queue's fail-closed ownership pattern.
- The reliability lab (fault points, scenario classifier) and the append-only, hash-chained collaboration store.

**Reuse rather than rebuild:** the CI split (4-shard PR lane, full post-merge lane), the worktree and port rules in `AGENTS.md`, and the read-only Control Center gateway.

**Do not carry forward**
- Drift between documents and behaviour: stale runbooks, hard-coded `/private/tmp` paths, README evidence that named a long-gone commit.
- Worktrees, ports and processes managed by convention only. Spawned test servers need a teardown owned by the test, and `$TMPDIR` fixtures need cleanup.
- A documented "publication" gate with no tool, and a canonical view that reads a different database from the one work happens in.
- A single reviewer who is also the author, with an admin bypass as the only merge path.
- The sidebar patch applied to a pinned Studio fork (`studio-fork/organization.patch`); it is fragile on upgrade.
- macOS-only sandboxing as the sole isolation layer.
- An issue tracker nobody reconciles.

**Lessons**
1. Decide on day one where authoritative state lives and make the operations view read exactly that.
2. Keep authority in the runtime and treat model output (including a council's) as advice; the cheap local worker succeeded only when the plan was exact, so invest in plan validation, not model size.
3. Make fail closed the default and test the sleep, restart and ownership-loss paths early; they were where the real defects were.
4. Put evidence in committed documents and make every claim name its command and commit.
5. Give the project a second human reviewer, or an explicit documented merge policy, before work is stacked on stacked PRs.

# Project closure report: Agentic Engineering

Written 2026-11-07 by the Engineering Lead. **Status: NOT COMPLETE.** Every number below comes from a command in [Gate evidence](#gate-evidence) or from GitHub state read on the date above. Items that block the label COMPLETE are in [Open items](#open-items), split into three kinds: merge blockers (1 item), operator-owned cleanup (4 items) and deferred limitations (which do not block). The :4111 handoff, once an open item, is done and verified.

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
| **Execution-data publication** (`AGENTS.md` gate) | none | **not implemented** |
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
| E. Operations | **Satisfied for the build now running; see below.** :4111 is the read-only canonical Studio, now on the `bb01119` build, verified by endpoint checks and a write-method refusal. Preview ports and worktrees follow `AGENTS.md`. Not satisfied: execution-data publication (not implemented), and :4111 still reads the canonical `.workdir`, so isolated-state runs such as the M12 evidence are not shown on it. |

## :4111 handoff (done, verified 2026-11-07)

- **Before:** PID 37720 (server) under PID 37718 (`node studio-fork/start.mjs`, detached, parent 1), same user, started 2026-10-24 22:09 from the `studio-sidebar` worktree at `c8e2b94`. It lacked `meeting-suggestions`. Chrome (PID 41216) held two connections to it.
- **Ownership:** same OS user; launched by the repository's own launcher; its originating session no longer exists; no other live agent session (two Codex processes, one Claude) has a working directory or open file in the repository or claims the port or worktree.
- **Procedure:** built `bb01119` in `.worktrees/studio-master` (Control Center assets, Mastra runtime with `--studio`, the unchanged `studio-dist` copied from the old worktree because `studio-fork/` is identical between `c8e2b94` and `bb01119`); proved it on port 4112 (all seven endpoints 200, same objectives as :4111, POST refused with 405); stopped my 4112 preview; sent SIGTERM to launcher 37718 (it forwards the signal; server and launcher exited cleanly, port freed); copied the old isolated Mastra trace storage; started the new launcher on 4111.
- **After:** launcher PID 90403 (parent 1) and server PID 90405, `.worktrees/studio-master`, log `.workdir/studio-4111.log`. `/`, `/organization`, `snapshot`, `council`, `agents`, `meeting-suggestions` and `/api/system/packages` all 200; snapshot lists the same objectives; the served app contains the Suggested Meetings client; POST to the gateway returns 405.
- **Rollback:** the old worktree `.worktrees/studio-sidebar` is untouched; start it with `AGENTIC_SCHED_DB=<canonical scheduler.db> node studio-fork/start.mjs` after stopping launcher 90403.
- **Limit:** the browser UI itself was verified by the Chrome test suite on `0dd6669` and by asset and endpoint checks on the running server, not by a human looking at the live page.

## Security and reliability assessment

- No defect requiring a code change was found in #66, in the merged M12 work, or on master during closure.
- Actor identity on the CLI is self-declared (`lead meeting open --accepted-by`, `dismiss-suggestion --by`, `--operator`), as for the rest of the CLI. Acceptance is explicit and recorded, but a process that can run the CLI as the operator can name any actor. This is a limitation of the local single-operator design, not a regression.
- A suggestion write failure is audited and never changes a lifecycle outcome.
- The supervisor's 90-second database lease expires if the machine sleeps; the supervisor then fails closed and keeps its gate for a human to reconcile (seen in the M12 evidence). Correct, but an operator will meet it.
- The `protect-master` ruleset cannot be satisfied by a single-reviewer project; every merge since #61 used the admin bypass. A second reviewer is the proper fix.

## Open items

### Merge blockers (block COMPLETE)

1. **#63 is verified but not merged.** It is a draft; marking it ready was blocked by the automated permission check because the Engineering Director said "do not merge yet" and set conditions. The conditions are now met: updated against master (`1807a04`, a normal merge), claims rechecked (see its README, "Status at merge"), CI green on `7d4500f`. It needs the Director's go-ahead to mark ready and merge with the admin bypass. Until it merges, this project is NOT COMPLETE; once it does, the only change to this report is flipping the status after a final check.

### Operator-owned cleanup (not authorized, not done; block "no orphaned processes" in the definition of done)

2. **Orphaned processes** from interrupted earlier runs, none started or stopped by closure: PID 7580 (`tests/lead/supervisor/lifecycle.test.ts` in `agentic-engineering-m11`, running 24 days, idle) and PIDs 25868, 59268, 69540 (`tests/provider-smoke/smoke-server.ts`, each listening on a loopback port, 13 to 18 days old, from `.worktrees/pr64` and `.worktrees/pr53`). All were running at the time of writing.
3. **Temporary directories:** 2,095 `m86-*` directories in `$TMPDIR` from interrupted E2E runs.
4. **Worktrees:** 32 registered, 23 of them outside `.worktrees/` and 7 already prunable. `AGENTS.md` says they are not moved or deleted automatically. This session created four (`closure`, `pr66`, `pr63`, `studio-master`); `studio-master` is the live :4111 Studio and must stay, and the others can go once their PRs are merged.
5. **Issue tracker:** 43 issues (M7 to M13, mostly 2026-10-08 to 10-10) are still open although much of that work is merged. They were not reconciled.

### Deferred limitations (do not block)

- **Execution-data publication is an unimplemented capability.** `AGENTS.md` defines it as a gate separate from code merge, but no tool performs it. M12 execution ran on isolated scheduler roots, so :4111 does not show it; the evidence was committed as documents (#63) instead.
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

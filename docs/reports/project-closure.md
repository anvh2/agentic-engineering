# Project closure report: Agentic Engineering

Written 2026-11-07 by the Engineering Lead. **Status: NOT COMPLETE.** Two verified PRs are waiting for a merge decision, and three operator-owned items remain (see [Open items](#open-items)). Nothing below is claimed beyond what was run; every number comes from a command in [Gate evidence](#gate-evidence).

## Architecture and capabilities

One supported execution path ([runtime.md](../architecture/runtime.md)):

`lead CLI → scheduler (SQLite) → executor → Mastra workflow → coding runner → worker → sandboxed verifier → review → integration`

| Capability | Where | State |
| --- | --- | --- |
| Task lifecycle, atomic claim, lease + fencing, recovery | `src/runtime/scheduler` | verified |
| macOS `sandbox-exec` verifier, fail closed, credential isolation | `src/runtime/sandbox`, `tests/smoke-e2e/m87-*` | verified |
| Mutation policy, protected paths, forbidden-mutation audit | `src/runtime/execution`, `src/workers/tools` | verified |
| Review independent of the worker; bounded correction chain | `src/runtime/review`, `src/lead/review.ts` | verified |
| Integration with rollback, oracle acceptance on the integration tip | `src/runtime/integration`, `src/lead/lifecycle` | verified |
| Machine-wide model capacity (FIFO permits) | `src/runtime/capacity` | verified |
| Provider routing with operator allow-list and budgets, no fallback | `src/runtime/execution/provider-routing.ts` (M12, #62) | verified |
| Headless supervisor with objective queue, fails closed | `src/lead/supervisor` (M12, #64) | verified |
| Meeting suggestions (advisory; a person accepts or dismisses) | `src/lead/collaboration/suggestions.ts` (M12, #66) | **verified, not yet on master** |
| Engineering collaboration store, council, Control Center, Studio sidebar | `src/runtime/collaboration`, `src/integrations`, `apps/control-center`, `studio-fork` | verified |
| Languages with a worker | Go, JavaScript (TypeScript adapter disabled pending human approval) | as designed |

## Merged work

Merged into `master`: #43 to #49, #52, #53, #57 to #62, #64, #65, #67, #68. Closed unmerged and superseded: #50, #51, #55, #56. Master at the start of closure: `6db44d9`.

Waiting: **#66** (meeting suggestions; head `0dd6669`, green) and **#63** (M12 evidence, docs only).

## Gate evidence

Node v22.23.2, macOS. "Tip" is the commit tested.

| Gate | Command | Tip | Result |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` | master `6db44d9` | PASS |
| Full regression | `npm test` | master `6db44d9` | PASS 1578/1578 (0 fail, 0 skipped), 13.8 min |
| Typecheck | `npm run typecheck` | #66 merged with master `0dd6669` | PASS |
| Full regression | `npm test` | `0dd6669` | PASS 1609/1609 (0 fail, 0 skipped), 13.2 min |
| Targeted: collaboration, lifecycle, supervisor, control-center | `node --test src/lead/collaboration src/lead/lifecycle src/lead/supervisor src/integrations/control-center apps/control-center/src` | `0dd6669` | PASS 203/203 |
| Control Center app | `npm run typecheck`, `npm run build`, `npm run test --prefix apps/control-center` | `0dd6669` | PASS (53 + 17 tests) |
| Control Center browser (installed Chrome) | `npm run test:ui --prefix apps/control-center` | `0dd6669` | PASS 5/5, including Suggested Meetings; no Chrome left running |
| Reliability lab | `npm run reliability -- --scenario all --repeat 2 --concurrency 2` | master `6db44d9` | PASS 14/14 across 7 scenarios (timeouts, cancel, lease isolation, stale lease, interrupted run) |
| CI on the PR head | `CI` workflow | `0dd6669` | PASS (typecheck + 4 shards) |
| CI after merge | `Post-merge smoke and E2E` | master `6db44d9` | PASS |

Smoke and E2E on disposable repositories (`tests/smoke-e2e`: `m85-objective`, `m86-recovery`, `m87-credential-isolation`, `m8final-objective`) are part of `npm test` and passed in both full runs. Real-provider smokes are opt-in and were **not** run: no paid provider was called, and Ollama was not running during closure.

A normal full run leaves no processes behind (checked before and after).

## Acceptance gates

| Gate | Assessment |
| --- | --- |
| A. Execution correctness | Transitions are enforced in one function (`SchedulerStore.transition`); a worker PASS ends at `REVIEW_PENDING`, only a recorded decision reaches `APPROVED`, only verified integration reaches `DONE`. Covered by the scheduler, lifecycle and E2E suites. |
| B. Security and mutation boundaries | Sandbox fails closed with no opt-out; credential isolation, forbidden-mutation and protected-path tests pass; providers are denied unless the operator allows them, and a budget is required for any non-free provider. |
| C. Supervisor and recovery | Read independently (`src/lead/supervisor/cli.ts`): every exit other than verified normal completion keeps the gate, the leadership lock and the objective claims for a human; ownership is re-asserted after each lifecycle run; one objective runs under one supervisor. Queue, restart and ownership-loss tests pass; `m86-recovery` and the reliability lab pass. |
| D. Review and acceptance | Meeting suggestions record no meeting and open no session; security, authorization, budget, cancellation and dirty-tree stops are classified `operator`/`none` and never suggested; acceptance writes the meeting and the decision in one transaction; the table is append-only with database triggers and a CHECK tying status to decision. |
| E. Operations | :4111 was only read, never changed (see below). Preview ports and worktrees follow `AGENTS.md`. |

## Security and reliability assessment

- No defect requiring a code change was found in #66, in the merged M12 work, or on master during closure.
- Actor identity on the CLI is self-declared (`lead meeting open --accepted-by`, `dismiss-suggestion --by`, `--operator`), as for the rest of the CLI. Acceptance is explicit and recorded, but a process that can run the CLI as the operator can name any actor. This is a limitation of local single-operator design, not a regression.
- A suggestion write failure is audited and never changes a lifecycle outcome.
- The supervisor's 90-second database lease expires if the machine sleeps; the supervisor then fails closed and keeps its gate for a human to reconcile (observed in the M12 evidence). Correct, but an operator will meet it.

## Known limitations and deferred items

- **macOS only** (`sandbox-exec`); Linux and Windows are not supported.
- Not a production system and not certified for unattended work on valuable or secret-bearing repositories (README, SECURITY.md).
- **Execution-data publication has no tooling.** `AGENTS.md` makes it a separate gate from code merge, but nothing automates it. M12 execution ran on isolated scheduler roots, so :4111, which reads the canonical `.workdir`, does not show it. The evidence was committed as documents instead (#63). Deferred.
- Worker quality: two small, exactly specified objectives were accepted from local Qwen (5 of 5 tasks on the first attempt) after two earlier objectives were cancelled (one Lead planning defect, one restart and timeout). This shows the path works, not a success rate. qwen3:8b needs 4 to 12 minutes per attempt on a 16 GB Mac.
- Specialist model review is inconclusive (no tool calls); independent review rests on the Lead's review and the required code-owner review.
- Verifier steps cancelled by a task timeout are labelled `E_verifier_infrastructure`, which is misleading. Deferred.
- TypeScript worker, Linux sandbox, paid-provider adapters and M14 and later work are out of scope.

## Open items

These block the label COMPLETE.

1. **Merge #66** (verified; the `protect-master` ruleset requires one approving review and the repository has one reviewer, who is also the PR author). The only available path is the admin bypass (`gh pr merge --merge --admin`), which the automated permission check denied. It needs the owner's explicit go-ahead or an approving review. No squash or rebase.
2. **Merge #63** (docs only, no secrets or host identity found; same ruleset).
3. **Orphaned processes from interrupted earlier runs**, none started by closure and none stopped by it (`AGENTS.md` forbids terminating another session's process):
   - PID 7580: `tests/lead/supervisor/lifecycle.test.ts` running since 2026-10-13 in `agentic-engineering-m11` (idle, 0.1% CPU; stuck for 24 days).
   - PIDs 25868, 59268, 69540: `tests/provider-smoke/smoke-server.ts` servers from `.worktrees/pr64` and `.worktrees/pr53`, each listening on a loopback port, started 2026-10-19 to 2026-10-24, cwd in `$TMPDIR/m86-*`.
   - About 2,000 `m86-*` directories in `$TMPDIR` from interrupted E2E runs.
   Suggested owner action: `kill 7580 25868 59268 69540` after confirming they are not in use.
4. **:4111 is a 13-day-old build** (PID 37720, `.worktrees/studio-sidebar` at `c8e2b94`), reading the canonical scheduler database. It has the council and agents endpoints but not `meeting-suggestions`. After #66 merges it needs an owner-controlled handoff: build from master, start on a free port from 4112, verify, then replace. Closure did not touch it.
5. Existing worktrees outside `.worktrees/` (more than 20 under `/Users/anvh/go/src/github.com/anvh2/` and `/private/tmp`, several already prunable) were not moved or deleted, per `AGENTS.md`.

## Operating instructions

- Setup: `npm ci`, `cp .env.example .env`, Ollama with the configured model.
- Checks: `npm run typecheck`, `npm test` (about 14 minutes), `npm run reliability`.
- Run: `npm run lead -- plan|run|status|review|cancel|resume`; unattended queue: `lead supervisor start --queue` ([m11-headless-preview.md](../operations/m11-headless-preview.md)); providers: `lead providers`; meetings and suggestions: [reliability-lab-and-meetings.md](../operations/reliability-lab-and-meetings.md).
- Studio on :4111 is the canonical read-only view; previews use 4112 and up; new worktrees go under `.worktrees/<session-id>`.
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

**Lessons**
1. Decide on day one where authoritative state lives and make the operations view read exactly that.
2. Keep authority in the runtime and treat model output (including a council's) as advice; the cheap local worker succeeded only when the plan was exact, so invest in plan validation, not model size.
3. Make fail closed the default and test the sleep, restart and ownership-loss paths early; they were where the real defects were.
4. Put evidence in committed documents and make every claim name its command and commit.
5. Give the project a second human reviewer, or an explicit documented merge policy, before work is stacked on stacked PRs.

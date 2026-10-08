# M8 Phase 1: handoff to the execution session

Status: **M8_PHASE1_PREP_READY**. The billed Claude planning call and the Qwen team run have NOT been executed.

## 1. Commits and test results

| Commit | What |
| --- | --- |
| `ce45ff1` | Session A: M7 multi-worker scheduling, FIFO model permits, queue-vs-execution timeouts (its clean checkout: typecheck + 475/475) |
| `c308758` | M7.5 objective planning + M8 phase 1 preparation (this work) on top of `ce45ff1` |
| (this file) | handoff document, committed on top of `c308758` (`git log -3`) |

Branch `recovery/2026-10-03`. Nothing pushed; there is no git remote configured.

| Check | Result |
| --- | --- |
| Combined working tree (`npm run typecheck`, `npm test`) | typecheck clean, **571 / 571** pass |
| Clean checkout of `c308758` (git worktree, no untracked files) | typecheck clean, **562 / 562** pass |
| Difference | 9 tests in the untracked `tests/evaluation/` (M7.6 session, not committed, not mine) |

## 2. Completed fixes (all in `c308758`)

1. **Whitespace review gate** (`src/runtime/review/whitespace-changes.ts`, used by `change-review.ts`). Whitespace-only lines are classified instead of counted: a pure re-indent (same text, one uniform indentation shift, i.e. code moved into/out of a block) next to a real change is allowed with a `whitespace_reindent` warning; unrelated or non-uniform reformatting, line-ending rewrites, files whose only change is whitespace and more than 3 stray spacing edits stay blocked (`whitespace_only_change`). Scope, EOF-newline, security and comment-removal checks are unchanged. The real `slug` diff that was wrongly escalated now passes. Tests: `change-review.test.ts`.
2. **Bounded lease-expiry refunds** (`store.ts`, `MAX_LEASE_REFUNDS = 3`). The first three lease expiries per task give the claim back (`artifacts.leaseExpiries`); later expiries spend claims, so a task that keeps losing its lease still ends in `RUNTIME_FAILURE`. `scheduler_extra_claims` still counts refunded expiries. The fencing epoch still advances.
3. **Audited recovery**: `lead recover <task> --reason "..." [--grant N | --escalate]` (`SchedulerStore.grantClaims`, `src/lead/recovery.ts`). Mandatory reason; recorded in the task event log and `artifacts.recoveries`; releases dependents the failure had blocked; hard cap 10 claims.
4. **Scheduler**: `inflight` is keyed by `task@epoch` (a requeue inside one `run()` no longer ends it with work in flight) and the run summary de-duplicates re-claimed tasks (`requeue-in-run.test.ts`).
5. **Billed Lead gate**: `--lead claude` requires `--max-budget-usd` (<= 5), revisions default to 0 (opt-in, <= 2), and the worst case is printed before the first call.
6. M7.5 planning layer (`src/lead/objective/`): research, validation, `--submit` with the `STALE_PLAN` gate, task ids namespaced `<objective>.<task>`, `ClaudeEngineeringLead` behind the `EngineeringLead` interface.

Assertions that assumed a lease expiry spends a claim were updated (they now test the refund AND the spent budget): `store.test.ts`, `scheduler.test.ts`, `multi-worker.test.ts`, `failure-injection.test.ts`, `capacity-timeout.test.ts`.

The model-capacity "handoff overlap" seen in the textkit run is explained: the host went to clamshell sleep at 2026-10-08 00:18:30 (~15 min), the holder's 60 s permit lease expired and the next waiter reclaimed it. Session A's FIFO tests already cover lease fencing (`model-capacity-fifo.test.ts`).

## 3. Remaining limitations

- **The billed experiment is untested against real Claude.** `claudeCliTransport` has only been exercised against a stand-in executable. One attempt from inside Claude Code was refused locally by the claude CLI ("cannot be launched inside another Claude Code session"), at zero cost. It must run from an external terminal.
- **What bounds the spend (honest status):** the number of calls is enforced by this repo (exactly one `claude -p` spawn; revisions 0; tested). The per-call cap is `--max-budget-usd 1`, which this repo only *passes*; enforcement is the claude CLI's, and I did not verify it (that would require spending). Internal HTTP retries inside the CLI are not controlled by this repo. The model is the alias `sonnet` (not a pinned version). If the CLI is logged in with a subscription rather than an API key, the dollar cap may not apply the way it does for API billing. My estimate is $0.05-0.25 for the call (prompt about 2.4k tokens, `evidence/prompt.txt`).
- A host sleep invalidates a run as evidence (leases and permits expire). Wrap long runs in `caffeinate -dimsu` and check `pmset -g log` for the window; reject the run if it slept.
- qwen3:8b is slow (270-1070 s per task) and drops package doc comments (3 of 3 earlier diffs, reported as a `comment_removed` warning).
- Un-blocking dependents propagates one level per `promote` pass; `lead tasks` can briefly show a stale `BLOCKED`.
- No autonomous plan -> submit -> run loop; every step stays explicit. No automated review/repair loop.
- `.gitignore` currently contains `docs/audits/*` (a change that is **not mine** and is uncommitted), so everything under `docs/audits/` is ignored by git, including `docs/audits/2026-10-08-m7-m75-integration/` (the integration report and evidence) and `docs/audits/2026-10-07-m7-multi-worker/collect-timeline.mjs`. They exist locally only.
- `tests/evaluation/` (M7.6) is untracked and uncommitted.

## 4. Fixture, oracle and what is immutable

| Item | Path | Notes |
| --- | --- | --- |
| Disposable fixture repo | `.workdir/m8-phase1/repo` | Go module `example.com/fmtkit`, one commit `3f84f30c15d1f7225fc0fd27b889fa715c108066` (stubs + visible tests), clean tree |
| Objective | `.workdir/m8-phase1/objective.json` | read-only; sha256 `9b9cc6de1b73fbf0a69deeff35cf4b4f812ca4d76bca2ff4d498e7456b7ab1f8` |
| **Independent oracle** | `.workdir/m8-phase1/oracle/acceptance_test.go` | read-only; sha256 `cf8e465b546293e0312a8e0e49a356c4c8c56804ceaa7afc7da98de8ad457a08`; passes against a reference implementation, fails on the untouched stubs |
| Acceptance runner | `.workdir/m8-phase1/accept.sh` | read-only; exports a ref of the fixture repo, adds the oracle, runs `go vet` and `go test` under the OS sandbox |
| Scheduler state for this experiment | `.workdir/m8-phase1/state` (`AGENTIC_SCHED_ROOT`) | holds `objectives/`, later `scheduler/` and `worktrees/` |
| Evidence | `.workdir/m8-phase1/evidence/` | `prompt.txt` (dry-run Lead prompt), the refused-attempt note |

Separation: the oracle lives next to the repo, not in it (`find repo -name acceptance_test.go` is empty). It is not in the Lead's prompt (the only "oracle" in the prompt is generic policy text), the Lead runs from an empty scratch directory with all tools disabled, and the workers never see it. The hashes above must still match before acceptance; do not edit these files for this experiment.

## 5. Commands

Run everything from `cd /Users/anvh/go/src/github.com/anvh2/agentic-engineering`.

**Planning (external terminal, NOT inside Claude Code; one billed call):**

```sh
cd /Users/anvh/go/src/github.com/anvh2/agentic-engineering && AGENTIC_SCHED_ROOT=$PWD/.workdir/m8-phase1/state caffeinate -dimsu npm run lead -- objective .workdir/m8-phase1/objective.json --lead claude --max-budget-usd 1 --model sonnet
```

Limits: 1 Claude call, 0 automatic revisions, `--max-budget-usd 1` per call (CLI-enforced, see section 3), model alias `sonnet`, tools disabled, scratch working directory. The command prints `BILLED: at most 1 Claude call(s) ... worst case $1.00` before calling. Exit codes: 0 plan valid, 1 plan rejected (no retry), 2 error. A rejected plan is not retried at your expense; re-run only with fresh approval.

**Inspect, then submit (no model, executes nothing):**

```sh
export AGENTIC_SCHED_ROOT=$PWD/.workdir/m8-phase1/state
npm run lead -- objective --show fmtkit-describe        # readiness, findings, task levels, warnings
npm run lead -- objective --submit fmtkit-describe      # STALE_PLAN gate (HEAD must equal plan.baseCommit); queues the batch
npm run lead -- tasks --batch fmtkit-describe
```

**Team execution (restart the servers first, section 6):**

```sh
AGENTIC_WORKER_CONCURRENCY=3 caffeinate -dimsu npm run lead:run -- --batch fmtkit-describe
npm run lead -- review show <task>                      # then: review decide <task> approve|reject|escalate --feedback "..."
npm run lead -- integrate fmtkit-describe               # then lead:run again for dependents
npm run lead -- recover <task> --reason "..." [--grant N | --escalate]   # exhausted RUNTIME_FAILURE
npm run lead -- claude take|start|done <task> ...       # Lead takes over an ESCALATED task
```

**Independent acceptance (after the batch is integrated):**

```sh
.workdir/m8-phase1/accept.sh lead-integration/fmtkit-describe     # ACCEPTED / NOT ACCEPTED; exit 0 / 1
.workdir/m8-phase1/accept.sh main                                  # negative control: must say NOT ACCEPTED
```

`accept.sh` (kept here because `.workdir` is not versioned):

```sh
#!/bin/sh
set -e
P=/Users/anvh/go/src/github.com/anvh2/agentic-engineering
FIX=$P/.workdir/m8-phase1
ACC=$(mktemp -d "${TMPDIR:-/tmp}/fmtkit-accept.XXXXXX")
git -C "$FIX/repo" archive "$1" | tar -x -C "$ACC"
cp "$FIX/oracle/acceptance_test.go" "$ACC/acceptance_test.go"
cd "$P" && node --disable-warning=ExperimentalWarning -e "
import('./src/runtime/sandbox/sandbox.ts').then(async ({runSandboxedCommand}) => {
  let ok = true;
  for (const args of [['vet','./...'],['test','-count=1','./...']]) {
    const r = await runSandboxedCommand('go', args, { cwd: '$ACC', root: '$ACC', timeoutMs: 180000 });
    console.log('go ' + args.join(' ') + ' -> exit ' + r.exitCode + (r.timedOut ? ' (timeout)' : ''));
    if (r.exitCode !== 0) { ok = false; console.log((r.stdout + r.stderr).split('\n').slice(-12).join('\n')); }
  }
  console.log(ok ? 'ACCEPTED' : 'NOT ACCEPTED');
  process.exitCode = ok ? 0 : 1;
});"
rm -rf "$ACC"
```

**Reporting:**

```sh
node docs/audits/2026-10-07-m7-multi-worker/collect-timeline.mjs $AGENTIC_SCHED_ROOT/scheduler/scheduler.db fmtkit-describe .workdir/m8-phase1/evidence/timeline.json   # local-only script (docs/audits is ignored)
pmset -g log | grep -E "Sleep|Wake" | grep "2026-10-08 HH"     # replace HH: any sleep inside the run window invalidates it
```

Report: the plan (`objectives/fmtkit-describe/plan.json`, revisions count), the Lead's call and cost as shown by the claude CLI, the DAG/ownership, per-task outcomes and interventions, the acceptance result, and the verdict `M8_PHASE1_VERIFIED` / `M8_PHASE1_NOT_VERIFIED`. "Accepted" means the independent oracle passed, not that the scheduler says `DONE`.

## 6. Server restart requirements

`ce45ff1` made model permits FIFO (a `waiters` table in `~/.agentic-engineering/model-capacity.db`). A pre-FIFO server on the same capacity database still honours the permit count but ignores the queue. At handoff time `mastra dev` (pid 20367, started 2026-10-07 23:37) and its child server were running from earlier code, and the live capacity database did not yet have the `waiters` table. Before the Qwen run:

1. Stop the running `mastra dev` / `.mastra/output/index.mjs` processes (`pkill -f "mastra dev"`, then confirm port 4111 is free).
2. Start a fresh `npm run dev` in its own terminal and wait for `http://localhost:4111`.
3. Ollama must be up with `qwen3:8b-ctx8192` (`curl localhost:11434/api/tags`).
4. After the first run, `sqlite3 ~/.agentic-engineering/model-capacity.db ".tables"` should list `waiters`.

## 7. Forbidden actions and safety boundaries

- Never launch a nested Claude Code session and never unset `CLAUDECODE` to get around the guard. The billed call is run by the human from an external terminal.
- At most **one** billed Claude call for this experiment, capped at $1.00. No retry, no `--max-revisions`, no higher budget without new approval.
- Do not edit, move or expose the oracle, the objective or `accept.sh`; never put the oracle in the Lead's prompt or in the repository.
- Planning is read-only and executes nothing. Submit is explicit. Only `lead run` executes. Do not add auto-submit.
- Model-generated code runs only through the sandbox (fails closed); acceptance also runs through it.
- Do not push, do not touch `main` of the fixture's integration flow beyond the scheduler's own `lead-integration/*` branches, do not modify eShop or Telegram, no new infrastructure.
- Concurrent sessions share this checkout: never `git add .` or `git reset --hard`; stage explicit paths. `.gitignore` (the `docs/audits/*` line) and `tests/evaluation/` belong to other sessions.
- Do not rely on a run during which the host slept.

## 8. Outstanding issue references

None known. No git remote is configured and no issue numbers are recorded in the repository. Items to file when a tracker exists: whitespace-gate policy follow-ups, `docs/audits/*` ignore rule hiding audit reports, 3-of-3 package-comment drops by workers, one-level-per-pass dependent unblocking, unverified CLI budget enforcement.

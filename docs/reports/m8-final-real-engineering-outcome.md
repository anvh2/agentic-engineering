# M8 final: first valuable real engineering objective

**Verdict: `M8_REAL_OBJECTIVE_ACCEPTED`.** This is one bounded objective, run once. The real `gpt-6.1-sol` Codex worker produced the business logic of a reusable Go component, `affiliate-video-economics`, through the existing scheduler, Mastra HTTP, verified review and integration path, under the M8.7A/M8.7B isolation profiles. The pinned independent oracle passes on the integrated tip and fails on the base. **This is not a claim of production readiness** (section 11).

Run: 2026-10-10 06:44:51Z → 06:46:32Z. Evidence is in `.workdir/m8-final-real/2026-10-10T06-44-51-787Z/` (git-ignored; hashes in section 10). Nothing was pushed. No Claude, Gemini or Qwen inference was used by the run.

## 1. Gates before execution

| Gate | Result |
| --- | --- |
| Credential canary safety (gate 1) | Canary code writes only random synthetic markers (the `auth.json` in a canary home is synthetic) and never reads or copies the real Codex store. A hash-only scan of the home and temp directories found **0** `auth.json` files outside the real store; the real store is unchanged (mtime 2026-10-08, before this work). The real defect was a teardown race: the Codex launcher's background workers kept writing into the canary home, so `rm -r` failed with ENOTEMPTY and left the directory. Fixed (section 7). An earlier status message of mine called the leftover file "a copy of the real auth.json"; that was an unverified inference from its name and was wrong. |
| Full regression (gate 2) | The authorized single run on the final tree gave **885 / 885 pass**, 0 fail (790 s, `npm test` exit 0). A previous run on the pre-fix tree gave 882/885 (a bug in my new cleanup test, an intermittent M8.7A control-mode canary, a load-sensitive Gemini timeout test). It was reported and the decision was escalated; the suite was not rerun until green. |
| Commit and pins (gate 3) | Harness commit **`6db36be6c0a5`** (owned files only; `.gitignore`, `docs/architecture/components.md` and `tests/evaluation/` excluded and untouched). Oracle `acceptance_test.go` SHA-256 `aa2cbc8c…31f8`. Task-test hashes `526a8008…a7e7` (A) and `ec7aadc6…eea1` (B). |
| Model | `gpt-6.1-sol`, chosen by the Chief Architect from the account's live catalog (`codex debug models`, a catalog listing with no inference). The previously proposed `gpt-5.3-codex` was in neither the bundled nor the live catalog and was not used. No probe call was made. |
| Runner preflight (in-process, before any claim) | Codex CLI 0.161.0, signed in. Explicit model pin present. Project outside `/tmp`. No credential shapes in the fixture. Go toolchain runs in the OS sandbox. **Worker read-isolation canary** and **verifier sandbox canary** both passed against the real binary with a local stub model, and the dedicated Mastra server re-ran the isolation canary before accepting work. |

## 2. Objective, scope and authorship

Go module `example.com/videoeconomics`, fixture base `4fc5e3482868`. All money is integer micro-USD, with no floating point anywhere in production code (the oracle checks this on the AST).

| Task | Worker file | Implemented by Codex | Depends on |
| --- | --- | --- | --- |
| A `m8f-accounting` | `accounting/accounting.go` | `Ledger.Record` (validation, already-accepted rule, retry ceiling) and `Ledger.Summary` (sums of known components, unknown-cost counting, rejected spend, the three exact ratios) | none |
| B `m8f-budget` | `budget/budget.go` | `Evaluate` (exact integer verdict chain: no accepted, minimum sample, over ceiling including a lower-bound proof, incomplete cost, within; separate preferred-range report; hard-ceiling flag) and `EvaluateForecast` | A, integrated |

**Pre-supplied by the harness author (Claude, Engineering Lead), not written by Codex:** `accounting/types.go` (`Amount` with `Known`/`Unknown`/`Micros`, `Ratio` with `Defined`/`RoundHalfUp`, `Outcome`, `Attempt`, `Config`, the `Ledger` struct and `NewLedger`, the error variables, the `Summary` struct) and `budget/types.go` (business constants, enums, reason codes, `Policy`, `Result`, and `newResult`, which validates the policy and applies defaults). Both are byte-identical at the tip and the base. The stubs, hidden task tests, oracle and reference solution were also written by the harness author. **Only the bodies of `Ledger.Record`, `Ledger.Summary`, `Evaluate` and `EvaluateForecast` (the worker diffs in section 5: +43/−2 and +58/−2) are attributed to Codex.**

Why the split: a fake-CLI rehearsal showed that the existing review gate (a) flags more than 80 changed lines as a repairable warning, which would stop a run that may not repair, and (b) truncates `git show`/`git diff` output at 4000 bytes, so a stub larger than that gets a false `eof_newline` block. The gate was not loosened; the fixture was shaped to fit it.

Business constants are targets, not observed prices: hard ceiling USD 0.50 per accepted video, preferred range USD 0.25–0.35. No model pricing or acceptance statistics are invented anywhere.

## 3. Execution path (actual)

```
pinned objective (oracle b4558523a942 pinned 06:45:03.315, before the first claim)
 -> Scheduler (allow-list codex:m8f-accounting, codex:m8f-budget)
 -> createMastraExecutor --HTTP--> dedicated Mastra server pid 94562 (:56525, own storage, own capacity db)
 -> coding-task-workflow -> Codex CLI (codex exec --model gpt-6.1-sol, allow-list read isolation) -> worktree
 -> runtime verifier (sandboxed go test) -> REVIEW_PENDING -> verified review -> APPROVED -> integrateBatch
 -> [B unblocked only now] -> same path for B -> pinned oracle on tip and base -> ACCEPTED
```

| Task | Mastra run id | Claim epoch / owner | Claims | Coding attempts | Runtime retries |
| --- | --- | --- | --- | --- | --- |
| m8f-accounting | `43a448a9-1440-44a9-8282-9c5da9573064` | 1 / worker-93204-w1 | 1 | 1 | 0 |
| m8f-budget | `08f9305e-516c-45f4-892e-5f4c972837a1` | 1 / worker-93204-w1 | 1 | 1 | 0 |

Transitions (UTC):

| | Claimed | Review pending | Approved | Integrated (DONE) |
| --- | --- | --- | --- | --- |
| A | 06:45:03.319 | 06:45:31.809 | 06:45:34.936 | 06:45:40.710 |
| B | 06:45:40.712 (READY at 06:45:40.711, set by the integrator) | 06:46:10.702 | 06:46:14.152 | 06:46:19.955 |

B became READY only when A's integration finished, and B's worktree base is A's integrated commit (`628b2debe6`).

## 4. Invocations, model, time, usage

- **Codex invocations: 2 allowed, 0 refused** (server ledger: `invocation allowed` → `spawn` 95997 at 06:45:03.9; again → `spawn` 97951 at 06:45:41.4). One per task worktree. All limits were runtime-enforced: the server-wide budget is counted before spawn (≤ 2, ≤ 1 per worktree), `maxClaims: 1`, `maxRuntimeRetries: 0`, one allow-listed provider, a 300 s call deadline, a 420 s scheduler task timeout, and no repair authorization.
- **Invocation ledger** (`server/provider-ledger.jsonl`, verbatim; worktree paths are relative to the run directory):

  ```
  {"event":"invocation","n":1,"max":2,"perWorkdirMax":1,"workdir":"worktrees/m8f-video-economics/m8f-accounting","allowed":true,"at":"2026-10-10T06:45:03.710Z","serverPid":94562}
  {"event":"spawn","pid":95997,"at":"2026-10-10T06:45:03.948Z","serverPid":94562}
  {"event":"invocation","n":2,"max":2,"perWorkdirMax":1,"workdir":"worktrees/m8f-video-economics/m8f-budget","allowed":true,"at":"2026-10-10T06:45:41.124Z","serverPid":94562}
  {"event":"spawn","pid":97951,"at":"2026-10-10T06:45:41.359Z","serverPid":94562}
  ```

- **Model:** `gpt-6.1-sol`, passed to the CLI as `--model gpt-6.1-sol`. The CLI's JSON events do not echo the model that served the request, so the served model identity is "as requested", not independently confirmed. The CLI accepted it; no error.
- **Tokens (reported by the CLI):** A 30,283 in / 748 out; B 34,303 in / 844 out; total 64,586 / 1,592. **Cost: UNKNOWN** (the CLI does not report it). Quota: UNKNOWN.
- **Time:** inference A 24.7 s, B 25.7 s. Active (claim → review) A 28.5 s, B 30.0 s. Whole lifecycle 88.6 s. The 300 s and 420 s limits were never approached.

## 5. Review decisions

Both **APPROVE** with no reasons and no warnings. All 8 evidence checks passed for each:
- the review request names the reviewed commit;
- the result was written under the current claim epoch (1);
- the run id is recorded on the task;
- 4 artifacts were hashed;
- the reviewed commit is the branch tip and descends from the task base;
- only the allowed file changed;
- an independent re-run of the task verifier on the exported commit passed.

The worker's self-report was recorded, not relied on. Verdict hashes: `c11bcfe16052…` (A), `6e75680afda7…` (B).

Worker diffs: A +43/−2 (45 changed lines), B +58/−2 (60), both under the 80-line gate. No float types or float literals. Nothing was edited or approved by hand.

## 6. Integration and oracle

`lead-integration/m8f-video-economics` (first parent):

```
48be13dfd360 tests: oracle for m8f-budget                                  <- tip, accepted tree 5a2fa281c6e3
5120a391ac58 integrate m8f-budget: Implement Evaluate and EvaluateForecast  (worker head a2e2b530d8cd)
628b2debe6c9 tests: oracle for m8f-accounting
16b8e8f46d16 integrate m8f-accounting: Implement Ledger.Record and Ledger.Summary  (worker head cce14ca64609)
4fc5e3482868 fixture: videoeconomics stubs                                 <- base = main, unchanged
```

| Oracle run | Commit | `go vet` | `go test -count=1 ./...` | Result |
| --- | --- | --- | --- | --- |
| Negative control | base `4fc5e3482868` | 0 | **1** (`TestAccounting_MultiAttemptAcceptedAndRejectedSpend`: `panic: TODO` in `Ledger.Record`) | FAIL, as required |
| Candidate | tip `48be13dfd360` | 0 | **0** (all three packages ok) | PASS |

I verified this again by hand, outside the harness: the oracle file on disk hashes to the pin; the tip and base equal the repository's `refs/heads/lead-integration/…` and `refs/lead/base/…`; the oracle exits 0 on a `git archive` of the tip and 1 on the base. The oracle covers:
- multi-attempt accepted videos and rejected spend;
- missing versus zero cost, and zero accepted videos;
- invalid and negative inputs, and retry ceilings;
- half-up rounding and exact precision;
- threshold and boundary values, including the rounded-average trap (500,000.33 must be OVER_BUDGET);
- preferred range reported separately, operator per-pipeline ceilings, and minimum sample;
- the forecast-versus-measured basis, the JSON result contract;
- B importing A without duplicating its types, and no floating point.

Before pinning, the oracle was also checked against a reference solution (pass) and 13 deliberately wrong implementations (all killed). It was never changed after the pin.

## 7. Harness changes in `6db36be`

- `tests/provider-smoke/m8final/` (stubs, hidden task tests, oracle, and a reference solution used only for oracle validation and the fake-CLI rehearsal), `m8final-objective.ts`, `run-m8-final-objective.ts` (opt-in; requires an explicit `AGENTIC_CODEX_MODEL` and CLI 0.161.0), `fake-codex-m8final.mjs`, `m8final-objective.test.ts` (9 tests: the oracle's positive and negative controls, gates, and four fake-CLI paths: accepted, oracle-fail = FAILED, verifier-fail = no 2nd call and no repair, fixture unreadable to verifier-run code).
- `m85-objective.ts`: runner generic over an `ObjectiveDefinition`; the wordstat default is unchanged and its tests still pass.
- Canary cleanup (`canary-fs.ts`, `read-isolation-canary.ts`, `canary-cleanup.test.ts`):
  - the launcher runs in its own process group, which is killed before cleanup (EPERM from a group of unreaped zombies counts as gone);
  - temp dirs carry an owner marker, and removal refuses symlinks, foreign paths and replaced markers;
  - removal retries, with exit and SIGINT/SIGTERM hooks and a sweep of dead owners' leftovers;
  - a hash-only detector flags copies of the real Codex login (it hashes the real file in memory and never prints it).
  - No isolation profile, deny or allow path, or canary assertion was changed; `m87-credential-isolation.test.ts` and the sandbox tests are untouched.
- `src/runtime/sandbox/sandbox.ts`: temp-dir cleanup retries and never throws. Before, a stray background write (Go telemetry) could turn a finished verifier or oracle command into an exception. Confinement is unchanged; the 42 sandbox tests pass.

## 8. Cleanup and integrity

- The dedicated Mastra server (pid 94562) exited with code 0. Both Codex process groups are gone. No model permit is held, and the Codex permit could be taken afterwards (own capacity db). No `smoke-server` or `codex exec` processes remain.
- Disposable repo: `main` and HEAD are unchanged; pre-existing refs are unchanged; only `lead-task/*`, `lead-integration/*` and `refs/lead/base/*` refs were added; `git fsck` is clean.
- No canary directories remain under the home directory. There are 0 `auth.json` copies outside the real store, which is unchanged.
- agentic-engineering: only this report was added after the harness commit. The pre-existing `.gitignore`, `docs/architecture/components.md` and `tests/evaluation/` were untouched. No push. eShop was read (one file, for M9), not modified.
- Other sessions: the `mastra dev` server pid 15439 is still running and was not touched. A second foreign process seen earlier in the session (pid 20158, `.mastra/output/index.mjs`) was no longer running when checked after the run. This run signals only process groups it spawned (the ledger lists 95997, 97951 and server 94562; the run log has no other signal), so I attribute its exit to its owner. I did not observe when it stopped.

## 9. Human interventions

**None during the run** (start → verdict). Before the run, as recorded above: building the harness, shaping the fixture to the review gate, the canary and sandbox cleanup fixes, and two Chief Architect decisions (gate 2 rerun authorization, model change to `gpt-6.1-sol`).

## 10. Evidence hashes (SHA-256)

```
aa2cbc8cb0ad0deb9b63c73991721327d1756185bdb4e2a40dd13413520331f8  oracle acceptance_test.go (pinned = on disk = in acceptance)
b4558523a942872a0efdc79ebab692facba775c8a2c801da9a2eb443a3757609  oracle spec hash
cc627d83994c0b89d5ee1156085f39d1555d760038fc8af43c21eb26cc638b33  acceptance criteria
526a800814972c6a98ab1c760ec4846d407d5c195f547b2e48c1002604eda7e7  task test A
ec7aadc674a928ad3acf91057eddeba26b7935f1b52db06e586bc3115192eea1  task test B
9b574bb34cd9a4e8a3a0c3c17e26f2db6f4066d14a2ea5fd169124ad0e02b0e3  candidate run evidence
9b25a142ed0626512117e6180d5488031cab8dbe1d5575e887ad014d2ee86a03  negative-control run evidence
6efa89ef760df7e495d53f84cf8d90d33d43db86595125c6a65f6abf20753a09  acceptance evidence
c3acc2f71eb7bd36827fcfd4b53c08eceec6de228a5c2bf7ad681cd1705b5a37  report.json
77aaa7039c726e8dc0a831d7105ca4a25f9156b6e91d89762922da7ab14686de  pinned/pinned-objective.json
4a91af2217737f478e19f19256e21840d4000449b828eaaea57bd2f29a77eb40  server/provider-ledger.jsonl
0170e19b3a3edb67525e6698d61484f120e8e86ce1e12f788c89c565c3a6f6f9  objective/lifecycle-verdict-m8f-video-economics.json
```

The run directory (`.workdir/m8-final-real/2026-10-10T06-44-51-787Z/`: disposable repository with all refs, scheduler and capacity databases, worktrees, per-task artifacts and traces, server ledger, pinned material) and the oracle directory beside it (`…787Z.oracle/`) are git-ignored and preserved in place; nothing was deleted. The hashes above identify them.

## 11. Limitations

- **One small, fully specified objective, one run, one success.** That shows the machinery works end to end with a real model under isolation. It says nothing about the success rate, harder or ambiguous tasks, conflicts or the repair path (not exercised for real). Not production-ready.
- **The worker's share was narrowed** by pre-supplied scaffolding (`types.go`) to fit the review gate's 80-line and 4000-byte limits. Those limits are a real constraint on what this runtime can delegate today. The 4000-byte truncation in the review is a runtime defect: it is still present and needs a fix before larger files can be delegated.
- **The specification was very explicit.** The contracts spelled out every rule, including the verdict order. That tests faithful implementation, not design judgment.
- **Code-quality notes the oracle does not cover:** on error, `Evaluate`/`EvaluateForecast` return a partially built `Result` rather than a zero one. `EvaluateForecast` checks the policy before the forecast, so with both invalid it reports `ErrInvalidPolicy`. Neither was specified; callers must ignore the result on error.
- **The served model is not independently confirmed** (the CLI does not report it). Cost and quota are UNKNOWN.
- The M8.7A control-mode canary (the non-isolated baseline) failed intermittently once in an earlier suite run and once alone. It then passed 8/8 in an A/B against the pre-change canary, and in the final suite. Cause not established. The isolating modes never failed.
- Isolation residuals from M8.7B still apply (metadata observable, host name visible to code, a pattern-based scrubber, module cache readable). macOS `sandbox-exec` only.
- The accepted module lives only in the disposable run repository under `.workdir/` (git-ignored). Making it a maintained package is M9 work.

## 12. M8 closure and M9 recommendation

**M8 can be closed.** The objective lifecycle has now run real models end to end twice (M8.5, and this run with business value) under worker and verifier isolation, and every bound was enforced by code.

**M9 should be a reusable agent-core milestone before broader eShop feature work.** This run's friction is the backlog:

1. **Fix the review gate's output truncation and make the size limit a declared contract parameter.** Today the gate silently decides what can be delegated.
2. **Promote the objective runner** (`ObjectiveDefinition` + `runM85Objective` + the judge) from `tests/provider-smoke/` to a supported `lead objective run` path, with the same runtime-enforced budgets, a pinned model checked against the catalog, and an evidence report.
3. **Make the oracle-hardening loop standard:** reference solution, mutation kill-rate, then pin. Have the CLI report the served model when available.
4. **Export the accepted module** to its own repository with the oracle as its test suite, and version it.

**Then the first eShop consumer (separate, small objective):** eShop's affiliate-video pipeline is Node/JS (`src/modules/workspace`). Its current `summarizeCost` (`lib/affiliateVideoJobStore.js:247`, uncommitted work) sums float USD and treats a missing cost as 0 in the total, which is exactly what this component's oracle rejects. Proposal:

- **Boundary:** integer micro-USD cost events per attempt `{jobId, videoId, stage: image|video|review|processing, outcome: ACCEPTED|REJECTED, generation/review/processing micros or null = unknown, basis: provider|estimate, pipeline: economy|standard|premium}`, plus a read model `{summary, verdict, preferredRange, basis, sampleSizes}` shaped like the Go `Result` JSON.
- **Integration options:** (a) a small Go sidecar or CLI fed from the job store, keeping one implementation; (b) a JS port whose correctness is the Go oracle turned into language-neutral JSON test vectors. Recommend (b) for a Node-only deployment, with (a) if Go services arrive.
- **Persistence:** an append-only cost-event table keyed by job and attempt, with null meaning unknown (never 0). Acceptance comes from the existing review-required → completed transition.
- **Metrics:**
  - cost per accepted video per pipeline, against its operator ceiling;
  - the hard USD 0.50 flag;
  - the preferred 0.25–0.35 band;
  - acceptance rate and attempts per accepted video;
  - the share of attempts with unknown cost.
- **Next small objective:** replace `summarizeCost` with the event-based calculation behind the existing admin endpoints, gated by the oracle's vectors. eShop is not modified until that objective is authorized.

## 13. Closeout (2026-10-10)

**Preserved record.** Oracle `aa2cbc8c…31f8` (spec `b4558523a942…`); Mastra run ids `43a448a9-1440-44a9-8282-9c5da9573064` (A) and `08f9305e-516c-45f4-892e-5f4c972837a1` (B); the invocation ledger (section 4); integration commits `16b8e8f46d16`, `628b2debe6c9`, `5120a391ac58`, `48be13dfd360` on base `4fc5e3482868`; tokens 64,586 in / 1,592 out; **cost UNKNOWN** (never estimated).

**No code or integration changes are required for this closeout.** The closeout commit contains this report only. The harness is `6db36be`. The accepted tree is not re-run, re-integrated or edited.

### Priority technical debt for M9 (Agent Core)

1. **Review-gate output truncation (P1, a correctness defect).** The change review runs `git show HEAD:<file>` and `git diff` through `runControlledCommand`, which truncates output at `MAX_OUTPUT_BYTES = 4_000` (`src/workers/tools/execution-tools.ts:22`; used by `src/runtime/review/change-review.ts:41`). Any allowed file larger than about 4 KB at HEAD gets a false `eof_newline` block, because the truncated HEAD text never ends in a newline. Its diff text is also cut, which feeds the whitespace classification, the comment-removal warning and the added-line security patterns. The review then judges a partial diff. Found by the M8-final fake-CLI rehearsal; not fixed. Fix: read file content and full diffs through an untruncated path (or a much larger, explicit limit that fails closed), with tests on files above the limit.
2. **80-changed-line review limit (P1, a delegation-capacity constraint).** `maxChangedLines` defaults to 80 (`src/runtime/review/change-review.ts:65`) and is not set by any caller. Exceeding it produces `too_large`, which `src/lead/lifecycle/verified-review.ts:83` treats as a repairable warning. In a run that may not repair, the task then stops. That is why this objective's workers were given pre-supplied `types.go` scaffolding. Fix: make the limit an explicit, per-task contract parameter recorded in the pinned objective (not a silent default), keep a hard cap, and report it in the plan before any claim.

### Separate open deliverable (not part of M8 final)

**Mastra Studio Organization embedding: open, unverified.** The M8.4 work lives on another session's branch `codex/m8.4-control-center` (head `f855360`, worktree `/private/tmp/agentic-m84-control-center`), not on this branch. Its own decision record (`docs/plans/m8.4-studio-integration.md` at `f855360`) concludes `MASTRA_ORGANIZATION_EMBED_REQUIRES_FORK`. The installed Studio (`mastra@1.25.0`) has no supported page or sidebar registration. No integrated Organization route has been implemented or browser-verified, and the standalone Control Center slice (`5183634`, `3a6fbe0`) is not accepted as Studio integration. That branch and worktree were only read (`git show`, `git worktree list`) and not modified. This deliverable needs its own decision (a pinned fork versus a supported alternative) and must not be counted as delivered.


# Autonomous engineering demonstration report

- **Repository / PR:** `anvh2/agentic-engineering`, PR #53 (Draft, base `master`), branch `research/ecc-selective-integration`
- **Session:** 2026-10-19, Engineering Lead role held by Claude (Sonnet), independent peer reviewer ChatGPT via PR comments
- **Status: PARTIAL.** The final-regression gate is **not met** (section 8). This report must not be read as a completion claim.
- **Smoke tests:** DEFERRED (no live Ollama, no live Mastra Studio, no paid API was contacted).

## 1. What is real, what is scripted, what is not implemented

| Area | Status |
| --- | --- |
| Scheduler, SQLite store, leases, fencing, git worktrees | **Real** (exercised in scenarios A, B1, B2 and the reliability scenarios) |
| Mastra `coding-task-workflow`, a Mastra `Agent` calling the **real** repository and execution tools | **Real** |
| Runtime mutation policy, sandboxed `go test` verifier, skill promotion and pinning | **Real** |
| The language model | **Scripted** (`provider: scripted`, `model: scripted-1`). It is not Qwen and makes no network call. No latency, token or cost figure in this report measures a real model. |
| Agent selection / task decomposition by an LLM, planning quality | **Not demonstrated.** The three tasks were chosen and written by the Engineering Lead; the scheduler dispatched them. |
| Live Qwen/Ollama coding worker, Mastra Studio | **Deferred** (smoke tests are out of scope this session) |
| Event-driven GitHub Actions comment bridge | **Implemented but inert** (it only runs from the default branch; not merged) |
| Local comment poller / router | **Real and used live** (section 5) |

## 2. Scenario A: normal completion

| Field | Value (run 2026-10-19 on `09c7252`) |
| --- | --- |
| Task | `DEMO-A`: implement `Double` in `calc/calc.go` so `TestDouble` passes |
| Acceptance criteria | `TestDouble passes`; only `calc/calc.go` may change; tests immutable |
| Agent identity | `coding-worker-go`, role `coding-worker` |
| Provider / model | `scripted` / `scripted-1` (recorded telemetry `scripted:scripted-1`) |
| Skills | `go-engineering@1.0.0`, promoted digest `a84c1859dd86...`, selection digest `d75e6768046d...` (selected by `pinSkillsForTask`, resolved by the runtime catalog, reached the model prompt) |
| Run id | `inproc-DEMO-A-8c6cc6b5` |
| Tool calls (real tools) | `readFile` -> `writeFile` -> `runGoTest` (3), model inference calls: 4 |
| Coding attempts / retries | 1 / 0 |
| Verifier | `go test -count=1 ./calc`, exit code 0 (runtime verifier, not the worker's claim) |
| Result | task `REVIEW_PENDING` ("verified; awaiting Engineering Lead review"); the task branch changed exactly `calc/calc.go`; the source checkout was untouched |
| Wall clock (measured) | 6.5 s for the scenario on an otherwise idle machine |
| Tokens / cost | **not measured** (the scripted model reports constants; cost is `UNKNOWN`) |

### Scenario A+: chain into read-only specialist review

The task from a fresh run of Scenario A (`DEMO-AP`, `REVIEW_PENDING`) is handed to `runSpecialistReviews` (`src/integrations/mastra/specialist-review-runner.ts`). The lead's priority list `['security-reviewer', 'go-reviewer']` is honoured and the cap of 3 holds; every specialist run is an advisory only (`REPORTED`, scripted model), the task worktree is byte-for-byte unchanged, and the durable task state re-read afterwards is still `REVIEW_PENDING`. Evidence: `.workdir/autonomy/scenario-a-plus-specialists.json`. **Limit:** this is a function the lead calls; no scheduler hook or CLI command triggers it automatically (register N-06). Without `prefer`, the default order would have skipped `security-reviewer` (alphabetical after language fit), which is why `prefer` exists.

## 3. Scenario B: failure and recovery

**B1, failure then bounded recovery** (`DEMO-B1`, run `inproc-DEMO-B1-0f3cec8d`): attempt 1 writes `n + 1`; the runtime verifier exits 1 (`TestDouble` fails); the runner retries with a fresh context; attempt 2 writes `n * 2`; verifier exit 0. Coding attempts 2, model calls 8, six real tool calls, result `REVIEW_PENDING`, only `calc/calc.go` changed. Wall clock 12.5 s.

**B2, bounded terminal failure** (`DEMO-B2`, run `inproc-DEMO-B2-8254f087`): the worker never gets it right. Three coding attempts, verifier exit 1 on each, model calls 12, then the explicit terminal state **`ESCALATED` / `coding_attempts_exhausted`**. No commit was produced, no file in the source checkout changed. The attempt count never exceeded the configured bound (3). Wall clock 18.7 s.

**Durable recovery.** The scenarios above do not crash anything. Recovery after a crash is demonstrated by the existing reliability scenarios, run this session through `npm run reliability`: `interrupted-run` (a run orphaned by a restart does not trap the task and is not executed twice) and `stale-lease` (a SIGKILLed permit holder loses its permit at once; an expired lease returns the task and fences the stale worker): **2 of 2 passed**. Evidence files: `.workdir/autonomy/reliability/*.json`.

**A failure that was found and fixed during the session** (this is the real failure-and-recovery story): macOS CI failed one cancellation test on `9a5ebfe`. The cause was a non-atomic pid file in the fake CLIs combined with tests that polled for file existence (finding F-31 in the register). Reproduced with the same primitive (12 of 400 empty reads vs 0 of 400 after the fix); product code unchanged; 6 of 6 parallel stress runs green afterwards.

## 4. Scenario C: independent review and correction

A real peer-review cycle took place on PR #53 (comment ids in section 5). Sequence:

1. SHA-bound request `review-request-20261019-001` on `9a5ebfe` (14:48:55Z).
2. Reviewer findings `chatgpt-scoped-20261019-001` (14:50:28Z, 93 s later), five points.
3. Each point verified against code and answered with evidence (`review-response-20261019-001`). Outcome: **1 accepted as-is** (hook-log cache removal; trust boundary documented), **3 accepted with code changes** (shared check-only `gofmt` policy; router trust narrowed to an explicit allow-list, a real defect; domain-separated lesson ids), **1 agreed** (scripted-model limits stated here). I also corrected one inaccurate claim of mine (erratum in `review-response-20261019-002`).
4. A separate CI finding (`chatgpt-ci-shard1-20261019-001`) was diagnosed to a root cause, fixed and answered.
5. New SHA-bound handoffs: `d9320ec`, `7076c90`, `09c7252`.

Status: **cycle 1 complete; re-review of the corrected SHA is `AWAITING_REVIEW`.** No approval was given or claimed. A peer architecture question (`architecture-discussion-20261019-001`) was answered once; its decision summary is in the ADR.

Caveat on independence: all comments, mine and ChatGPT's, are authored by the same GitHub account (`anvh2`). GitHub cannot distinguish the two agents, so `FROM:` is a claim and the content of each review point had to stand on code and tests, which is how each was handled.

## 5. Communication evidence (PING/PONG and latency)

| Event | Comment | Time (UTC) |
| --- | --- | --- |
| Claude PING `handshake-claude-20261019-001` | [6269614128](https://github.com/anvh2/agentic-engineering/pull/53#issuecomment-6269614128) | 14:27:14 |
| ChatGPT PONG `handshake-chatgpt-20261019-001` (claimed sender, same account) | [6269694502](https://github.com/anvh2/agentic-engineering/pull/53#issuecomment-6269694502) | 14:30:59 (**225 s** after PING) |
| Claude acknowledgement (round trip closed) | [6269778137](https://github.com/anvh2/agentic-engineering/pull/53#issuecomment-6269778137) | 14:34:56 |
| Claude router-transport PING `router-transport-test-20261019-001` | [6269790797](https://github.com/anvh2/agentic-engineering/pull/53#issuecomment-6269790797) | 14:35:32 |
| **Router-generated** PONG from `Router-Bridge` (`ROUTER_GENERATED: true`) | [6269897965](https://github.com/anvh2/agentic-engineering/pull/53#issuecomment-6269897965) | 14:40:32 (**300 s**; the poll interval) |
| Review request on `9a5ebfe` | [6270073599](https://github.com/anvh2/agentic-engineering/pull/53#issuecomment-6270073599) | 14:48:55 |
| ChatGPT scoped findings | [6270105453](https://github.com/anvh2/agentic-engineering/pull/53#issuecomment-6270105453) | 14:50:28 (**93 s**) |

Reading these honestly: the 225 s and 93 s figures are comment-to-comment latencies including whatever scheduler ChatGPT uses; they are far below the "about hourly" cadence announced beforehand. The 300 s router latency is dominated by the configured 5-minute poll interval, not by processing. The router PONG proves transport only, and says so in its own body; it is not an acknowledgement by ChatGPT. The two-way handshake with ChatGPT is the 14:27 -> 14:30 -> 14:34 exchange, with the same-account caveat above.

The local poller (`npm run pr-router -- poll`) makes one `gh api` call per interval and no model call. It exits when a message addressed to the lead arrives, which is what woke the Engineering Lead for ChatGPT's review responses.

## 6. Quantitative targets

| Dimension | Target | Observed |
| --- | --- | --- |
| Scenario coverage | 3 distinct | **3** (A; B with B1 and B2; C), with the scripted-model limit above |
| Execution traceability | 100% | **100%** of scenarios have run ids, tool traces and verifier exit codes (A, B1, B2) or comment ids (C) |
| Explicit terminal/blocked states | 100% | **100%**: `REVIEW_PENDING` x2, `ESCALATED/coding_attempts_exhausted`, C `AWAITING_REVIEW` |
| Unauthorized mutations | 0 | **0 observed**: changed files were exactly the allowed file or none; source checkout clean in all runs |
| Credential exposure | 0 | **0 observed.** Scan of every line added versus `master` found 2 pattern hits, both fixtures in `repository-tools-secret-files.test.ts` that exist to prove secret files are unreadable (a fake `sk_live_...` string and a PEM header around it) |
| Unbounded retries | 0 | **0**: B2 stopped at 3 attempts; worst-case bound across layers is documented (ADR: 18 inferences) |
| Fabricated verification successes | 0 | **0**: every PASS came from a real `go test` exit code recorded by the runtime |
| Durable recovery | demonstrated or clearly failed | **Demonstrated** by existing reliability scenarios (2/2); **not** demonstrated by the new scenarios |
| Independent review | at least 1 real cycle | **1 cycle completed**, re-review pending |
| Final regression | pass at final SHA | **NOT MET** (section 8): two full runs on `9a4f71d`, each with a failure in a real-Codex smoke test, under heavy external load |
| Human message forwarding | 0 | **0** messages were relayed between the agents by the human |

## 7. Findings produced by this session

Registered in `docs/audits/2026-10-pr53-ecc-integration/findings-register.md` as F-21 to F-31. Highlights: a session cache that hid in-place hook-log tampering was **removed**; `gofmt` argv was unrestricted at the lifecycle and integration boundaries and now has one shared check-only policy; the comment router trusted any repository collaborator, now only an explicit login allow-list; prototype keys (`constructor`) resolved as tools; unmeasured cost was treated as acceptable; a CI flake root cause. Each fix has a test that was run against the pre-fix code and failed there (F-26 is a behaviour-preserving optimization and says so).

## 8. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean at `09c7252` |
| Full `npm test` at `09dba01` (router commit) | 1406 tests, 1406 pass, 0 fail, 0 skipped, 813.8 s |
| Autonomy demonstration (3 tests) | 3 of 3 pass on `09c7252` |
| Reliability scenarios `interrupted-run`, `stale-lease` | 2 of 2 pass |
| Full `npm test` at `9a4f71d`, **run 1** | 1429 tests, 1428 pass, **1 fail**: `tests/smoke-e2e/m87-credential-isolation.test.ts` "control" case (its `go test` probe inside the real Codex workspace-write sandbox returned false) |
| Full `npm test` at `9a4f71d`, **run 2** | **Did not finish** by the time this was written (about 38 minutes). It already contains **1 fail**: `tests/smoke-e2e/m86-recovery.test.ts` server-crash case (`restartedServerPid` missing, i.e. the harness did not restart the real Mastra server). No pass/fail totals exist for this run. |
| Isolated reruns of those two files | M8.7 file: 14 of 14 pass (16:08Z). The "control" case alone: 0 failures in 25 runs on pre-session `ed1e1a0` and 0 in 25 on `9a4f71d`, 1 failure in 12 other isolated runs (the first after idle). M8.6 file: **inconclusive**, no summary within 280 s under load. |
| Environment during the runs | Load average 34 to 62 on the host. Other Claude sessions (B on issue #54, C on a model registry, announced in comments 6271017159 and 6271036767) were running their own test suites and a `mastra dev` server on the same machine. This is a plausible cause of timing failures in tests that spawn real servers and CLIs; **it is not proven**, and the root cause of either failure is not identified. I did not change either test or its harness. |
| GitHub CI at `9a4f71d` | success: typecheck and all four macOS test shards (the real-Codex smoke tests are probably not run there; not verified) |

**Gate decision:** a full green regression at the final SHA was not obtained, so no `READY_FOR_REVIEW` marker is posted. The honest state is `PARTIAL_CHECKPOINTED`.

## 9. Consolidation

`git rev-list --count HEAD..<ref>` is 0 for `origin/feature/m11-headless-lead-preview` (#47), `origin/feature/language-adapter-foundation` (#51), `origin/master` and the reviewer's ADR commit `442c26b`. Five language-adapter commits that existed only on a local branch are present in the lineage under rebased SHAs. Nothing was force-pushed; every push was a fast-forward. #47 and #51 remain open and untouched.

## 10. Known limitations

- The model is scripted; planning quality and real Qwen behaviour are unmeasured (finding N-02 stays open).
- Sender identity on PR comments is not authenticated beyond the GitHub account.
- The hook log does not defend against an adversary who can rewrite the database file.
- The retry layers multiply (up to 18 model invocations per task for the local default); deferred, documented in the ADR.
- `integrate.ts` uses the shared `gofmt` policy but has no direct test of its own.
- The event-driven bridge is untested on GitHub itself because it cannot run before it is merged.
- The router ignores messages with sender ids or types it does not know (it failed closed on the OWNERSHIP_NOTICE messages from Sessions B and C). Extending the protocol is a design decision, not done.
- Two real-Codex smoke tests failed intermittently in full runs on a loaded machine; cause unidentified (see section 8). A clean full run on a quiet machine is still required.
- `go-test` compatibility probe in the canary discards its output (`>/dev/null 2>&1`), so a failure carries no diagnostics. Recording its stderr is a worthwhile follow-up.

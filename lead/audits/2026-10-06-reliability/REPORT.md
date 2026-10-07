# Reliability & security audit — 2026-10-06

Scope: `harness-engineering` as it exists on branch `recovery/2026-10-03` (including uncommitted work), the live
`mastra dev` server, the M5 scheduler (`.workdir/scheduler/scheduler.db`, read-only) and `lead-batch` evidence.
No paid APIs, no pushes, no writes to eshop or to any real database.

## 0. Incident caused by this audit (read first)

The `:4111` server is `mastra dev`, which hot-reloads on any edit to a file in its module graph. At 15:44:43 UTC my
edits to `src/mastra/tools/repository-tools.ts` / `execution-tools.ts` triggered a reload. On every reload `mastra dev`
calls `restartAllActiveWorkflowRuns`, which **re-executes the active step of every run still marked `running`**. Effect:

| run | owner | effect |
|---|---|---|
| `88b6c2da` | lead-sched `M5-ESHOP-2A` / `2A-image-review-state-machine` | in-flight execution killed; scheduler waited the full 30-min `taskTimeout` → `RUNTIME_FAILURE task_timeout` at 16:00:22 (claim 1/3 spent). The run was re-driven by the server at 15:50:22 and kept editing its worktree after the scheduler gave up. **Still `running` in Mastra.** |
| `6c69a9be` | lead-batch `M4-ESHOP-CARRYOVER-1` / `ESHOP-001b` | re-executed from scratch at 15:44:45, PASSed at 15:50, then rejected by the scope gate because of a write by a different zombie run (see D1). |

After that I made every further change in an isolated copy and deliver it as a patch (§5). Remediation for you:

```bash
# stop the abandoned run so no later reload re-drives it again (marks it canceled in Mastra storage)
curl -X POST http://localhost:4111/api/workflows/coding-task-workflow/runs/88b6c2da-f3fb-45ac-a40a-67e5e798852d/cancel
npm run lead:sched -- retry 2A-image-review-state-machine   # only after the patch: see D4 (retry re-adopts today)
```

## 1. Architecture (as implemented)

```
 Lead (Claude, interactive)                                  .workdir/scheduler/scheduler.db  (SQLite, WAL)
   │ lead-sched plan/run/review/integrate (CLI)  ─────────►  tasks · events · reviews · locks
   │ lead-batch / lead-delegate (JSON-file state)            ▲ claim(): BEGIN IMMEDIATE, epoch fencing
   ▼                                                         │ heartbeat every lease/3; reaper requeues expired
 Scheduler (scripts/lead-sched.ts → scheduler/scheduler.ts) ─┘
   │ per task: WorktreeManager.prepare  →  <.workdir/worktrees>/<batch>/<task> on lead-task/<batch>/<task>
   │ Executor = mastra-executor → HTTP create-run/start/poll  (abort only stops polling — see D2)
   ▼
 Mastra server (mastra dev :4111; libsql src/mastra/public/mastra.db; duckdb observability; /metrics)
   coding-task-workflow:  prepare (routeTask gate) → run-qwen-worker-harness → finalize
                                                     │ executeDelegation → runCodingTask
                                                     │   Qwen (Ollama qwen3:8b) via repository/execution tools
                                                     │   mutation policy = full-tree snapshot (skips .git, node_modules)
                                                     │   gofmt / EOF normalize → verificationCommands (unsandboxed)
                                                     ▼   artifacts .workdir/lead-delegations/<task>-<ts>/
 Scheduler: PASS → VERIFYING → inspectChange gate → commit on task branch → REVIEW_PENDING
 Lead review (lead-sched review decide) → APPROVED | REVIEW_REJECTED(+correction task) | ESCALATED
 integrateBatch: repo lock → merge --no-ff into lead-integration/<batch> worktree → commit oracle → verify → DONE
                 (never pushes, never touches the user's checkout or main)
```

**Implemented:** SQLite backlog + state machine, atomic claims, leases/fencing, worktree isolation, run adoption after a
crash, review queue with bounded corrections, serialized integration with rollback, Prometheus `/metrics`, deterministic
delegation gate (Go: one `.go` file; JS: one `.js` file + `npx --no-install jest <test>`).
**Planned only (no code):** quota-aware model router, Codex/Claude Code execution engines, context compiler, decision
memory, any OS sandbox for verification. `maxConcurrentOllamaRequests` is per process, not global.

## 2. Defects found and fixed

| id | sev | defect | evidence | fix | where |
|---|---|---|---|---|---|
| D1 | **Critical** | `mastra dev` re-executes the harness step of every "running" run on each reload — including runs the Lead abandoned and restored. Zombie writes land in the real checkout unsupervised. | run `8ab8109f` (lead-batch, real eshop checkout) executed **4×** (15:23:00, 15:23:19, 15:29:10, 15:29:34); lead-batch restored its files at 15:35:20, the zombie wrote `imageReview.js` at 15:39:03; `6c69a9be` was then rejected for that file. | step claims its `runId` with an exclusive-create marker (`.executions/<runId>.json`); a re-execution returns `RUNTIME_FAILURE run_restarted` without touching the repo. Step now honors `abortSignal`, so `cancel` stops a live run and restores the tree. | patch |
| D2 | High | task timeout only stops polling: the Mastra run keeps running (and holding Ollama) unsupervised; a run orphaned by a restart stays `running` and every re-claim re-attaches to it until the claim budget is gone | `failure-injection.test.ts` "orphaned by a Mastra restart"; real: `2A-image-review-state-machine` coding_ms = 1 800 458 | `Executor.cancel`; scheduler cancels the run it gives up on (timeout); `cancelCodingTaskRun` in mastra-client | patch |
| D3 | High | integration crash recovery wedges the batch forever when the integrator died mid-conflicted-merge (tip == preSha) or after writing the oracle but before committing it; failed oracle commit was ignored (DONE with dirty tree) | 3 tests: "not clean (AA src/a.js)", "not clean (?? tests/)", `DONE` instead of `ESCALATED` | `recoverInterrupted` always uses the full `rollback` (merge --abort, reset, clean); rollback checks every git result; oracle add/commit checked → escalate + rollback | patch |
| D4 | High | `lead:sched retry` never retries: the next claim re-adopts the failed run's recorded outcome | test "`retry` of a RUNTIME_FAILURE runs the task again" → got RUNTIME_FAILURE "ollama unavailable" | requeue from RUNTIME_FAILURE/ESCALATED clears `run_id` (history in `run_ids` kept; lease-expiry requeue still adopts) | patch |
| D5 | High | worker write tools could write `.git` (a worktree's `.git` pointer file → every later harness `git commit`/`reset --hard` targets the user's repo; `.git/config`/hooks → code exec) and `node_modules` (forge the jest verifier). The mutation snapshot skips both, so nothing detected it. | demo: one `writeFile(".git")` turned the worktree's HEAD from `lead-task/B/t` into the user's `main`; 18 failing assertions | `resolveWritablePathWithinRepository` refuses `.git`, `node_modules`, `.applypatch-*` segments (case-insensitive) | **live** (applied 15:44) |
| D6 | High | verification runs worker-written code; files it changed outside the allowed set were not checked after verification → PASS (delegate mode on a real checkout has no other gate) | 2 failing tests | post-verification snapshot; side effects = forbidden mutation | patch |
| D7 | Medium | worker tools ran `npx jest` / `npx prettier` **without `--no-install`** (non-TTY npx auto-downloads from the registry); jest test path beginning with `-` reached jest as an option (`--config=…` executes code) | test with recording fake `npx` | `--no-install`; reject `-`-prefixed paths | **live** |
| D8 | Medium | reaper could requeue a lease renewed by another process between its read and its write (fence checked owner/epoch, not expiry) | test with interleaved heartbeat → task requeued | transition option `leaseExpiredBefore`, checked inside the transaction | patch |
| D9 | Medium | SQLite lock held past `busy_timeout`: heartbeat throws inside `setInterval` → **uncaught exception kills the scheduler**; claim-loop error aborts `run()` | `uncaughtException: database is locked` | heartbeat failure skips one renewal; scheduling pass deferred (≤20 consecutive); outcome writes never throw out of `execute` | patch |

Also found while fixing: my first D1 cancel path re-called the model after an abort (runtime-retry loop lacked a
`break`) — caught by the cancel test and fixed before packaging.

## 3. Security findings

| sev | finding | status |
|---|---|---|
| High | D5 `.git` / `node_modules` writable by the worker | fixed (live) |
| High | D6 verification side effects undetected | fixed (patch) |
| **High** | Verification and `runGoTest`/`runJestTest` execute model-written code **unsandboxed** with your user's privileges (network, `$HOME`, other repos). The change gate's regex (`child_process`, `exec`…) runs *after* execution and is JS-centric (Go `os.RemoveAll`, `net/http`, `syscall` pass). | **open** — top priority 1 |
| Medium | D7 npx auto-install + jest option injection | fixed (live) |
| Low | `searchFiles` compiles model-supplied regex with no time bound → ReDoS can block the Mastra event loop | open |
| Low | `readFile` can read `.env` / `.git/config` into model context (local Ollama only; traces record paths, not contents) | open |
| Info | legacy `runClaudeCli` passes the whole prompt as argv (ARG_MAX, visible in `ps`) | open |
| — | shell injection: every spawn uses argv arrays, no `shell: true` (only SQLite `exec`) | verified clean |
| — | path traversal / symlink escape: realpath-based boundary + existing tests; `hiddenFiles`/`linkPaths`/`snapshotPaths` validated | verified clean |
| — | secrets: no `sk-`/`Bearer`/`ghp_` shapes and no copy of the Mastra platform token in any recorded artifact | verified clean |
| — | unsafe commits/merges: commits only on `lead-task/*` and `lead-integration/*`; no remote configured; no push code path | verified clean |
| — | prompt injection via repo content → worker: no tool path to escape after D5/D7; review-pack diffs are `+`-prefixed so cannot close the markdown fence | no exploit found |

## 4. Failure-injection tests (all deterministic, temp repos/DBs, fake Mastra HTTP server)

| scenario | test | before | after |
|---|---|---|---|
| two workers claim same task | existing `store.test` (2 connections, 4 OS processes) | pass | pass |
| worker crash during file mutation | `repository-tools-crash.test.ts` (child dies between temp write and rename) | pass (atomic) | pass |
| scheduler crash mid-task / restart / duplicate completion / stale owner | existing `scheduler.test` | pass | pass |
| Mastra restart mid-workflow | `failure-injection` orphan test; `coding-task-workflow-restart.test.ts` | **fail** | pass |
| run left running after timeout | `failure-injection` "task timeout cancels" | **fail** | pass |
| SQLite contention (heartbeat, claim loop) | `failure-injection` SQLite × 2 | **fail (crash)** | pass |
| expired lease vs concurrent heartbeat | `failure-injection` lease race | **fail** | pass |
| failed verification → retry | existing runner tests; `failure-injection` retry-after-failure | **fail (D4)** | pass |
| Claude rejects worker code | existing `integrate.test` (correction task, bounded) | pass | pass |
| dependency cycles | existing `store.test` | pass | pass |
| forbidden files (tools, verification side effects) | `repository-tools-protected-paths.test.ts`, `coding-task-runner-side-effects.test.ts` | **fail** | pass |
| integration conflict + crash variants | existing + `failure-injection` × 3 | **fail (wedge)** | pass |
| missing/corrupted artifacts | deleted worktree → escalated (pass); malformed run result → not PASS (pass); corrupt task row | pass / pass / `todo` | corrupt row still takes the scheduler down (open, R3) |

## 5. Test results

* Full suite, isolated copy with the patch: **504 tests, 502 pass, 1 todo, 1 fail** (×2 runs). The failure is
  `scheduler-metrics.test` asserting the checkout directory is named `harness-engineering`; it passes in the real tree (10/10).
* Baseline before changes, real tree: 463/464 then 464/464 ×4 — **one unidentified flaky test (~1 in 6 runs)**, not reproduced since.
* Delegation: 0 tasks delegated. The real gate (`lead-delegate --dry-run`) keeps these fixes with Claude: `.ts` is not a
  delegable language, security risk is not "low", `npx` is not an allowed Go verifier. Your Qwen slot was also busy with your batches.

Apply (only when no workflow run is in flight — applying reloads `mastra dev`, which re-drives active runs; after this
patch those re-drives are refused safely):

```bash
git apply lead/audits/2026-10-06-reliability/reliability-audit-fixes.patch && npm test
```

## 6. Measurements (recorded evidence only — `measure.mjs`, `measurements.txt`)

| metric | eshop delegations (JS) | Go ladder bench | source |
|---|---|---|---|
| step executions / finished | 20 / 8 (**12 never finished — killed by restarts**) | 50 / 50 | trace.jsonl |
| end-to-end task latency p50 / p90 | 347 s / 377 s | 1705 s / 2117 s | task_started→end |
| model call p50 / p90 | 334 s / 375 s | 600 s / 1043 s | model_finished |
| share of wall time in model inference | **99.2 %** | 99.8 % | |
| verification p50 / share | 1.1 s / 0.5 % | 1.0 s / 0.1 % | |
| first-attempt pass | 7 / 8 | 19 / 50 (20 pass) | |
| runtime retries per model call | 7 % | 28 % (46 × `finishReason=tripwire`) | |
| throughput (serial, 1 Ollama slot) | M4-SMOKE-1: 4 accepted / 23.8 min ≈ **10 tasks/h**, worker busy 95 % | | batches/*/events |
| review outcome | 4 accepted, 2 rejected (1 of them false — caused by D1) | | lead-batch events |
| M5 scheduler useful utilization (15:30–16:00) | **0 %** — 30 min on an orphaned run; 2 of 3 later claims BLOCKED `source_tree_dirty` | | scheduler.db |
| recovery time | scheduler crash: lease 5 min + poll 2 s; Mastra restart: **30 min per claim** (observed) → ≤ 1 timeout after patch | | config + events |

**Top 3 bottlenecks.** (1) Local inference: >99 % of wall time, one Ollama slot, p50 ≈ 5.6 min per eshop task; Go
runs lose 28 % of model calls to runtime errors. (2) Lost work from server restarts: 60 % of eshop step executions never
finished, each orphan cost a 30-min timeout. (3) Base/working-tree drift: `source_tree_dirty` blocked 2 of 3 M5 claims
(your uncommitted eshop edits vs the batch base).

## 7. Remaining risks

* R1 **Unsandboxed execution of model-written code** (High, open).
* R2 Concurrency across processes: `lead-sched`, `lead-batch` and `lead-delegate` each enforce their own Ollama limit
  (observed: two concurrent runs at 15:36); `lead-batch` does not cancel runs it abandons (D1's guard now prevents re-execution).
* R3 One corrupt JSON row in `tasks` makes every scheduler command fail (`todo` test documents it).
* R4 A run killed mid-step leaves a partially edited tree; the guard refuses re-execution, but delegate mode on a real
  checkout still needs a human restore (scheduler mode resets the worktree on re-claim).
* R5 Editing source while `mastra dev` has runs in flight restarts them — run the harness against `mastra start` (built), or
  keep code edits out of the dev server while batches run.
* R6 After a timeout the scheduler cancels the run; if Mastra is unreachable the cancel is best-effort (logged), and the
  orphan costs one more timeout on the next claim.

## 8. Next engineering priorities

1. **Sandbox verification** (R1): run verifier/test commands under a `sandbox-exec` profile (deny network, deny writes
   outside the worktree + build caches), then add a test that a worker-written `os.RemoveAll("../x")` cannot escape.
2. **Single owner for model capacity** (R2): one SQLite lock/semaphore (`locks` table, TTL) shared by lead-sched,
   lead-batch and lead-delegate, and make `lead-batch` cancel runs it abandons.
3. **Run the harness on a non-reloading server** (R5) and alert on `running` runs older than `taskTimeout`
   (export it from `/metrics`); quarantine unparseable task rows instead of failing every command (R3).

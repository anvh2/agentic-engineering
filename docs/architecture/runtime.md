# Runtime architecture

Canonical path (the only supported one):

```
lead CLI (scripts/lead.ts)
  → Scheduler            src/runtime/scheduler
  → Executor             src/integrations/mastra/executor.ts
  → Mastra workflow      src/integrations/mastra/workflows/coding-task-workflow.ts
  → Coding runner        src/runtime/execution/coding-task-runner.ts
  → Worker               src/workers
  → Sandboxed verifier   src/runtime/sandbox
  → Review               src/runtime/review (deterministic) + src/lead/review.ts (Lead decision)
  → Integration          src/runtime/integration
```

The Mastra workflow is an adapter: it gives runs a Studio-visible record and persists phase state. It contains no coding, verification or retry logic; the coding runner is the single authority.

## Task lifecycle

Enforced in one place, `SchedulerStore.transition`:

`BACKLOG → READY → CLAIMED → CODING → VERIFYING → REVIEW_PENDING → APPROVED → INTEGRATING → DONE`

Exits: `BLOCKED`, `REVIEW_REJECTED` (spawns a bounded correction task), `ESCALATED`, `RUNTIME_FAILURE`, `CANCELLED`.
A worker PASS ends at `REVIEW_PENDING`. Only a recorded Lead decision reaches `APPROVED`; only a verified integration reaches `DONE`.

State: SQLite at `.workdir/scheduler/scheduler.db` (tasks, audit events, reviews, locks). Markdown (`npm run lead -- tasks --markdown`) is a generated view only. Optional overrides: `.workdir/scheduler.config.json`, `AGENTIC_SCHED_DB`, `AGENTIC_SCHED_ROOT`.

## Guarantees

- **Atomic claim**: one IMMEDIATE transaction; proven with four OS processes racing for 8 tasks, six racing for one, and `maxActive` held across processes.
- **Lease + fencing**: every claim bumps `claim_epoch`; worker writes carry (owner, epoch), so a zombie worker, a duplicate completion or a late result after cancel cannot write.
- **Recovery**: expired leases requeue (bounded by `maxClaims`). A re-claim re-attaches to the worktree without resetting it and tries to adopt the previous run's outcome; only if there is none is the worktree reset (after proving it is a managed worktree).
- **Isolation**: each task runs in `.workdir/worktrees/<batch>/<task>` on branch `lead-task/<batch>/<task>`. The user's checkout, index and branches are never touched. Files owned by an un-integrated task cannot be claimed by another.
- **Stale-base guard**: a task whose source files differ from the batch base (`refs/lead/base/<batch>`) is BLOCKED (`source_tree_dirty`). `snapshotPaths` captures chosen uncommitted files into the base via a temporary index.
- **Sandbox**: all model-generated code runs under macOS `sandbox-exec`: writes only inside the task root and a private temp dir, no network (loopback included), no credential reads, allow-listed environment. If no sandbox can be proven, nothing runs (fail closed; no opt-out).
- **Protected paths and mutation policy**: worker tools refuse protected repository paths; the runner diffs the filesystem after every attempt and rejects forbidden mutations, including side effects of verification commands. `npx` runs with `--no-install`.
- **Integration**: per-repository lock; reviewed commit re-checked; merge `--no-ff` into `lead-integration/<batch>` in the `_integration` worktree; the task's oracle is committed as a permanent test; this and earlier tasks' oracles plus batch commands must pass. Any failure rolls back to the recorded pre-merge SHA and escalates the task (worktree kept). Never pushes, never touches main.
- **Model capacity**: one machine-wide limit on concurrent Ollama calls (`src/runtime/capacity`), lease database at `~/.agentic-engineering/model-capacity.db` (`AGENTIC_MODEL_LOCK_DB`, `AGENTIC_MODEL_CONCURRENCY`). The path is a persisted compatibility name. This is the ONLY model limit: see [Concurrency](#concurrency-m7).

## Delegation eligibility (`routeTask`, src/runtime/execution/delegation.ts)

A task is delegated to the local worker only if all hold; otherwise it stays with Claude and the worker is never invoked:
assessment small / low risk / no ambiguity; one allowed source file; never a test file; acceptance criteria and constraints present (constraints must say tests are immutable); verification binary in {go, gofmt} (or the validated JS commands); context files exist; git work tree with the allowed files clean. Max 3 coding attempts; runtime failures get one separate bounded retry.

Outcomes: `PASS` (verifier passed on the exact final state), `ESCALATED_TO_CLAUDE` (attempts exhausted or forbidden mutation; tree restored; `escalation.json`), `RUNTIME_FAILURE` (model unavailable after one retry; not a coding failure), `KEPT_BY_CLAUDE` (refused by the gate).

Per-run artifacts: `.workdir/lead-delegations/<taskId>-<timestamp>/` (`trace.jsonl`, `attempts.json`, `contract.json`, `final.diff`, `result.json`; override with `AGENTIC_ARTIFACT_ROOT`). No raw chain-of-thought is recorded.

## Review

No unattended Claude invocation exists. `lead review pack` writes one Markdown pack of every pending review; `lead review decide <task> approve|reject|escalate --feedback "..."` records the decision once; then `lead integrate <batch>`.

## Defaults and measured limits

1 logical worker (`AGENTIC_WORKER_CONCURRENCY`, max 3), 1 model permit (`AGENTIC_MODEL_CONCURRENCY`), 5 tasks per batch, 2 review corrections. Measured on a 16 GB M-class Mac with qwen3:8b: two simultaneous requests decode at the same speed but Ollama serializes them, so a second model permit adds no model throughput; logical workers still help because worktree preparation, verification and review checks overlap with another task's inference.

## Concurrency (M7)

Two limits, deliberately separate:

| Limit | Meaning | Set by | Enforced by |
| --- | --- | --- | --- |
| Logical workers | tasks in their execution lifecycle at once (`CLAIMED`/`CODING`/`VERIFYING`) | `AGENTIC_WORKER_CONCURRENCY` or `lead run --workers N` (default 1, max 3) | `SchedulerStore.claim` counts leased tasks inside the claim transaction (`maxActive`), so it holds across processes; the pool loop in `Scheduler.run` |
| Model permits | model calls in flight machine-wide | `AGENTIC_MODEL_CONCURRENCY` (stored in the capacity database on first use; `ModelCapacity.setPermits` changes it) | the coding runner takes a lease around each model call only (`coding-task-runner.ts`) |

`AGENTIC_WORKER_CONCURRENCY=3 AGENTIC_MODEL_CONCURRENCY=1` therefore puts three tasks in flight, each with its own worktree, lease and workflow run, while exactly one holds the inference slot; the others queue inside the runner, in `CODING`, and that queue time is recorded separately (`model_capacity_wait_seconds`, `capacityWaitMs` in the trace and `attempts.json`). `worker_inference_seconds` starts after the permit is held. There is no scheduler-level model limit any more; a stale `maxConcurrentOllamaRequests` in `scheduler.config.json` is ignored with a warning.

### Model permits: FIFO admission

A caller that cannot get a permit at once takes a **ticket** (`waiters.ticket`, `INTEGER PRIMARY KEY AUTOINCREMENT`, assigned by SQLite under its write lock, so tickets are one total order across all processes and never reused). One IMMEDIATE transaction per attempt reaps expired/dead leases and waiters, counts free permits, and admits the waiter iff `(live waiters with a smaller ticket) < (permits - held)`.

Chosen semantics: **strict FIFO and work-conserving**. The `free` oldest live waiters get the `free` available permits: a newer waiter never takes a permit while an older live waiter is queued (no overtaking, no starvation), and with `AGENTIC_MODEL_CONCURRENCY > 1` every free permit is granted. Idle time is bounded by polling only (`pollMs`, default 1 s: an older waiter that has not polled yet delays a free permit by at most one interval). `tryAcquire` joins the same order (it succeeds only if a permit remains after every live waiter is served).

Failure behavior: a waiter row is leased too (`waiterLeaseMs`, default 15 s, renewed every poll and by a timer) and is dropped immediately when its pid is dead on this host, so a SIGKILLed waiter cannot hold up the queue (another host: at most `waiterLeaseMs`). Cancelling (AbortSignal), timing out or failing withdraws the row at once. A live waiter reaped during a long stall re-enters under its original ticket and keeps its place. A lease that has expired cannot be renewed even if not yet reaped, and releasing a lost lease deletes only its own row, so a stale holder can never free its successor's permit. A process running pre-FIFO code on the same database still respects the permit count but ignores the queue (it can overtake): run one version at a time.

### Timeouts: what governs each phase

| Phase | Governed by | Bound |
| --- | --- | --- |
| Queued for a model permit | scheduler `ExecutionClock` (`maxCapacityWaitMs`) and, where the wait happens, the runner's cumulative wait budget (same value: `AGENTIC_MODEL_WAIT_BUDGET_MS`, default 30 min) | exhausting it = `capacity_wait_timeout` (`RUNTIME_FAILURE`, retryable with `lead retry`; the waiter leaves the queue; not a coding attempt, no runtime retry inside the runner) |
| Active execution (worktree, model call, verification) | scheduler `ExecutionClock` (`taskTimeoutMs`, default 30 min) | **paused while the task is queued**: a task that waited behind others still gets its full budget once it holds a permit. Exhausting it = `task_timeout`. |
| One model call | runner `modelTimeoutMs` (workflow: 900 s) | starts after the permit is held |
| Whole run | derived | elapsed < `taskTimeoutMs + maxCapacityWaitMs` by construction; neither budget can extend the other |
| Executor poll backstop | `lead` passes `taskTimeoutMs + maxCapacityWaitMs` to the Mastra client | the hard bound, for a server that stops answering |
| Ownership | lease + heartbeat (`workerLeaseTimeoutMs`) | independent of all of the above: heartbeats continue while queued; a task whose lease is lost or that is cancelled/stopped abandons its wait (withdrawing the ticket) and never reaches the model |

The scheduler learns that a task is queued from the capacity database (`ModelCapacity.isWaiting(tag)`, tag = the contract's `taskId`, the same tag the runner queues with) and samples it every `min(pollMs, taskTimeoutMs/4)` (<= 1 s): each transition between waiting and working is accounted to within one sample. Without a capacity probe (`Scheduler` built without `capacity`) the legacy single wall-clock `taskTimeoutMs` applies. A Mastra run superseded by a lease change is adopted by the next claim (`reconcile`) rather than duplicated; its own wait is bounded by the same budgets and ends when Mastra cancels the run.

### Worker providers

A coding worker is a `WorkerLike` plus an optional `ProviderDescriptor` (`src/runtime/execution/worker-provider.ts`): identity (provider, model, CLI version), capabilities (task types, how it edits, how the file scope is enforced, how it is cancelled, what usage it reports, billing class) and the capacity resource its calls queue on. It is not a second execution path: the runner still owns attempts, the filesystem mutation policy, formatting and verification, so **a provider proposes and only the runtime verifier can produce PASS**; allowed-file scope is re-judged from the filesystem after every provider call, whatever the provider enforces itself.

- Per call the runner passes `providerRequest` (isolated worktree, allowed/context files, task type, deadline) and records `AttemptRecord.telemetry`: provider, model, inference time and usage. Anything a provider does not report is the literal `UNKNOWN`, never 0 (a local-free provider's cost is a known 0).
- Capacity is per provider resource (`capacityFor`): the local model queues on `ollama`, each cloud CLI on its own resource in the same machine-wide database, so one never blocks the other, while each resource keeps one limit across processes. `AGENTIC_MODEL_CONCURRENCY` sizes only the local model.
- `ProviderRegistry` (`src/workers/providers`) lists what can run and probes availability without exposing credentials. The default is `ollama` (Qwen); a worker without a descriptor behaves exactly as before. There is no automatic fallback between providers.

### Cancellation: stopping a run, and knowing it stopped

Every way a run can be abandoned (task timeout, queue-wait timeout, scheduler stop, `lead cancel`, a cancelled task noticed through a lost lease, a run that started after its task lost the fence) goes through one function, `cancelTaskRun` (`src/runtime/scheduler/cancel.ts`). Asking is not stopping, so it reports what it could confirm:

| Layer | What stops | Evidence required |
| --- | --- | --- |
| CLI | `lead cancel` writes `CANCELLED` first (the fence: later results are discarded), then cancels the run. Idempotent: on an already-cancelled task it retries the run cancellation. First `SIGINT`/`SIGTERM` of `lead run` is graceful, a second exits at once and prints the runs that may still be executing. | exit code 1 unless the run is confirmed stopped |
| Scheduler | `stop()` claims nothing further (gate re-checked per claim), aborts every in-flight task, fails it through its fence, then cancels and confirms its run. `run()` returns only after that; unconfirmed runs are in `RunSummary.stillActive`. | audit event `run cancellation (<reason>): <outcome>` on the task |
| Executor / Mastra | `cancelCodingTaskRunConfirmed`: POST cancel, then poll the run until terminal (a run the server no longer knows counts as terminal; a refused cancel of a finished run is fine; an unreachable server is `unreachable`, never terminal) | run status |
| Model permit | the run being terminal is not enough: the task must hold no permit and have no queue entry (`ModelCapacity.engagedBy(taskId)`) within `cancelGraceMs` (15 s) | permit table |
| Runner | the abort stops the model call, verification commands (whole process group), and the retry delay; a cancel that lands as the model returns skips verification and cannot yield PASS | trace events |
| Provider call | a provider that ignores its abort for `abortGraceMs` (10 s) is reported (`provider_unresponsive`) and **keeps the model permit until it really settles** (`provider_settled_late`), so a second inference cannot overlap an orphaned one | trace events |

Outcomes: `stopped`, `no_run`, `still_active`, `unreachable`, `unconfirmed`. Only the first two are clean.

Fencing is unchanged and now also covers a result that arrives in the same tick as a timeout: after `taskTimeoutMs` or `maxCapacityWaitMs` expires, an executor outcome is discarded even if it is a PASS. A lease that merely **expired** does not cancel the run (the next claim adopts it with `reconcile`); a lease lost because the task was **cancelled** does. Only processes this runtime spawned are ever signalled (the command runner's own process group); user CLI sessions are never touched.

Known limit: cancelling during a verification command takes effect immediately for the sandboxed command (its process group is killed), but a Mastra step that is between tool calls only observes the abort at its next await.

### Task graph (DAG) semantics

A plan is a DAG over `dependsOn`. `createBatch` rejects, before storing anything: a task depending on itself, a dependency that is neither in the plan nor an existing task, and any cycle.

A task leaves `BACKLOG` for `READY` only when **every dependency is `DONE`**: reviewed, approved, integrated into `lead-integration/<batch>` and verified there. A worker PASS (`REVIEW_PENDING`) or an approval is not enough, and it is what makes the dependent's worktree, which is cut from the integration tip, contain its prerequisites. A rejected task's dependents follow its correction task (`superseded_by`).

What a dependency's fate does to its dependents (`SchedulerStore.dependencyStatus` / `promote`, evaluated on every scheduling pass):

| Dependency state | Dependent |
| --- | --- |
| `DONE` | satisfied |
| `BACKLOG`, `READY`, `CLAIMED`, `CODING`, `VERIFYING`, `REVIEW_PENDING`, `APPROVED`, `INTEGRATING`, `REVIEW_REJECTED` with a live correction | waits; `lead tasks` prints `waiting on <id> (<state>)` |
| `RUNTIME_FAILURE` with claims left | waits (a `lead retry` can revive it); shown as above |
| `ESCALATED`, `CANCELLED`, `BLOCKED`, rejection with no correction, `RUNTIME_FAILURE` with the claim budget spent, missing task | dependent becomes `BLOCKED` / `dependency_failed` with the root cause in its reason, transitively; one failed dependency is enough even if an earlier dependency is merely waiting |
| a failed dependency later recovered (retry, take-over) | blocked dependents return to `BACKLOG` automatically |

Nothing waits on something that can no longer happen. Tasks that wait for a human (review, retry) are visible as such: `scheduler_tasks{state="BACKLOG"}` vs `scheduler_dependency_blocked_tasks`.

### Integration of concurrent work

Integration is single-writer (per-repository lock) and its order depends only on the plan: dependencies first, then (priority, creation, id). Completion or approval order does not change it, so the same set of approved tasks always produces the same integration tree. A dependent whose prerequisites are not `DONE` is reported `SKIPPED`, not merged.

A merge that conflicts, or a merge whose post-merge verification fails, is never resolved automatically: the branch is restored to the exact pre-merge SHA, the task is `ESCALATED` (`integration_conflict` / `integration_verification_failed`), its worktree is kept, and `tasks.artifacts.integration` records `integratedBefore` (the DONE tasks it failed to coexist with) and, for a textual conflict, `conflict`: the conflicted files, the integration tip, the task's reviewed commit, the merge base, the commits that reached those files first, the already-integrated tasks that declare them, and the conflict-marked excerpts. Its dependents become `BLOCKED`.

### Observability

| Question | Series (Prometheus) | `lead` |
| --- | --- | --- |
| Active logical workers | `active_workers` (PERSISTED) | `lead status`, `Scheduler.run().peakInFlight` |
| Ready / claimed / running | `task_queue_depth`, `scheduler_tasks{state}` | `lead tasks` |
| Dependency-blocked | `scheduler_dependency_blocked_tasks`; waiting = `scheduler_tasks{state="BACKLOG"}` | `lead tasks` (`waiting on ...`) |
| Model utilization | `model_capacity_in_use` / `model_capacity_permits` (PERSISTED, read-only from the capacity database) | `lead run` prints the permits |
| Model wait vs inference | `model_capacity_wait_seconds`, `worker_inference_seconds` (LIVE) | trace `model_started.capacityWaitMs`, `attempts.json` |
| Task duration | `workflow_duration_seconds` (LIVE) | `lead metrics` (`avgCodingMs`, `avgEndToEndMs`) |
| Retries | `worker_retries_total{kind}` (in-runner), `scheduler_extra_claims` (lease/runtime requeues) | `lead status` |
| Integration failures | `scheduler_integration_failed_tasks{category}` | `lead integrate` output, task artifacts |

All labels are enum-clamped; no task, run or worker id is ever a label.

## What Studio shows and does not

Studio shows the three-step workflow graph per run and one trace per run (workflow → step → agent → model → tool call). Intra-step phases are emitted as `coding-phase` events and not persisted mid-step; the runtime's own checks (hash mutation checks, gofmt, `go test`) are not spans. The complete record is the artifact directory above.

## Persistence

| Store | Location | Tables / content |
| --- | --- | --- |
| Scheduler | `.workdir/scheduler/scheduler.db` (`AGENTIC_SCHED_DB`, `AGENTIC_SCHED_ROOT`) | `batches`, `tasks` (state, lease owner/expiry, `claim_epoch`, attempts, result JSON), `events` (audit trail of every transition), `reviews` (Lead decisions), `locks` (per-repository integration lock) |
| Model capacity | `~/.agentic-engineering/model-capacity.db` (`AGENTIC_MODEL_LOCK_DB`, `AGENTIC_MODEL_CONCURRENCY`) | `capacity` (permit count per resource), `leases` (holder pid, expiry; renewed while a call runs), `waiters` (the FIFO queue: ticket, holder, tag, pid, expiry; added additively, no migration) |
| Run artifacts | `.workdir/lead-delegations/<task>-<ts>/` (`AGENTIC_ARTIFACT_ROOT`) | trace, attempts, contract, final diff, result |
| Worktrees | `.workdir/worktrees/<batch>/<task>`, `_integration` | git worktrees |
| Session projects | `.workdir/projects/<name>/` | `project.json` (`agentic.project/1`), `STATE.md`, `checkpoints/*.json` (`agentic.checkpoint/1`) |
| Mastra storage | libSQL + DuckDB under `.mastra/` (framework-owned) | run snapshots, traces |

No table or column carries the old project name, so the SQLite schemas needed no migration. `tasks.result` JSON written before the rename may contain a `harnessCategory` key; nothing reads it, and new rows write `runnerCategory`.

### Identity migration (harness-engineering → agentic-engineering)

| Old | New | How migrated |
| --- | --- | --- |
| env `HARNESS_*` | env `AGENTIC_*` | rename only; no aliases (set the new names in your shell/.env) |
| `~/.harness-engineering/model-capacity.db` | `~/.agentic-engineering/model-capacity.db` | not copied: it holds only expiring leases and a permit count that is re-derived from env. The old directory can be deleted once no old process is running |
| `lead/projects/<name>/` (tracked) | `.workdir/projects/<name>/` (local) | files moved; schema strings rewritten in `project.json` and every checkpoint |
| schema `harness.project/1`, `harness.checkpoint/1` | `agentic.project/1`, `agentic.checkpoint/1` | rewritten in place; the loader now rejects the old strings |
| `lead/principles.md` | `docs/operations/lead-principles.md` | moved |
| workflow step `run-qwen-worker-harness` | `run-coding-worker` | rename; in-flight runs of the old server are not resumable across the rename |
| git author `harness-engineering` / `harness-integrator` | `agentic-engineering` / `agentic-integrator` | affects new commits only |

No compatibility aliases remain. The word "harness" no longer appears in active code or docs; the runtime-side verifier is called the *runtime verifier* / *coding runner*.

## Engineering Lead planning (M7.5)

`lead objective <objective.json>` turns a human objective into a validated task DAG. Planning never executes; queuing is a separate explicit step (`--submit`); running is a third (`lead run`). Code: `src/lead/objective/`.

```
objective.json → read-only research → draft (the Lead) → validation → plan.json → batch.json     PLAN   (executes nothing)
                                                                  lead objective --submit <id>   SUBMIT (STALE_PLAN check; queues the batch, executes nothing)
                                                                  lead run --batch <id>          EXECUTE (M7 scheduler)
```

- **Contracts**: `EngineeringObjective`, `ResearchContext`, `EngineeringPlan` (`types.ts`). A planned task reuses the delegation shapes (`leadAssessmentSchema`, the coding contract's path/command types). `batch.json` is the existing `BatchPlan`, unchanged, so the scheduler receives exactly what `SchedulerStore.createBatch` already accepts.
- **Task ids**: scheduler task ids are unique across all batches, so the batch uses `<objective-id>.<plan-task-id>` (also in `dependsOn` and `contract.taskId`). `plan.json` keeps the Lead's short ids; `submitted.json` maps one to the other.
- **Research** (`research.ts`): deterministic and read-only. `git ls-files` plus bounded reads; no model, network or writes. It yields relevant files and their tests, module boundaries, conventions, candidate test commands and risks (security-sensitive, destructive, no test coverage, files workers cannot edit, dirty files).
- **The Lead** (`EngineeringLead`: `research`, `plan`): there is no unattended Claude invocation, so the shipped `DraftFileLead` is a hand-off: run once for research, the Lead writes `draft.json`, run again to validate it. A Claude-API Lead is another implementation of the same two methods; its draft is untrusted and validated like any other.
- **Isolation**: git is reached only through an allow-list (`rev-parse`, `ls-files`, `status`, `for-each-ref`, with `--no-optional-locks`). The repository is fingerprinted (HEAD, refs, status, dirty-file stats) around both phases; a change discards the result (`PlanningIsolationError`). This detects a mutating Lead rather than preventing it. No planning module imports the scheduler store, worktrees, integration, executors or Mastra (enforced by a test); `submit.ts` reaches the store through a structural `BatchSink`.
- **Ownership**: `LOCAL_WORKER` must pass every static check of `routeTask` (one allowed `.go`/`.js` file, never a test, small/low/unambiguous, constraints state tests are immutable, verification binary and jest argv allow-listed) and becomes `executor: 'worker'`. `CLAUDE_LEAD` becomes `executor: 'claude'` with its brief in `keptReason`; the scheduler never claims it for a worker, and dependents wait for the Lead to finish it. `HUMAN_DECISION` is surfaced as `needs_human_decision` and can be neither exported nor submitted. Sandbox availability and clean allowed files stay claim-time checks in `routeTask`.
- **Validation** (`validate.ts`): unique ids, known dependencies, no self-dependency, no cycles, at least one root, acceptance criteria, bounded worker scope, command policy (no shells, network tools, pushes or `npx` without `--no-install`), integration commands, plus warnings (dirty owned files, "independent" tasks sharing a file, more worker tasks than `maxTasksPerBatch`). An invalid plan writes only `plan.rejected.json`. The scheduler enforces the same DAG again at runtime (`createBatch`, `dependencyStatus`); both layers exist on purpose.
- **Staleness** (`submit.ts`): `plan.baseCommit` must equal the repository's HEAD at submit time or the submit fails with `STALE_PLAN` before anything is persisted. The plan is never rebased or rewritten; the Lead researches and plans again. `plan.json` is also re-validated at submit, since a human may have edited it. The guarded path is `lead objective --submit`; `lead plan <batch.json>` stays the raw, unguarded entry.
- **Artifacts**: `.workdir/objectives/<id>/{objective,research,draft,plan,batch,submitted}.json` (`plan.rejected.json` instead of `plan.json`/`batch.json` when invalid). `plan.json` embeds the validation verdict and is stamped with the researched commit, which is also the batch `baseRef`.
- **Exit codes**: 0 ok · 1 plan rejected · 2 usage/input · 3 research written, draft needed · 4 `STALE_PLAN` or plan not submittable. `lead objective --show <id>` prints a stored plan.
- **Claude as the Lead** (`claude-lead.ts`, `lead-prompt.ts`): `lead objective <file> --lead claude --max-budget-usd X [--model M] [--max-revisions N]` runs a `ClaudeEngineeringLead` behind the same `EngineeringLead` boundary. Research is still the deterministic scan; the model receives a bounded prompt (objective, research, file excerpts, the worker policy rendered from the enforced constants) and returns JSON text. It runs with all tools disabled (`claude -p --tools ""`) from an empty scratch directory, so it cannot touch the repository or the scheduler. Its reply is an untrusted draft: it goes through the same validation and becomes work only through `--submit`.
  - **Cost bound**: it is a billed call, so `--max-budget-usd` is mandatory (capped at 5; the `claude` CLI enforces it per call), revisions (paid retries) are off unless `--max-revisions N` (at most 2), and the worst-case total is printed before the first call. There is no automatic retry beyond that.
  - `claude -p` refuses to start inside another Claude Code session (nested sessions share runtime resources), so run this command from a normal terminal.

## Recovery and attempt accounting (M8 Phase 1)

- **Lease expiry refunds the claim**: a lease usually expires because the host stalled (laptop asleep), not because the task failed. The first `MAX_LEASE_REFUNDS` (3) expiries per task give the claim back (`artifacts.leaseExpiries` counts them); after that an expiry spends a claim like any other, so a task that keeps losing its lease still ends in `RUNTIME_FAILURE`. The fencing epoch still advances on every claim.
- **`lead recover <task> --reason "..." [--grant N | --escalate]`** is the audited exit from a `RUNTIME_FAILURE` whose claim budget is spent (`lead retry` refuses it). The default retry raises `maxClaims` by one if needed (hard cap 10), returns the task to `READY` and releases the dependents it had blocked; `--escalate` hands it to the Lead (`claude take`). The reason is mandatory and is recorded in the task event log (actor + reason) and `artifacts.recoveries`. Implementation: `SchedulerStore.grantClaims` + `src/lead/recovery.ts`.
- **Whitespace review gate** (`src/runtime/review/whitespace-changes.ts`): a changed line that differs only in whitespace is classified, not counted. A pure re-indent (same text, one uniform indentation shift: code moved into or out of a block) next to a real change is allowed with a `whitespace_reindent` warning. Reformatting away from any real change, mixed or non-uniform whitespace edits, line-ending rewrites and more than 3 stray spacing edits are still blocked (`whitespace_only_change`); scope, EOF, security and comment-removal checks are unchanged.

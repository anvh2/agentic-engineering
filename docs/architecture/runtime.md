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

State: SQLite at `.workdir/scheduler/scheduler.db` (tasks, audit events, reviews, locks). Markdown (`lead tasks --markdown`) is a generated view only. Optional overrides: `.workdir/scheduler.config.json`, `HARNESS_SCHED_DB`, `HARNESS_SCHED_ROOT`.

## Guarantees

- **Atomic claim**: one IMMEDIATE transaction; proven with four OS processes racing for 8 tasks.
- **Lease + fencing**: every claim bumps `claim_epoch`; worker writes carry (owner, epoch), so a zombie worker, a duplicate completion or a late result after cancel cannot write.
- **Recovery**: expired leases requeue (bounded by `maxClaims`). A re-claim re-attaches to the worktree without resetting it and tries to adopt the previous run's outcome; only if there is none is the worktree reset (after proving it is a managed worktree).
- **Isolation**: each task runs in `.workdir/worktrees/<batch>/<task>` on branch `lead-task/<batch>/<task>`. The user's checkout, index and branches are never touched. Files owned by an un-integrated task cannot be claimed by another.
- **Stale-base guard**: a task whose source files differ from the batch base (`refs/lead/base/<batch>`) is BLOCKED (`source_tree_dirty`). `snapshotPaths` captures chosen uncommitted files into the base via a temporary index.
- **Sandbox**: all model-generated code runs under macOS `sandbox-exec`: writes only inside the task root and a private temp dir, no network (loopback included), no credential reads, allow-listed environment. If no sandbox can be proven, nothing runs (fail closed; no opt-out).
- **Protected paths and mutation policy**: worker tools refuse protected repository paths; the runner diffs the filesystem after every attempt and rejects forbidden mutations, including side effects of verification commands. `npx` runs with `--no-install`.
- **Integration**: per-repository lock; reviewed commit re-checked; merge `--no-ff` into `lead-integration/<batch>` in the `_integration` worktree; the task's oracle is committed as a permanent test; this and earlier tasks' oracles plus batch commands must pass. Any failure rolls back to the recorded pre-merge SHA and escalates the task (worktree kept). Never pushes, never touches main.
- **Model capacity**: one machine-wide limit on concurrent Ollama calls (`src/runtime/capacity`), lease database at `~/.harness-engineering/model-capacity.db` (`HARNESS_MODEL_LOCK_DB`, `HARNESS_MODEL_CONCURRENCY`). The path is a persisted compatibility name.

## Delegation eligibility (`routeTask`, src/runtime/execution/delegation.ts)

A task is delegated to the local worker only if all hold; otherwise it stays with Claude and the worker is never invoked:
assessment small / low risk / no ambiguity; one allowed source file; never a test file; acceptance criteria and constraints present (constraints must say tests are immutable); verification binary in {go, gofmt} (or the validated JS commands); context files exist; git work tree with the allowed files clean. Max 3 coding attempts; runtime failures get one separate bounded retry.

Outcomes: `PASS` (verifier passed on the exact final state), `ESCALATED_TO_CLAUDE` (attempts exhausted or forbidden mutation; tree restored; `escalation.json`), `RUNTIME_FAILURE` (model unavailable after one retry; not a coding failure), `KEPT_BY_CLAUDE` (refused by the gate).

Per-run artifacts: `.workdir/lead-delegations/<taskId>-<timestamp>/` (`trace.jsonl`, `attempts.json`, `contract.json`, `final.diff`, `result.json`; override with `HARNESS_ARTIFACT_ROOT`). No raw chain-of-thought is recorded.

## Review

No unattended Claude invocation exists. `lead review pack` writes one Markdown pack of every pending review; `lead review decide <task> approve|reject|escalate --feedback "..."` records the decision once; then `lead integrate <batch>`.

## Defaults and measured limits

1 worker, 1 concurrent Ollama request, 5 tasks per batch, 2 review corrections. Measured on a 16 GB M-class Mac with qwen3:8b: two simultaneous requests decode at the same speed but Ollama serializes them, so more workers add no model throughput.

## What Studio shows and does not

Studio shows the three-step workflow graph per run and one trace per run (workflow → step → agent → model → tool call). Intra-step phases are emitted as `coding-phase` events and not persisted mid-step; the harness's own checks (hash mutation checks, gofmt, `go test`) are not spans. The complete record is the artifact directory above.

## Persisted compatibility names

Kept on purpose so existing state keeps working; migrate separately: `HARNESS_*` environment variables, project schema `harness.project/1`, `~/.harness-engineering/model-capacity.db`.

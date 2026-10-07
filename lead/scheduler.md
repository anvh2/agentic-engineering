# M5 persistent engineering scheduler

```
Product Owner (human)  ->  Engineering Lead (Claude)  ->  scheduler  ->  Mastra `coding-task-workflow`  ->  local Qwen worker
   priorities, approvals     plan / review / integrate     claim, lease,    existing runner: retries, verification,      edits via writeFile
                                                          worktree          mutation checks (unchanged, single authority)
```

Code: `src/mastra/scheduler/`. CLI: `scripts/lead-sched.ts` (`npm run lead:plan|tasks|run|status|review|resume|cancel|sched`).
State: SQLite `.workdir/scheduler/scheduler.db` (tasks, audit events, reviews, locks). Markdown (`lead:tasks --markdown`) is a generated view only.

## Lifecycle (enforced in one place: `SchedulerStore.transition`)
`BACKLOG -> READY -> CLAIMED -> CODING -> VERIFYING -> REVIEW_PENDING -> APPROVED -> INTEGRATING -> DONE`
Exits: `BLOCKED`, `REVIEW_REJECTED` (spawns a bounded correction task), `ESCALATED`, `RUNTIME_FAILURE`, `CANCELLED`.
A worker PASS ends at REVIEW_PENDING. Only a recorded Lead decision reaches APPROVED; only a verified integration reaches DONE.

## Guarantees
- **Atomic claim**: one IMMEDIATE transaction; proven with four OS processes racing for 8 tasks.
- **Lease + fencing**: every claim bumps `claim_epoch`; all worker writes carry (owner, epoch), so a zombie worker, a duplicate completion or a late result after cancel cannot write.
- **Recovery**: expired leases requeue (bounded by `maxClaims`). A re-claim first re-attaches to the worktree WITHOUT resetting it and tries to adopt the previous Mastra run's outcome; only if there is none is the worktree reset (after proving it is a managed worktree).
- **Isolation**: each task runs in `.workdir/worktrees/<batch>/<task>` on branch `lead-task/<batch>/<task>`; the user's checkout, index and branches are never touched. Files a task owns cannot be claimed by another un-integrated task.
- **Stale-base guard**: a task whose source files differ from the batch base (`refs/lead/base/<batch>`) is BLOCKED (`source_tree_dirty`), never run on stale content. `snapshotPaths` (Lead-authored allowlist) captures chosen uncommitted files into the base via a temporary index.
- **Integration**: per-repository lock; reviewed commit re-checked; merge `--no-ff` into `lead-integration/<batch>` in `_integration` worktree; this task's oracle is committed as a permanent test; this + earlier tasks' oracles + batch commands must pass; any failure rolls back to the recorded pre-merge SHA and escalates the task (worktree kept). Never pushes, never touches main.

## Defaults and measured limits
1 worker, 1 concurrent Ollama request, 5 tasks/batch, 2 review corrections. Measured on this Mac (M-class, 16 GB, qwen3:8b): two simultaneous requests each decode at the same ~17 tok/s but the second finishes in 2x wall time, i.e. Ollama serializes them; more workers add no model throughput (they only overlap worktree prep, jest and review). Ollama may also be shared with other sessions, so a request can queue for minutes.

## Review (no unattended Claude invocation exists)
`lead:review -- pack` writes one Markdown pack of every pending review; `lead:review -- decide <task> approve|reject|escalate --feedback "..."` records the decision once. Then `lead:sched -- integrate <batch>`.

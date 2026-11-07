# M11 supervisor preview — one Engineering Lead CLI

**Draft / not certified for unattended use.** M11 continues the existing
`scripts/lead.ts -> SchedulerStore -> lifecycle -> Scheduler/Mastra -> verifier -> integration`
execution path. There is no second job DB or independent scheduling framework.

The Gemini prototype contributed the operator UX (`start/status/pause/resume/stop`) and
a supervisor abstraction. The PID-driven SIGTERM, stale-lock takeover, separate
mission checkpoint store and auto-review permissions were deliberately **not** reused.

## Operator setup (disposable repositories only)

M11 preview **must** run with separate scheduler, model-capacity, artifact and Mastra
storage. Do not reuse the live :4111 service or production SQLite. The preview
only manages an already **submitted batch with pinned independent Oracle**; it
does not generate plans or expand its own authorization.

```sh
cd /path/to/agentic-engineering-m11-review
npm ci

export AGENTIC_SCHED_ROOT="$PWD/.workdir/m11-isolated"
export AGENTIC_SCHED_DB="$AGENTIC_SCHED_ROOT/scheduler/scheduler.db"
export AGENTIC_MODEL_LOCK_DB="$AGENTIC_SCHED_ROOT/model-capacity.db"
export AGENTIC_ARTIFACT_ROOT="$AGENTIC_SCHED_ROOT/artifacts"
export AGENTIC_ALLOW_PROVIDERS=""

# Provision a separate private Mastra server on 127.0.0.1:4211 using its own storage.
# Submit a disposable batch and independently pin its Oracle first.
npm run lead -- supervisor start --batch DISPOSABLE_BATCH --server http://127.0.0.1:4211 --once
npm run lead -- supervisor status
npm run lead -- supervisor pause
npm run lead -- supervisor resume
npm run lead -- supervisor stop
```

### Objective queue (M12)

`lead supervisor start --queue [--once] --server <isolated URL>` replaces `--batch <id>`: the supervisor takes every
objective whose oracle the Lead has already pinned (lifecycle phase `PINNED`), **oldest pin first, one at a time**, through
the same lifecycle driver. So a second objective starts when the first is accepted, with nobody naming it. The bounds:

- Only `PINNED` objectives are taken. An objective that already started (`EXECUTING`, for example after a crash) or that
  stopped for a human (`ESCALATED`, `AWAITING_OPERATOR`) is never resumed by the queue.
- The queue **stops at the first objective that does not end `ACCEPTED`** (exit 1); later objectives stay `PINNED` until a
  human has looked. Nothing is planned, submitted or pinned by the supervisor: a queued objective is one the Lead submitted
  and pinned explicitly (`lead objective --submit`, `lead lifecycle pin`).
- Without `--once` it waits for newly pinned objectives (polling `--poll-ms`) until `supervisor stop`; with `--once` it runs
  at most one objective, or reports `idle` and exits.
- The gate, the DB leadership lock (`supervisor:queue`), pause/stop intents, the isolation checks and the refusal of
  non-default providers are the same as for `--batch`.

The supervisor start command **runs in foreground**; run controls in a separate
terminal with identical isolated env variables. The supervisor holds a
non-expiring filesystem gate under `$AGENTIC_SCHED_ROOT/supervisor/holder` and
a renewable owner-specific DB lock. The gate is released only after the
existing lifecycle call settles and ownership is proven. After an unknown crash,
**do not remove the gate automatically**, even if its PID is dead. Inspect all
children, Mastra run IDs and lifecycle state before any operator recovery.

`pause` and `stop` are cross-process cooperative requests, checked
between objectives or when idle. They are **not** immediate cancellation.
To cancel a running model, use the existing `lead lifecycle cancel` with
confirmed capacity release.

## Verification required before leaving Draft

1. `npm run typecheck`
2. `node --disable-warning=ExperimentalWarning --test src/lead/supervisor/cli.test.ts`
3. `npm test` once on final candidate
4. Disposable pinned Oracle + real Qwen run through a **separate Mastra server**,
   with a proven worker trace and runtime verification
5. Pause/resume during idle; stop during in-flight work; forced crash followed
   by inspected orphan gate; no duplicate run or premature lock release
6. Review the CLI's isolation and loss-of-ownership negative controls.

This PR is **M11 supervisor integration groundwork**, not the finished M11
closed-loop headless service. It does not self-start Mastra, detach from terminal,
restart on reboot, auto-clear orphan gates, use cloud providers, or autonomously
create mission plans. No test results are claimed until run on the actual branch.

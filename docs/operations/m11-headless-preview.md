# M11: headless lifecycle runner (experimental preview)

This preview adds **one detached, persistent supervisor process** over the existing pinned-oracle `lead lifecycle` path. It does **not** introduce another Engineering Lead, bypass review, modify the worker TypeScript policy, authorize a provider, merge to master, or deploy.

**Not yet certified for unattended self-development or valuable repositories.** Treat this PR as a test candidate, not a release.

## Setup: disposable/secret-free isolated environment

An operator must first provision a separate Mastra server bound to loopback **other than :4111**, with independent storage and no paid-provider authorization. The runner does not start that server.

Create `/tmp/m11-mission.json`:

```json
{
  "mission": "disposable-m11-smoke",
  "server": "http://127.0.0.1:4211",
  "objectives": ["DISPOSABLE-OBJECTIVE-001"]
}
```

Beforehand submit the corresponding batch and pin its independent oracle using the existing `lead objective` / `lead lifecycle pin` commands. Mission objective IDs must exactly match those pre-pinned lifecycle rows.

```sh
export AGENTIC_SCHED_ROOT="$PWD/.workdir/m11-isolated"
export AGENTIC_SCHED_DB="$AGENTIC_SCHED_ROOT/scheduler/scheduler.db"
export AGENTIC_MODEL_LOCK_DB="$AGENTIC_SCHED_ROOT/model-capacity.db"
export AGENTIC_ARTIFACT_ROOT="$AGENTIC_SCHED_ROOT/artifacts"
export AGENTIC_ALLOW_PROVIDERS=""

npm run lead:headless -- init --manifest /tmp/m11-mission.json
npm run lead:headless -- start
npm run lead:headless -- status
npm run lead:headless -- stop
npm run lead:headless -- resume
```

Runner journal and logs: `$AGENTIC_SCHED_ROOT/headless/`.

The queue stops on the first non-ACCEPTED exit code. `stop` is **cooperative at the objective boundary**, not immediate cancellation of a live model run. To cancel an in-flight run, use the existing operator-authorized `lead lifecycle cancel` command and confirm release. A process that crashes mid-objective leaves a `RUNNING` checkpoint and a non-expiring gate. **Never auto-remove an orphan gate** without confirming the prior process and all descendants have stopped and reconciling the persisted lifecycle/run state.

## Limits and required acceptance before promoting from Draft

- This is an **M11-01/M11-02 prototype**, not complete M11.
- Mastra server startup/restart, OS reboot survival, and fully automated orphan recovery are **not implemented**.
- No automatic review/repair permission expansion. Existing lifecycle review/Oracle remains authoritative.
- Do not infer that detached means crash-safe across Mac power failures.
- A child exit of 1 can also be an unexpected CLI error rather than a verified NOT_ACCEPTED decision; the next iteration must cross-check the durable lifecycle verdict before classifying it. It is never treated as ACCEPTED.
- No real Ollama/Mastra smoke or `npm test` is claimed for this PR. Run `npm run typecheck`, scoped state tests, full regression, then a disposable kill/restart and stop/resume trial on the Mac before approving.
- No live Studio :4111 or operational database was accessed.

Goal for follow-up: add supervised isolated Mastra server lifecycle, recoverable child run reconciliation, restart tests and worker capability routing **without weakening M10.1 gates**.

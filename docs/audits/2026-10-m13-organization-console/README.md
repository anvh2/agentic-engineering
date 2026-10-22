# M13 Organization console, increment A: Runs and navigation, verified on the real runtime (2026-10-20)

Scope is increment A in `docs/plans/m13-organization-console.md`. Physical-call telemetry (B), deeper Collaboration consolidation (C) and operational polish (D) are not included.

All screenshots come from `apps/control-center/organization-runs.test.mjs`, run in installed Chrome against the built Mastra runtime with the Studio fork (`studio-fork/start.mjs`) on `127.0.0.1:4513`. The test lets through only same-origin GET/HEAD/OPTIONS and aborts every other request. It has no fixture fallback: it fails if the scheduler database holds no persisted tasks. No model calls were made. Ports 4111 and 4411 belong to other sessions and were not touched.

## Data sources (all read-only)

- **Main scheduler DB:** the main checkout's `.workdir/scheduler/scheduler.db`, batches `M10-RL` (agentic-engineering) and `M5-ESHOP-2A` (eshop). It has no verifier or findings results, so those fields show UNKNOWN.
- **M7 smoke DB:** a byte-identical copy (sha256 `42ef3982…`) of `.workdir/m7-smoke/sched/scheduler/scheduler.db`, opened from this worktree's `.workdir`. It holds 8 tasks from a real runtime smoke run. 7 carry a recorded verifier exit code and a findings array (all empty), and all 7 have review outcome `APPROVED`. Failure categories present: `integration_verification_failed` and `dependency_failed`.
- **Council:** `CONTROL_CENTER_COUNCIL_WORKDIR=<phase0 worktree>/.workdir`, unchanged from the #59 audit.

| File | Shows |
| --- | --- |
| `runs-before.png` | Baseline: #59 UI assets (built from `618186e`) with ten tabs, on the same runtime and data |
| `runs-eshop-inspector.png` | Runs on `M5-ESHOP-2A`: project, batch and status filters; provider/worker column; inspector with counters, timestamps and `task_timeout`. Verifier and review fields are UNKNOWN because nothing is recorded |
| `runs-m7-smoke-inspector.png` | Runs on `M7-SMOKE-2`: recorded verifier exit code `0`, review outcome `APPROVED`, attempts and timestamps |
| `runs-m7-smoke-status-filter.png` | Task-status filter applied; the row count matches the persisted tasks in that state |

## What the projection exposes and withholds

`ControlTask.execution` is optional and reads existing scheduler columns and `tasks.result`. There is no schema change, write path or runtime import beyond types. Failure categories, review outcomes and finding codes pass through closed allowlists, which are type-checked against the runtime `FailureCategory` and `FindingCode` unions. Free-form state reasons, review feedback, verifier commands and output, finding details, artifacts and event actors/reasons never reach the wire. Adapter tests assert this with `private`-marked inputs. A non-array `findings` value projects as null rather than failing the snapshot.

These are task-level observations from the persisted result. They are not per-run outcomes, not a verifier PASS, and not physical call counts. Usage stays UNKNOWN: the scheduler supplies no call observations.

## Verification

Final candidate, after the last code change:

- `npm run typecheck` (root): pass. `apps/control-center` typecheck and build: pass. `MASTRA_TELEMETRY_DISABLED=1 npm run build -- --studio`: pass.
- Focused control-center suite (`src/integrations/control-center/*.test.ts`, `apps/control-center/src/*.test.ts`): 42/42.
- Actual Studio on the main DB: `studio.test.mjs`, `organization-council.test.mjs`, `organization-runs.test.mjs`: 3/3. Actual Studio on the M7 smoke copy: `organization-runs.test.mjs` 1/1.
- Fixture browser suite `npm run test:ui`: 3/3.
- After review scoped the agent row count in `organization-council.test.mjs` to the Registered agents region (an exact count again, no longer `>=`), that test re-ran against the actual Studio 1/1, with root typecheck and the focused suite 42/42 on the committed tree.
- Full `npm test`: 1504 of 1507 passed, 2 failed, 1 cancelled. That run started before the final verifier/findings projection and the hardening edits; the focused suite above covers those. The three failing suites, `tests/autonomy/autonomous-demonstration.test.ts`, `tests/smoke-e2e/codex-http-smoke.test.ts` and `tests/smoke-e2e/m85-objective.test.ts`, failed on timing: "timed out waiting for", a 300 s test timeout, and "bounded attempts, saw 0". At the time, two Mastra builds and two Chrome suites were running on the same machine. None of them imports control-center code. Re-run in isolation on the final candidate, they passed 24/24.

## Sprint follow-up (2026-10-22): identity and evidence semantics

The same actual-Studio setup, main scheduler DB, batch `M5-ESHOP-2A`:

| File | Shows |
| --- | --- |
| `overview-execution-lanes.png` | The static Claude/Qwen/Codex/Gemini roster is replaced by execution lanes for the providers the batch's persisted tasks name (`claude`, `ollama`). Evidence `OBSERVED`, no role, model NOT RECORDED. Usage reads NOT RECORDED and permits UNAVAILABLE (no capacity DB in this preview), never zero |
| `runs-needs-attention.png` | "Needs attention" filter: 7 blocked or failed tasks, with scheduler state, outcome (`dependency_failed`, `source_tree_dirty`, `task_timeout`) and trace (`No run recorded` vs a run link) in separate columns. Claim elapsed reads NOT APPLICABLE for unleased tasks |

Contract note: `agents[].role` is now nullable. A UI bundle built before this change rejects the new snapshot. The Gateway serves its own bundle from the same build, so that only affects mixing old assets with a new backend, as the optional before-screenshot step of `organization-runs.test.mjs` does.

Verification for this follow-up: root and UI typecheck pass; UI build and `npm run build -- --studio` pass; focused suite 44/44; `npm run test:ui` 3/3; actual Studio `studio.test.mjs` and `organization-council.test.mjs` 2/2 and `organization-runs.test.mjs` 1/1 (without the baseline step). The full regression was not re-run.

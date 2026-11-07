# M12 execution evidence, 2026-10-22 to 2026-10-23

M12 asks the runtime to route bounded work to authorized coding workers under explicit budgets, have real workers code it through the one supported path, verify it independently, and start the next objective without anyone naming it. This folder holds what actually happened. Everything below comes from persisted state: the scheduler database (`execution.json`), the council records (`council/`) and the run artifacts. The model is **local Qwen only**. **No paid provider was called.**

## Summary

| M12 completion criterion | Evidence | Status |
| --- | --- | --- |
| 1. A real objective is planned into executable tasks | `m12-quota-r3` (3 Go tasks) and `m12-retry` (2 JS tasks): `lead objective` research, Lead draft, validator (0 errors, 0 warnings), `--submit` | met |
| 2. The runtime selects an authorized coding worker | 5 `provider_routing` rows: `ollama` / `qwen3:8b-ctx8192`, `local_default`, all four checks passed, nothing charged, `fallback: none` | met (code from PR "provider routing", run from a local integration checkout) |
| 3. A task is coded by a real worker through the runtime | 5 of 5 tasks coded by Qwen through `coding-task-workflow`, each on its first attempt and first claim | met |
| 4. Independently verified | runtime verifier (sandbox) PASS per task, then verified review APPROVED per task, then the pinned oracle PASS on the integration tip and FAIL on the base (negative control) | met |
| 5. Failures and retries handled safely | 3 failures, all contained: a server restart (`run_restarted`, no blind re-run); a wrong implementation, a no-change attempt and a `task_timeout`; 3 review rejections (the original task and both bounded corrections) ended the objective; nothing rejected was integrated. Nothing failed was integrated; `main` untouched | met |
| 6. Visible in Mastra and Organization | Mastra runs below; `control-center/v1/snapshot?objectiveId=…`, `/council`, `/agents` on the isolated server | met on the isolated server; **not** on :4111 (see Limitations) |
| 7. Delivered as a reviewable PR | The code shipped as PRs #62 (provider routing) and #64 (supervisor queue), both merged to master (2026-10-24 and 2026-10-26); this evidence is PR #63 | met (see Status at merge) |
| 8. A second objective begins without the Technical Architect | `lead supervisor start --queue` started `m12-retry` itself once `m12-quota-r3` was ACCEPTED | met (supervisor code from PR "supervisor queue") |

## Who did what

- **Engineering Lead (Claude)**: researched, planned and pinned the objectives; wrote the stub interfaces in the dogfood repositories; wrote the runtime changes in the two PRs. Those changes are under `src/` and `scripts/`, which PR #58 makes non-delegatable in this repository, so a worker could not be given them. This is a recorded escalation, not a bypass. The deny-list was not changed.
- **Coding worker (Qwen 3 8B, local)**: wrote every line of the five accepted implementations in the two dogfood repositories. No worker diff was edited by hand.
- **Runtime**: verifier, verified review, integration and acceptance oracle, all unchanged from master.
- **Council (Qwen 3 8B, advisory)**: below.

## Live Engineering Council `m12-execution-live-1`

`engineering-council-workflow` run `dd6fc943-327c-4c68-b0da-5950de457e8b`, trace `67537e1b9c4460e8ea2afc91f756cb38`. Architect (chair), Security Reviewer and Reliability Reviewer, all on `ollama/qwen3:8b-ctx8192`. 7 model calls, 0 re-asks, 0 invalid; tokens 12 016 in / 7 910 out; 16:37 to 16:47 UTC. The six agenda questions are the question in `council/record.md`.

Outcome: **decided, advisory** (`authority: none`, human approval pending). The chair proposed adopting the architect's proposal "with modifications to address budget enforcement gaps and synchronization risks", with 3 objections outstanding.

**No specialist called a file tool** (`toolCalls: []` in every row of `council/calls.jsonl`). Every code-specific claim in the record is therefore unverified. Lead response, checked against the code:

- Correct and acted on: there was **no budget enforcement** for paid providers (the operator's `AGENTIC_MAX_CLOUD_COST_USD` / `AGENTIC_PAID_PROVIDER_ENABLED` were read by nothing), and a cross-task budget counter **is** a check-then-act race. Fixed in the provider-routing PR: check and charge happen in one `BEGIN IMMEDIATE` transaction.
- Wrong: `resolver.ts` does not route worker providers (it binds models to Mastra agents); `oracle.ts` authorizes nothing (it judges acceptance); `language-adapters.ts` holds language ceilings, not provider selection; "self-development is safe in non-delegatable zones" inverts PR #58.

## Capability matrix (observed with probes only, no model call)

| Worker | Languages | Available | Authorized | Cost class | Allowed tasks |
| --- | --- | --- | --- | --- | --- |
| ollama `qwen3:8b-ctx8192` (codingWorkerGo / codingWorkerJs) | go, js | yes | default | local-free | small, low-risk, unambiguous, one file, the delegation gate's checks |
| codex CLI 0.161.0 | go, js | yes, a session is active | **no**: no allow-list entry; the operator's budget is $0 | unknown (subscription) | none |
| gemini CLI 0.63.0 | go, js | yes, sign-in not verifiable | **no** | unknown | none |
| TypeScript | | no worker | `ts` adapter disabled pending human approval | | none |

Reproduce with `npm run lead -- providers` (on master since #62). Re-probed on 2026-11-07 on master `bb01119`: unchanged (codex 0.161.0 and gemini 0.63.0 available, neither authorized, budget none, charged 0); Ollama was not running at that moment.

## Objectives

Both dogfood repositories are disposable, outside this runtime's own source, and live under `.workdir/projects/` (git-ignored, not published).

| Objective | Repository and base | Tasks | Result |
| --- | --- | --- | --- |
| `m12-quota` | Go `quota` at `6e29721` | t1-parse, t2-ledger | **CANCELLED**. Run 1 died with `run_restarted`: the Lead edited `src/` in the checkout whose `mastra dev` was watching it. Run 2: Qwen's attempt 1 validated the name before trimming it (verifier FAIL, `C_wrong_implementation`), attempt 2 changed nothing, attempt 3 was cut by the 30-min `task_timeout`. Re-planned. |
| `m12-quota-r2` | Go at `3de5c9f` | t1-entry, t2-parse, t3-ledger | **CANCELLED**. Qwen's t1-entry passed the runtime verifier three times; verified review rejected all three for `finding:comment_removed`. The Lead's plan had told the worker to replace a placeholder comment that review never lets a worker remove. **A Lead planning defect**, fixed in base `f64f3ad` (stubs carry no placeholder lines). |
| `m12-quota-r3` | Go at `f64f3ad` | t1-entry, t2-parse, t3-ledger | **ACCEPTED**. Integration tip `4f3cba0`; oracle `88ef09a938bc` PASS (`go vet`, `go test`), base FAIL; evidence `273e6476…` |
| `m12-retry` | JavaScript (CommonJS, Jest) at `d2a07cd` | t1-backoff, t2-retry | **ACCEPTED**, started by the queue. Integration tip `b9c097f`; oracle `5ef401e12eee` PASS (`npx --no-install jest --ci`), base FAIL; evidence `e04919d1…` |

| Task | Mastra run | Attempts | Claims | Qwen inference | Review |
| --- | --- | --- | --- | --- | --- |
| m12-quota-r3.t1-entry | `5ba68bde-a9fb-4cc1-b0f5-4f8f14832e83` | 1 | 1 | 9 min | APPROVED |
| m12-quota-r3.t2-parse | `ee358da3-843c-47f2-8c8f-d4b19a269bcd` | 1 | 1 | 10 min | APPROVED |
| m12-quota-r3.t3-ledger | `67a1c1b8-f6b5-407a-8841-14df0f61a4cd` | 1 | 1 | 11 min | APPROVED |
| m12-retry.t1-backoff | `362844bf-951e-4cd6-8f82-1163de549cb1` | 1 | 1 | 6 min | APPROVED |
| m12-retry.t2-retry | `b1d6647e-4fb6-4379-9862-3d1ff4dabca3` | 1 | 1 | 4 min | APPROVED |

Every oracle was pinned before the first claim (`pinnedBeforeFirstClaim=true`), lies outside the repository, worktrees and artifact root, and was first checked by the Lead against a throwaway reference implementation in a scratch directory: FAIL on the base, PASS on the reference. The reference was never delivered.

Usage: Ollama reports no token counts through this path, so tokens are `UNKNOWN` (never 0); cost is a known 0 (local-free). Paid calls: 0. Budget charged: 0 claims.

## Queue and supervisor

`lead supervisor start --queue --server http://127.0.0.1:4311` (isolated `AGENTIC_SCHED_ROOT`, `AGENTIC_MODEL_LOCK_DB`, `AGENTIC_ARTIFACT_ROOT`; `AGENTIC_ALLOW_PROVIDERS` empty) took `m12-quota-r3`, then `m12-retry`, then idled. While it was idle the Mac slept for about 15 minutes, its 90-second DB lease expired, and on wake it reported `supervisor ownership lost` and **failed closed, keeping its gate**, as the M11 runbook requires. The gate was left for a human to reconcile; no objective was running.

## Specialist review of the two PRs

The read-only specialist review workflow ran on the merged changes, in-process on local Qwen:

- `security-reviewer` (run `b273e502-7605-4d94-bb0a-493639294e95`): REPORTED, 0 findings, **0 tool calls**. It did not read the code, so this is not evidence of safety.
- `reliability-reviewer` (run `59741a00-075d-4dcf-8b3e-194efbc2cc8b`): INVALID_OUTPUT (the reply was not JSON).

The two run ids above come from the session log; they are not in the exported files, so they cannot be checked from this folder. The review is **inconclusive**. Independent review rests on the required human code-owner review.

## Limitations

- **At the time of the run (2026-10-22 and 2026-10-23), :4111 could not show this work.** It was another session's 12-day-old build reading the main checkout's production `scheduler.db`, with no `council` or `agents` endpoints. The M11 runbook forbids reusing that database, and stopping that server was not this session's call. M12 was observable on the isolated server (:4311) with the same console code from master. This describes October only; the current state is below.
- **Since 2026-11-07, :4111 is a different build, and it still cannot show this work.** The Studio on :4111 was replaced that day with a build of master `bb01119` (it has the `council`, `agents` and `meeting-suggestions` endpoints), so the endpoint gap above no longer exists. The reason it cannot show these objectives has changed to a data one: it reads the canonical `.workdir/scheduler/scheduler.db`, which lists only batches `M5-ESHOP-2A` and `M10-RL`, while the M12 batches exist only in this run's isolated state (`agentic-engineering-m12-exec/.workdir/scheduler/scheduler.db`: 4 batches, 12 tasks, 4 objectives). Making that data visible there is execution-data publication, which is not implemented (see Status at merge).
- The routing records and the queue ran from a **local** merge of the two PRs while they were drafts (`494209f`, not pushed); the execution server ran master `b9b00e1`. Both PRs are now merged, so the merged code is not byte-identical to what ran.
- Two small objectives with exact specifications and a 16 GB Mac do not measure a success rate. qwen3:8b needs 4 to 12 minutes per attempt here, so the 30-minute active budget fits about 2.5 attempts; that budget was not changed.
- Self-development of this runtime by workers stays closed (PR #58), and TypeScript stays disabled.
- A verifier step cancelled by the task timeout is labelled `E_verifier_infrastructure`, which is misleading.

## Status at merge (2026-11-07)

Rechecked against master `bb01119` before merging; the evidence above is unchanged and is a record of 2026-10-22 and 2026-10-23, not of today's tree.

- Verified from the files in this folder: 7 council calls (12 016 in / 7 910 out tokens, 0 tool calls, one trace), 4 objectives with the phases above, 12 tasks, 8 reviews (3 rejected, 5 approved), 5 routing rows, the five task run ids, and the oracle and evidence hashes named above.
- Verified in the current code: the 90-second supervisor lease, `lead providers`, the `E_verifier_infrastructure` label (so that limitation still stands), and that nothing reads `AGENTIC_MAX_CLOUD_COST_USD` or `AGENTIC_PAID_PROVIDER_ENABLED`.
- :4111 today (checked 2026-11-07, after the handoff) runs a build of master `bb01119`, not the 2026-10-24 build described in the October limitation. It has the `council`, `agents` and `meeting-suggestions` endpoints, but it reads the canonical `.workdir` database, so it does not show this isolated-state run.
- **Execution-data publication is not done for this run and is not implemented as a capability.** `AGENTS.md` makes publication a gate separate from code merge. This folder is a committed export of the run's records (`execution.json` and the council records): it preserves the facts and is **not** publication into the canonical view, and nothing here verifies that the isolated database was published. The gate stays unmet: on 2026-11-07 the Engineering Director approved closing the project with it as a scope exception. The isolated database (`agentic-engineering-m12-exec/.workdir/scheduler/scheduler.db`) must be preserved, this export stays, and :4111 shows only the canonical database.
- This is not a success rate. The accepted objectives are 2 of 4 attempted, each small and exactly specified, on a local 8B model.

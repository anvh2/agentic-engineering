# Reliability Lab, fault points and model-backed meetings

Carried from M10 and verified in M10.1. Nothing here runs in production unless the operator asks for it.

## Fault points (`src/runtime/reliability/faults.ts`)

Deterministic delays or injected errors at three named execution boundaries: `runner.before-permit`, `runner.after-permit`, `provider.before-spawn`. They let a test force an interleaving that otherwise depends on machine load ("the budget expires before the CLI is spawned") instead of widening a timeout until it stops happening.

- **Inert by default.** A plan does nothing unless the process was started with `AGENTIC_FAULTS_ENABLE=test`. Nothing in `src/` or `scripts/` sets it; the HTTP smoke harness passes a plan to its Mastra child explicitly (`faultEnv`).
- A plan naming an unknown boundary is refused (a typo must not silently test nothing). A delay ends at once when the caller's `AbortSignal` fires, as a real cancel would.
- `AGENTIC_FAULTS_LOG=<file>` appends one JSON line per firing: the evidence that the boundary was reached.

## Reliability Lab (`tests/reliability/`)

```shell
npm run reliability -- --scenario all --repeat 3 --concurrency 2 --out .workdir/reliability/run-1
```

Seven scenarios (`timeout-before-spawn`, `timeout-spawned-not-ready`, `timeout-after-ready`, `cancel-after-permit`, `lease-isolation`, `stale-lease`, `interrupted-run`), bounded repeats (at most 50) and concurrency (at most 4), one JSON evidence record per run plus a `summary.json`. A classifier labels every failure `product_defect`, `test_race`, `environmental` or `unknown`; a run that passed is `pass`. Exit code 0 iff every run passed. Smoke scenarios start a Mastra server child and a sandboxed fake CLI (no network, no account).

`lease-isolation` runs two real executions of one task id on two providers and records what it proved (`detail.proves`): a run's own permit blocks its own cancel confirmation, a sibling run's permit does not, and a permit nobody can attribute still does (run-scoped permits, `docs/architecture/runtime.md#persistence`).

## Acceptance oracle (`tests/reliability/oracle/`)

`m10_1-oracle.test.ts` is the pinned acceptance specification for M10.1 (run-scoped permits, acceptance truth, scoped promotion, plus the carried fault, smoke and runner cases). `oracle.json` records its sha256, owner, reviewer, review findings and amendment lineage. `run-oracle.ts` runs it against any commit in a throwaway worktree, refuses a changed oracle or a changed protected contract test, and supports a negative control (`--expect baseline`) and known-bad fixes (`--expect mutant --mutant <id>`).

## `lead meeting open|run|status|record|cancel`

Real, model-backed engineering meetings on the M9 collaboration store: the coordinator drives turns, the store enforces every rule, and each participant makes one bounded model call per turn.

- A participant only returns a message. It cannot decide, authorise or change tasks; only the chair records decisions.
- Round 1 is blind: nobody sees the others' first proposals.
- Local models use Ollama (`OLLAMA_BASE_URL`, default `http://localhost:11434`; the reply's model must equal the pinned one). A cloud provider (`gemini`, `codex`) takes a turn only if the operator allow-list carries `<provider>` or `<provider>:meeting-<sessionId>` (`AGENTIC_ALLOW_PROVIDERS` or `--allow-provider`); this is checked at `open` and again by every `run`. Provider turns run through the existing adapters in an empty scratch repository.
- Hard ceilings per participant: output tokens per call, invocations and total tokens per session, call deadline. A reply with unreported usage stops further calls (usage is never recorded as 0).
- The Engineering Lead's own turns are written with `lead meeting record` into the meeting's inbox while `lead meeting run` waits.

The decision and the evidence are in the store; `lead meeting status` and the Studio organization view read them.

### What a meeting is about: verified references (M12)

`lead meeting open` takes `--objective <id>`, `--batch <id>` and `--task <id>`. Each is checked read-only against the scheduler database before anything is contacted or written: only a **pinned** objective is verifiable (its lifecycle names its batch) and it contributes that batch; a submitted but unpinned objective is referenced with `--batch`, and a merely planned one has no scheduler work to attach to; a batch or task must exist, and all of them must agree. A reference that does not resolve, a reference flag without a value and a repeated one refuse the meeting (exit 2). The collaboration store itself still records an `objectiveId` label from other callers as given; the console never attributes through it. The Organization console attributes a thread only through a verified batch or task; a meeting opened without references is shown **Unattributed**, and nothing is inferred from titles or labels.

### When meetings happen

Nothing in the execution path opens a discussion or a meeting by itself: objective planning, the scheduler, the lifecycle driver and the supervisor never call the collaboration store, and an escalation is recorded as a lifecycle event and the task's state reason. A meeting exists only when the Engineering Lead (or an operator) runs `lead meeting open` about a decision that needs discussion: an architecture question, a significant blocker, an escalation that changes a plan. Use the references above so the meeting is attached to that work.

### Meeting suggestions (M12)

When an objective escalates for a **technical** reason, the lifecycle driver records a *suggestion* that the Lead hold a meeting. A suggestion is not a meeting: it opens no thread and no session.

| The escalated task's runtime failure category | Suggestion |
| --- | --- |
| `coding_attempts_exhausted` | `technical_escalation` |
| `review_rejected` (the repair corrections are used up) | `review_escalation` |
| `integration_conflict`, `integration_verification_failed`, `diverged_after_review` | `integration_failure` |
| the pinned oracle rejects the objective (`NOT_ACCEPTED`) | `acceptance_failure` |
| `forbidden_mutation`, `review_gate_blocked` (scope, security or policy findings), `escalated_by_reviewer` (untrustworthy evidence), `provider_not_authorized`, `source_tree_dirty`, `cancelled` | **none**: security, integrity, authorization, budget and operator stops are decided by an operator; no meeting can approve them. A held supervisor gate never reaches the lifecycle at all |
| timeouts, unavailable runtime or provider, lost leases, `dependency_failed`, anything else | none (retryable or derived) |

- **Evidence, not opinion.** The reason is the task's own runtime record (`<task> is <state> [<category>]: <state reason>`), with the task and its latest review decision as evidence. It is fixed when the suggestion is created; the table refuses any later change to its content, and nothing a model writes in a meeting can alter it.
- **References** are the scheduler's: project and batch from the batch row, the objective from its pinned lifecycle, and the **root** task of a correction chain.
- **Proposed participants** are a proposal only (the Lead as chair, the task's worker provider, a reviewer for review and integration failures). Opening the meeting still needs explicit, authorized `--participant` specs.
- **Bounded.** One suggestion per (batch, root task, category), ever: an objective that is resumed and escalates the same way again, a correction of the same task, or a dismissed suggestion is never suggested again. At most 3 per batch.
- **Explicit acceptance.** `lead meeting suggestions [--status pending]` lists them. `lead meeting open <session> --suggestion <id> ...` opens a real meeting about exactly that work (references verified again; a contradicting `--objective/--batch/--task` refuses) and marks the suggestion accepted in the same transaction, recording who accepted it (`--accepted-by`, default the Lead; otherwise one of the meeting's `--operator` ids). `lead meeting dismiss-suggestion <id> --by <id> --reason "..."` dismisses it. A suggestion is decided once.
- **Visible, labelled.** The Organization console lists them in the Meetings section under *Suggested meetings*, badged NOT MEETINGS, from the read-only `GET /control-center/v1/meeting-suggestions`, which returns every pending suggestion plus recent decided ones, shows an objective only when its pinned lifecycle confirms it, and reports `CORRUPT` instead of rows if the table's integrity triggers are missing. They never appear in the meetings list or the meeting counts.
- A suggestion and its `meeting_suggested` lifecycle event commit in one transaction. A failure to record them is audited (`meeting_suggestion_failed`) when possible and never changes the objective's outcome. The LIVE engineering council (`npm run council`) is a separate mechanism with its own database (`.workdir/council/council.db`); the console lists it under Council, never as an ordinary meeting.

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

`lead meeting open` takes `--objective <id>`, `--batch <id>` and `--task <id>`. Each is checked against the scheduler database before anything is contacted or written: the objective must have a lifecycle there and contributes its batch; a batch or task must exist, and all of them must agree. A reference that does not resolve refuses the meeting (exit 2). The Organization console attributes a thread only through a verified batch or task; a meeting opened without references is shown **Unattributed**, and nothing is inferred from titles or labels.

### When meetings happen

Nothing in the execution path opens a discussion or a meeting by itself: objective planning, the scheduler, the lifecycle driver and the supervisor never call the collaboration store, and an escalation is recorded as a lifecycle event and the task's state reason. A meeting exists only when the Engineering Lead (or an operator) runs `lead meeting open` about a decision that needs discussion: an architecture question, a significant blocker, an escalation that changes a plan. Use the references above so the meeting is attached to that work. The LIVE engineering council (`npm run council`) is a separate mechanism with its own database (`.workdir/council/council.db`); the console lists it under Council, never as an ordinary meeting.

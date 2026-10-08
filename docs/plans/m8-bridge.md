# M8 bridge: from a Lead-written draft to an automatic Engineering Lead

Status: first slice built (planning side). Execution stays an explicit step.

```
objective ─▶ deterministic research ─▶ Lead proposes (draft) ─▶ deterministic validation ─▶ plan.json  (human-visible)
                                          ▲                          │ rejected: errors fed back, bounded
                                          └──────── revise ◀─────────┘
plan.json ─▶ lead objective --submit (STALE_PLAN gate) ─▶ scheduler batch ─▶ lead run ─▶ M7 team ─▶ review ─▶ integrate
```

## Built

- `ClaudeEngineeringLead` implements the existing `EngineeringLead` (`research`, `plan`, optional `revise`). Research stays the
  deterministic read-only scan, so evidence never depends on model behavior.
- The model sees one bounded prompt (objective, ResearchContext, excerpts of relevant files, the worker policy rendered from the
  enforced constants) and replies with JSON text. It runs through `claude -p --tools ""` from an empty scratch directory: no tool
  can touch the repository or the scheduler. The reply is an untrusted draft that goes through `validatePlan`.
- `planObjective` asks for at most `--max-revisions` corrections (default 0: every revision is a paid retry, so it is an explicit opt-in,
  at most 2), feeding back the validator's issues. Every attempt is recorded (`plan.rejected.json` keeps the history; `plan.json` records the revision count).
- `--lead claude` requires `--max-budget-usd` (enforced per call by the claude CLI) and prints the worst-case total before the first call.
- Submitting is unchanged and explicit: `lead objective --submit <id>` (staleness gate), then `lead run --batch <id>`.

## Deliberately not built

- Autonomous plan -> execute. Nothing submits or runs a plan without the explicit command.
- Any default path that calls Claude. `--lead claude` is a billed call and has only been tested against a stand-in executable.
- Claude-driven research or repair loops, Telegram, dashboards, specialist workers.

## Next slices (each independently verifiable)

1. Run `--lead claude` once on a disposable fixture with the user's approval, compare its plan with the hand-written one.
2. Review/repair: feed a REJECTED review or an ESCALATED task back to the Lead as a new bounded planning problem.
3. Plan-level learning from escalations (e.g. the whitespace gate and `go test ./...` integration traps found in M7 smoke).

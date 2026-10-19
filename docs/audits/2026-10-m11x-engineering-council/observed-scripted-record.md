# Engineering Council srv-scripted-2 [SCRIPTED]

> **SCRIPTED**: canned replies from a test model. Proves wiring and rules, not model quality.

- Outcome: **decided** (decision m7 by council-architect: accept m1)
- Advisory only. Human approval: **pending**. Nothing was adopted. A human must accept or reject this proposed decision (for example as an ADR); no specialist can.
- Opened 2026-10-19T16:07:34.322Z, last message 2026-10-19T16:07:34.634Z, recorded 2026-10-19T16:07:34.640Z
- Mastra workflow run(s): 4254134d-2a12-48cb-8b52-32fd6dcdcd4b
- Integrity: record `e27798e66ab3480d`, meeting record `4b0a6f6c04bf7671`, events through 65

## Question

> Should the Mastra specialist workflow be allowed to re-ask a read-only specialist once when its reply is malformed, or should every retry belong to the durable scheduler?

## Panel

- **Architect** (`architect` v1.0.0, manifest `9d0185f8410e`) chair: scripted/scripted-council-1; read-only tools listFiles, readFile, searchFiles, gitDiff, gitStatus
- **Security Reviewer** (`security-reviewer` v1.0.0, manifest `f81acd1f0b69`): scripted/scripted-council-1; read-only tools listFiles, readFile, searchFiles, gitDiff, gitStatus
- **Reliability Reviewer** (`reliability-reviewer` v1.0.0, manifest `d1faebe167b0`): scripted/scripted-council-1; read-only tools listFiles, readFile, searchFiles, gitDiff, gitStatus

## Round 1: proposal

- architect — message proposal m1 at 2026-10-19T16:07:34.525Z run 0b6b6284-3a80-47e7-9965-97ca1df6fd92 trace 52c3716c044a422ba84118c841830ccb
  - position: Keep ONE manifest-bounded re-ask for read-only specialists inside the Mastra workflow; everything that can mutate stays with the scheduler and the coding runner.
  - rationale: The specialist workflow re-asks only when the manifest declares retry-once, at most one extra call, and a specialist has no write tool. Moving that single re-ask into the scheduler would add a lease cycle for a side-effect-free call and create a second place that counts attempts.
  - risks: A second retry authority could drift from the scheduler's budget.
  - evidence cited: docs/engineering/adr-agent-model-role-boundaries.md [exists], src/integrations/mastra/workflows/specialist-review-workflow.ts [exists]; 1 file-tool call(s) this turn
  - unknowns: Whether the manifest bound should also be persisted across restarts.
- security-reviewer — message proposal m2 at 2026-10-19T16:07:34.563Z run f2475287-09a5-4f21-867f-98337f860607 trace 52c3716c044a422ba84118c841830ccb
  - position: Allow no retry inside Mastra: a malformed reply fails the review, and the scheduler alone decides whether to ask again.
  - rationale: A retry loop outside the scheduler is control flow the scheduler cannot see or cancel. Even for read-only specialists, a re-ask re-sends repository-derived prompt text to the model, and an attempt budget that lives in two places is the kind of rule that exists only by convention.
  - risks: Prompt text is re-sent to the model on every re-ask.
  - evidence cited: src/integrations/mastra/specialist-agents.ts [exists], src/integrations/mastra/workflows/specialist-review-workflow.ts [exists]; 1 file-tool call(s) this turn
  - unknowns: Whether re-sent prompts can leak anything beyond the first call.
- reliability-reviewer — message proposal m3 at 2026-10-19T16:07:34.584Z run 7ea142d3-bf1d-4991-835e-2dbf1f7ce08d trace 52c3716c044a422ba84118c841830ccb
  - position: Allow the bounded re-ask only if its count is recorded durably, so a restart cannot grant a second budget.
  - rationale: The meeting coordinator already charges every reserved turn against a durable invocation budget and resumes after a crash; an in-process re-ask counter does not survive that restart, so the re-ask needs a durable record to stay bounded.
  - risks: After a crash an in-memory re-ask counter resets and the specialist is asked again.
  - evidence cited: src/runtime/collaboration/coordinator.ts [exists], src/integrations/mastra/workflows/specialist-review-workflow.ts [exists]; 1 file-tool call(s) this turn
  - unknowns: Whether a persisted per-claim attempt budget is worth a schema migration now.

## Round 2: critique

- architect — message objection m4 at 2026-10-19T16:07:34.593Z run 89f44811-f26d-4621-8db6-9529666777af trace 52c3716c044a422ba84118c841830ccb
  - OBJECTS to m2 (security-reviewer): Forbidding the re-ask turns one malformed JSON reply into a failed review and pushes a side-effect-free call through a lease cycle. The workflow's loop is already capped by the manifest at two attempts, so the claim that it is control flow nobody can see overstates it.
  - evidence cited: src/integrations/mastra/workflows/specialist-review-workflow.ts [exists]; NO file tool was used this turn: the cited files were NOT read by this call
  - concedes: The re-ask does re-send prompt text; it should be counted.
- security-reviewer — message objection m5 at 2026-10-19T16:07:34.602Z run ce014d69-cf51-4ae9-bc91-46a7587619bb trace 52c3716c044a422ba84118c841830ccb
  - OBJECTS to m1 (architect): The bound lives in a manifest field and an in-process loop. Nothing in the workflow persists the count, so a restart can grant the specialist another attempt; "bounded" is only true within one process.
  - evidence cited: src/integrations/mastra/workflows/specialist-review-workflow.ts [exists], src/integrations/mastra/specialist-agents.ts [exists]; NO file tool was used this turn: the cited files were NOT read by this call
- reliability-reviewer — message support m6 at 2026-10-19T16:07:34.613Z run a4025d16-53f5-4dd4-8a94-641383c8b2f4 trace 52c3716c044a422ba84118c841830ccb
  - supports m1 (architect): Checked the workflow: the loop is capped at two attempts and a specialist has no write tool, so the re-ask cannot repeat a side effect. My remaining concern, a durable count, is compatible with this position.
  - evidence cited: src/integrations/mastra/workflows/specialist-review-workflow.ts [exists]; NO file tool was used this turn: the cited files were NOT read by this call
  - concedes: The in-process counter does not survive a restart; that is the open point.

## Round 3: synthesis

- architect — message decision m7 at 2026-10-19T16:07:34.634Z run 0e1c2e28-9580-498c-b966-328fa0a7c983 trace 52c3716c044a422ba84118c841830ccb

## Disagreement

- m4: architect objects to m2 (outstanding)
- m5: security-reviewer objects to m1 (outstanding)

## Synthesis (proposed decision)

- Chair architect proposes **accept** m1 — CONTESTED, overruled objections m5 (authority: none)
- Decision: Keep the single manifest-bounded re-ask for read-only specialists in the Mastra workflow, add no Mastra step retries, and record every model call in an append-only journal so the budget survives a restart.
- Rationale: It removes no safety property, because a specialist cannot mutate anything, and avoids a second lease cycle. The Security Reviewer's and the Reliability Reviewer's shared point is accepted: the count must not live only in memory.
- Disagreements the chair lists:
  - Architect vs Security Reviewer: Whether Mastra may re-ask a read-only specialist at all [unresolved]
  - Security Reviewer vs Reliability Reviewer: Whether a durable count is sufficient to make the re-ask acceptable [accepted-tradeoff]
- Uncertainties:
  - Whether a persisted per-claim attempt budget is worth a schema migration.
  - Whether a re-sent prompt can expose anything the first call did not.
- Action items (for the human operator):
  - Decide whether to adopt this as an ADR amendment.
  - Decide whether the persisted attempt budget deserves its own migration.

## Accounting

- Turns reserved 7/9, recorded 7; model calls 7 (re-asks 0, invalid 0, failed 0); tokens in 370, out 170

## Limitations

- SCRIPTED: the replies are canned by the test model. This record proves wiring, rules and persistence, not what any model would say.
- The meeting is durable (hash-chained events in the council database) and resumable; the Mastra workflow run that wrapped it is not. A server restart loses the workflow run, not the meeting.
- Critique is bounded to one target per member (one message per turn). A member may disagree with more than one proposal in the text, but only one is linked.
- Specialists are advisory and read-only. The proposed decision has no authority: adopting an ADR or acting on it is a human step.

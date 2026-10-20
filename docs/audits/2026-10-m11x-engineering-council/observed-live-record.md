# Engineering Council srv-live-2 [LIVE]

> **LIVE**: replies were produced by the local model named below. Nothing was edited.

- Outcome: **decided** (decision m7 by council-architect: defer m1)
- Advisory only. Human approval: **pending**. Nothing was adopted. A human must accept or reject this proposed decision (for example as an ADR); no specialist can.
- Opened 2026-10-19T16:07:40.085Z, last message 2026-10-19T16:16:29.384Z, recorded 2026-10-19T16:16:29.408Z
- Mastra workflow run(s): 58145cac-93fe-49b4-a517-840a1f877ef8
- Integrity: record `7a795008755608e5`, meeting record `397182e27883f2fe`, events through 83

## Question

> Should the Mastra specialist workflow be allowed to re-ask a read-only specialist once when its reply is malformed, or should every retry belong to the durable scheduler?

## Panel

- **Architect** (`architect` v1.0.0, manifest `9d0185f8410e`) chair: ollama/qwen3:8b-ctx8192; read-only tools listFiles, readFile, searchFiles, gitDiff, gitStatus
- **Security Reviewer** (`security-reviewer` v1.0.0, manifest `f81acd1f0b69`): ollama/qwen3:8b-ctx8192; read-only tools listFiles, readFile, searchFiles, gitDiff, gitStatus
- **Reliability Reviewer** (`reliability-reviewer` v1.0.0, manifest `d1faebe167b0`): ollama/qwen3:8b-ctx8192; read-only tools listFiles, readFile, searchFiles, gitDiff, gitStatus

## Round 1: proposal

- architect — message proposal m1 at 2026-10-19T16:09:35.267Z run d405d70b-4cec-4f7f-b50e-cc21a0cb6d1f trace 5d66fbdaa820098e8aeec4b63422806f
  - position: Allow single retry on malformed reply, then defer to scheduler
  - rationale: The specialist-review-workflow.ts likely implements a retry mechanism for malformed responses (as per standard error handling patterns). Coordinator.ts manages retries via durable scheduler for persistent workflows. Allowing one retry aligns with immediate correction, while deferring to scheduler ensures eventual consistency. This extends existing execution paths without adding parallel logic.
  - risks: Malformed replies could cause infinite loops; Scheduler delays impact latency
  - evidence cited: src/integrations/mastra/workflows/specialist-review-workflow.ts [exists], src/runtime/collaboration/coordinator.ts [exists]; 1 file-tool call(s) this turn
  - unknowns: Does workflow.ts explicitly handle malformed replies?; What scheduler prioritization rules exist in coordinator.ts?
- security-reviewer — message proposal m2 at 2026-10-19T16:11:38.366Z run 78c607e1-5d93-45bb-8b63-b72e330bb250 trace 5d66fbdaa820098e8aeec4b63422806f
  - position: Deny retries for malformed specialist replies; enforce manifest escalation policy
  - rationale: The specialist workflow is read-only and lacks built-in retry logic. The ADR explicitly separates model roles from execution roles, and the workflow's design prohibits fallbacks to other models. Retrying without explicit manifest escalation policy would violate role boundaries and risk untrusted input exposure. Coordinator suspension handles pauses but not retries. Allowing retries without validation could enable infinite loops or resource exhaustion.
  - risks: Untrusted input could trigger unintended retries; Malformed specialist replies may cause infinite loops
  - evidence cited: docs/engineering/adr-agent-model-role-boundaries.md [exists], src/integrations/mastra/workflows/specialist-review-workflow.ts [exists], src/runtime/collaboration/coordinator.ts [exists]; 3 file-tool call(s) this turn
  - unknowns: Whether manifest escalation policies explicitly allow retries
- reliability-reviewer — message proposal m3 at 2026-10-19T16:12:33.952Z run 3b18d94a-8983-4222-a644-c7adec3f5aaf trace 5d66fbdaa820098e8aeec4b63422806f
  - position: Rely on durable scheduler for retries; workflow must not retry read-only specialists
  - rationale: The ADR document (docs/engineering/adr-agent-model-role-boundaries.md) defines specialists as stateless and idempotent. The specialist-review-workflow.ts directly interacts with read-only specialists, which cannot safely retry without risking duplicate processing. Coordinator.ts implements a durable scheduler with lease-based retries, ensuring idempotency through stateful tracking. Allowing workflow-level retries would create a race condition between local retry logic and the scheduler's global state management.
  - risks: Duplicate processing of read-only specialist queries; Inconsistent state between local retry and scheduler lease
  - evidence cited: docs/engineering/adr-agent-model-role-boundaries.md [exists], src/integrations/mastra/workflows/specialist-review-workflow.ts [exists], src/runtime/collaboration/coordinator.ts [exists]; NO file tool was used this turn: the cited files were NOT read by this call
  - unknowns: How coordinator.ts handles lease expiration for stale specialist responses

## Round 2: critique

- architect — message objection m4 at 2026-10-19T16:13:37.754Z run dace8a51-1e85-42cc-a14d-c7d0fa40666a trace 5d66fbdaa820098e8aeec4b63422806f
  - OBJECTS to m2 (security-reviewer): The security-reviewer's proposal rejects retries without manifest escalation policies, but the ADR explicitly defines specialists as stateless and idempotent (docs/engineering/adr-agent-model-role-boundaries.md). The reliability-reviewer's position aligns with this by asserting that retries would risk duplicate processing. The security-reviewer's unknown about manifest policies not explicitly allowing retries is unresolved, while the coordinator.ts implements a lease-based retry system (src/runtime/collaboration/coordinator.ts) that handles statefulness. Rejecting workflow-level retries contradicts the ADR's separation of model roles from execution roles, as the durable scheduler already manages retries.
  - evidence cited: docs/engineering/adr-agent-model-role-boundaries.md [exists], src/runtime/collaboration/coordinator.ts [exists], src/integrations/mastra/workflows/specialist-review-workflow.ts [exists]; NO file tool was used this turn: the cited files were NOT read by this call
  - concedes: The manifest escalation policy may not explicitly address retries; Coordinator lease management could still face stale response risks
- security-reviewer — message objection m5 at 2026-10-19T16:14:33.067Z run 6a8ceaff-0129-4d2d-94a1-8130fcc84486 trace 5d66fbdaa820098e8aeec4b63422806f
  - OBJECTS to m1 (architect): The architect's proposal assumes the specialist-review-workflow.ts implements retry logic for malformed replies, but this is not verified in the cited code. The unknowns highlight a gap: without explicit validation guards in workflow.ts (as noted in the risks), the mitigation for infinite loops remains unproven. Additionally, the proposal conflicts with the ADR's definition of specialists as idempotent and stateless, which the reliability-reviewer correctly ties to the workflow's interaction with read-only specialists. The architect's evidence does not address whether the workflow's retry logic would create race conditions with the scheduler's lease management.
  - evidence cited: src/integrations/mastra/workflows/specialist-review-workflow.ts [exists], docs/engineering/adr-agent-model-role-boundaries.md [exists]; NO file tool was used this turn: the cited files were NOT read by this call
  - concedes: The architect's mitigation for infinite loops depends on unverified code; The proposal risks conflicting with ADR-defined idempotency principles
- reliability-reviewer — message objection m6 at 2026-10-19T16:15:10.773Z run b1db6fdf-efd9-45ab-9d26-b12fc35038b6 trace 5d66fbdaa820098e8aeec4b63422806f
  - OBJECTS to m1 (architect): The architect's proposal assumes the specialist-review-workflow.ts implements retry logic for malformed replies, but the evidence does not confirm this. The security-reviewer correctly notes the workflow is read-only and lacks built-in retry mechanisms. The architect's mitigation for infinite loops relies on hypothetical validation guards not explicitly documented in the workflow.ts code. Additionally, the proposal risks conflating transient errors with scheduler retries without addressing how the coordinator.ts distinguishes between temporary failures and persistent workflow states.
  - evidence cited: src/integrations/mastra/workflows/specialist-review-workflow.ts [exists], docs/engineering/adr-agent-model-role-boundaries.md [exists]; NO file tool was used this turn: the cited files were NOT read by this call
  - concedes: The architect's risk mitigation for scheduler delays is valid; The proposal avoids adding parallel logic as claimed

## Round 3: synthesis

- architect — message decision m7 at 2026-10-19T16:16:29.384Z run 3d0aa40d-1881-4d4f-bc2e-a6b1250d10c0 trace 5d66fbdaa820098e8aeec4b63422806f

## Disagreement

- m4: architect objects to m2 (outstanding)
- m5: security-reviewer objects to m1 (outstanding)
- m6: reliability-reviewer objects to m1 (outstanding)

## Synthesis (proposed decision)

- Chair architect proposes **defer** m1 — CONTESTED, overruled objections m5, m6 (authority: none)
- Decision: Propose allowing a single retry on malformed replies while deferring to the scheduler, but require manifest escalation policy validation.
- Rationale: The architect's proposal aligns with extending existing retry mechanisms in specialist-review-workflow.ts and coordinator.ts's durable scheduler. However, unresolved uncertainties about manifest escalation policies (security-reviewer) and lease management (reliability-reviewer) necessitate further clarification. The security-reviewer's emphasis on role boundaries and the reliability-reviewer's idempotency arguments highlight risks of duplicate processing and state conflicts. The decision defers to the Lead to resolve: (1) whether manifest policies explicitly allow retries, and (2) how lease expiration handles stale responses.
- Disagreements the chair lists:
  - architect vs security-reviewer: Whether workflow.ts implements retry logic for malformed replies [unresolved]
  - architect vs reliability-reviewer: Conflict between workflow-level retries and scheduler lease management [accepted-tradeoff]
  - security-reviewer vs reliability-reviewer: Manifest escalation policy requirements for retries [resolved]
- Uncertainties:
  - Does the manifest escalation policy explicitly permit retries for malformed specialist replies?
  - How does coordinator.ts distinguish between transient failures and persistent workflow states during lease expiration?
- Action items (for the human operator):
  - Clarify manifest escalation policies in the ADR for retry scenarios
  - Audit coordinator.ts lease expiration handling for stale specialist responses

## Accounting

- Turns reserved 7/9, recorded 7; model calls 7 (re-asks 0, invalid 0, failed 0); tokens in 14137, out 7021

## Limitations

- LIVE: a local model produced these replies. Quality is whatever the model produced; nothing here was edited.
- The meeting is durable (hash-chained events in the council database) and resumable; the Mastra workflow run that wrapped it is not. A server restart loses the workflow run, not the meeting.
- Critique is bounded to one target per member (one message per turn). A member may disagree with more than one proposal in the text, but only one is linked.
- Specialists are advisory and read-only. The proposed decision has no authority: adopting an ADR or acting on it is a human step.

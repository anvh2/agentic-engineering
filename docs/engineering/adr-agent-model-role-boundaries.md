# ADR: Separate Agent Identity from Model and Execution Roles

- **Status:** Proposed for engineering-lead review
- **Scope:** PR #53 ECC capability integration
- **Date:** 2026-10-16
- **Decision owner:** Technical Architect / Engineering Director
- **Implementation owner:** Engineering Lead (Claude)
- **Intent:** Establish precise terminology and a portable execution model before extending agent/skill registration.

## Problem

The project currently mixes the terms Qwen, worker, agent, and reviewer. This is architecturally inaccurate: **Qwen is a model family, not an agent or a worker**. Coupling role names to inference engines makes routing, evaluation, Mastra observability and future migration ambiguous. A specialist agent using Qwen and a coding worker using Qwen are different configured execution roles, not different model types.

## Terminology contract

| Term | Meaning | Examples | Is it an authorization principal? |
|---|---|---|---|
| Model | Inference capability; produces text/tool-call proposals, not trusted execution evidence | Qwen3 8B, Claude, Codex-backed model | No |
| Provider / inference backend | API or local serving interface used to invoke a model | Ollama, Anthropic, OpenAI | No |
| Agent definition | Stable, portable identity with purpose, instructions, selected skills, declared capabilities and output contract | code-explorer, security-reviewer, go-coding-worker | No |
| Agent instance / run | An execution of a configured agent in a particular task/session with pinned model, context and permissions | run-123 of security-reviewer | No, unless bound to independently authenticated runtime authority |
| Worker | A task-execution **role** of an agent, not a model or provider | Go coding worker, JS coding worker | No |
| Specialist | A focused **role** of an agent (research, review, test analysis), not a model | spec-miner, PR test analyst | No |
| Skill | Versioned, selectively loaded task procedure and constraints; never grants tools or permission | go-testing, threat-modeling | No |
| Tool | Host-owned capability with checked scope and concrete implementation | repository read, write, verifier | Tool's runtime authorization is required |
| Orchestrator | Coordinates task planning, routing, execution lifecycle and retries | Mastra workflow plus durable scheduler | No automatic mutation permission |
| Runtime authority | Independently enforced policy, authenticated approval, verifier and persisted evidence | scheduler, approval grants, verifier | Yes, only through explicit validated contracts |
| Independent reviewer | Reviewer outside the producing execution path with an authenticated identity and evidence-backed verdict | external Codex review path | Only when runtime has authenticated and authorized it |

**Model != agent; agent != worker; worker is an agent role. Provider != model. Skill != permission. Model-generated review != trusted runtime approval.**

## Architecture

```text
Technical Architect / Engineering Director
             |
       Engineering Lead agent (currently backed by Claude)
             |
      Durable scheduler / orchestration control
             |
      Task + pinned policy + selected skills
             |
  +----------+-----------+--------------------+
  |                      |                    |
Research / design    Coding worker       Specialist reviewer
agent definition     agent definition    agent definition
  |                      |                    |
  +----------+-----------+--------------------+
             |
       Harness adapter (Mastra today)
             |
   Provider adapter + pinned model
  (e.g. Ollama/Qwen; other backends later)
             |
  Scoped host tools + telemetry + execution evidence
             |
   Deterministic verifier + authenticated approval
             |
 Independent review & explicit integration decision
```

Mastra is the current **adapter, execution integration and observability surface**, not the source of the agent's identity or authorization. Portable definitions live outside `src/integrations/mastra/`. A future harness must be able to consume the same IDs, skills, capability requirements and outcome schemas through another adapter.

## Contracts and invariants

1. Stable `agentId` identifies a reusable role; `runId` identifies one execution. Neither may be inferred from a model name.
2. `providerId` and `modelId` are separate, pinned per run, logged with version/capability metadata. Routing may change the chosen model without renaming the agent.
3. Agent definitions declare `role`, `purpose`, `skillIds`, `requiredCapabilities`, `allowedToolKinds` and `outputSchemaVersion`. Declaration alone grants no access.
4. Selected skills are versioned, scope-limited and pinned to the task/context digest; transitive dependency resolution must be bounded and explicit. Skills may advise tool selection but not add permissions.
5. The runtime independently computes the intersection of task policy, authenticated principal, tool capabilities, workspace scope and harness support. Any missing requirement fails closed; no implicit provider/model/tool fallback.
6. Model outputs are untrusted proposals. Host tool execution, independent verifier results, approval records and integration state are authoritative.
7. Reviewer identity and independence are enforced with runtime-authenticated provenance, **not** a caller-supplied verifier string or by prompt instruction.
8. A specialist can be read-only, a coding worker can mutate only authorized paths, and both may use the same Qwen model through Ollama. Identical model does not imply independent review.
9. Mastra registers each agent under a stable ID, and telemetry correlates `taskId`, `runId`, `agentId`, `role`, `providerId`, `modelId`, `skillVersionDigests`, tool calls and outcomes. Sensitive inputs are redacted.
10. Importing ECC definitions or switching harnesses must not silently broaden tool access, review authority, or task budgets.
11. Agent specialization is evaluated against a baseline (quality, accepted-task cost, context and latency); a large role/skill catalog is not itself success.
12. Compatibility: preserve existing Go/JS delegation gates; TypeScript delegation is not automatically enabled by creating a TypeScript reviewer.

## Portable data shape (illustrative, NOT a committed runtime API)

```ts
interface PortableAgentDefinition {
  agentId: string; // stable: 'security-reviewer'
  role: 'lead' | 'coding-worker' | 'specialist-reviewer' | 'researcher';
  purpose: string;
  skillRefs: { id: string; revision: string; digest: string }[];
  requiredCapabilities: string[];
  requestedToolKinds: string[]; // advisory; runtime reduces to authorized grant
  outputSchemaVersion: string;
}

interface AgentExecutionBinding {
  runId: string;
  taskId: string;
  agentId: string;
  providerId: string; // 'ollama'
  modelId: string; // 'qwen3:8b'
  harnessId: string; // 'mastra'
  contextDigest: string;
  policyDigest: string;
}
```

Examples:
- `security-reviewer` + `ollama` + `qwen3:8b`: advisory read-only specialist.
- `go-coding-worker` + `ollama` + `qwen3:8b`: bounded edit-capable task executor.
- `security-reviewer` + a different supported inference backend later: **same agent identity**, distinct provider/model binding and separate benchmark evidence.

## Migration / PR #53 implementation review checklist

- Audit variable names, comments, docs and Studio labels that call Qwen a worker or confuse provider with model.
- Keep portable agent/skill definitions framework-agnostic and render them via the Mastra adapter.
- Verify `codingWorkerGo` / `codingWorkerJs` and specialist agents obey the same run-identity and telemetry contract.
- Introduce a genuine scheduler-to-specialist invocation path; appearing in Studio alone is not end-to-end support.
- Ensure runtime-owned authorization, repository RequestContext and independent reviews are not bypassed by direct Studio usage.
- Add deterministic tests for model substitution retaining `agentId`, provider incompatibility refusal, permission intersection, pinned skills/context, and correlated logs.
- Do not retroactively claim the 16 specialist definitions or 40 skill summaries provide complete ECC workflows.
- Defer **live provider and Mastra smoke tests** until the user-approved final validation phase, while running typecheck, unit, deterministic integration and security tests during development.
- Treat this ADR as **proposed** until Claude reviews implementation details. Do not silently rewrite existing APIs based solely on these illustrative interfaces.

## Lifecycle, retry, cancellation and idempotency ownership (peer discussion, 2026-10-19)

Outcome of the time-boxed discussion `architecture-discussion-20261019-001`. This section records ownership **as implemented in PR #53**;
it changes no behaviour. Positions are advisory until a human accepts this ADR.

| Concern | Owner | Evidence |
| --- | --- | --- |
| Persistent task state, leases, fencing epochs, reconciliation after a crash | Durable scheduler (`src/runtime/scheduler/`) | `store.ts` transitions with `expectFrom` + fence; `scheduler.ts` `recover()`; reliability scenarios `stale-lease`, `interrupted-run` |
| Task-level re-claim (a new attempt at the whole task after a lost lease) | Scheduler, bounded by `maxClaims` (default 3, max 10); a paid provider's task is never requeued on the operator's behalf | `scheduler/types.ts:78`, `scheduler.ts:483` |
| Coding retries (fresh-context attempts, default 3) and the single runtime retry (`MAX_RUNTIME_RETRIES = 1`) | Coding runner; a provider's limits can only lower these | `execution/coding-task-runner.ts:209,381-382,451` |
| PASS/FAIL | Runtime verifier only | `coding-task-runner.ts`, `docs/architecture/runtime.md` |
| Typed composition, specialist invocation, traces | Mastra workflows. **No Mastra step retries are configured.** The coding workflow has no retry of its own. The specialist workflow has one bounded loop: a *read-only* specialist gets at most one retry (`attempts <= 2`, set by the manifest's `onInvalidOutput: retry-once`) and only for an unparseable reply; a provider error, timeout or cancel returns immediately | `coding-task-workflow.ts:32`, `specialist-review-workflow.ts:27,231`; source-invariant tests in both `*.test.ts` |
| At-most-once mutation per workflow run, including Mastra re-executing a "running" step on boot | Workflow run marker (`claimExecution`, exclusive create) plus the scheduler's recorded run id | `coding-task-workflow.ts:150-165`, `scheduler.ts:284` |
| Cancellation | Scheduler/lead records `CANCELLED` first (durable truth), then asks the executor to stop the run; the runner owns process-group termination and permit release | `lead/cancel.ts:25-37`, `gemini-scheduler.test.ts` cancellation tests |

**Unresolved trade-off (deferred, not implemented here):** the retry layers multiply. For the free local default the worst case is
`maxClaims (3) x coding attempts (3) x (1 + runtime retry 1) = 18` model invocations for one task, because a re-claim after a lost lease starts
a fresh attempt budget. A single budget spanning claims would be tighter but needs the attempt count persisted in the scheduler store, which is
a schema change requiring a migration; it is therefore not done in this PR. Paid providers are already excluded from re-claim.

## Consequences

**Benefits:** clear vocabulary; model-agnostic agents; portable skills; accurate per-agent Mastra monitoring; easier routing, benchmarking and migration; fewer accidental privilege assumptions.

**Tradeoffs:** explicit run bindings and adapter contracts add schema/versioning work; changing a model requires fresh compatibility and benchmark evidence; existing agent registrations may need refactoring.

**Non-goals:** installing ECC globally, migrating away from Mastra immediately, granting specialist mutation permissions, enabling TypeScript coding delegation, merging PR #53, or claiming independent approval from two Qwen roles.

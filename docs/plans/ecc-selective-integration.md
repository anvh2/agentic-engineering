# ECC selective integration — consolidated engineering blueprint

**Status:** Proposed, research/design only — not an implemented integration  
**Upstream:** [affaan-m/ECC](https://github.com/affaan-m/ECC), inspected at `b92f181b3b748d1abbc2afd94af6aa7d8c8fca29` (2026-10-12)  
**Target:** Agentic Engineering, an autonomous *software engineering team*, not a general business-agent company.  
**Stacked on:** PR #51 `feature/language-adapter-foundation` at `ee89813b3588cb7e374d32e155c121fc1cd4d5d1`.

## Decision

Track **all seven ECC findings in one integration PR** with separately reviewable commits and bounded gates. Reuse *ideas and limited, attributed source* where useful; **do not merge/fork the entire ECC repository, run its installer, load its global hook configuration, or grant ECC content additional authority**.

This initial commit is an evidence-oriented blueprint, **not a claim that ECC features are installed or that a real benchmark has passed**. Implementation should occur only after PR #51's approval/context/security contracts stabilize and independent review accepts them. No active session worktrees or live processes should be touched.

## Findings and requirements

| Priority | Finding | Integration target | Acceptance evidence |
| --- | --- | --- | --- |
| P0 | Layered rules + selective skills | Versioned, explicitly allowlisted, *task-specific* skill/rule resolution by language, domain and task scope; prompt/context snapshot includes exact content digests | Go sees Go + common; JS sees JS + common; unrelated content excluded; changes invalidate pinned context; registry cannot grant tools/verifiers |
| P0 | Agent security hardening | Translate the upstream trust-boundary guidance into threat matrix and deterministic negative tests for tool/path/argv/identity/reviewer-evidence boundaries | Demonstrate denied forgery, cross-worktree writes, expanded verifier argv, review evidence mismatch, malicious injected content; retain OS sandbox and fail-closed routing |
| P1 | Continuous learning v2 | Project-scoped *candidate lessons* derived from **verified** task outcomes, with provenance, confidence and immutable versions | Failed or unverified worker claims never auto-promote; project isolation; rollback; poison-resistance tests; candidate != approved skill |
| P1 | ADR / context & decisions | Read versioned ADRs, accepted decisions and source references when composing Lead and reviewer context | Reset session reconstructs decision and reason from repo/evidence; no fabricated approval; ADR version/digest pinned with design |
| P1 | Session lifecycle hooks | Optional bounded capture at session start, checkpoint/pre-compact and end, feeding existing durable state, not creating another scheduler | Idempotent resume; no duplicate tasks or provider calls; malformed/partial hooks fail safe; no live credentials/transcripts copied |
| P2 | Context budget | Deterministic context selection with quotas and content-priority, lazy skill loading and overflow reporting | Measure actual token/context overhead (or documented estimates), omission policy; mandatory approved design/acceptance never silently dropped |
| P2 | Specialized agent catalog | Curate only relevant role references (architect, Go/JS reviewer, security reviewer, test analyst); keep existing Lead/Worker/Independent Reviewer authority model | Role templates cannot approve own code or bypass review; evaluate improved acceptance vs baseline before adoption |

## Proposed boundaries

1. **Runtime is authoritative** for permissions, approved-design binding, mutable paths, verifier commands, retries, persistence and PASS/FAIL. Skills/rules/ADR text remain **untrusted instructional content**.
2. **Engineering Lead owns** language-independent HLD/LLD/ADR/task decomposition and ordinary delegated design approval. Language adapters supply conventions, never permission ceilings.
3. **Workers receive** the exact selected, pinned context snapshot; **independent reviewers compare** the same snapshot and evidence, without re-resolving mutable latest rules.
4. The curated knowledge catalog needs explicit source SHA/version, license attribution, language applicability, size limits and content digest. Do not execute upstream Markdown, hooks or scripts on import.
5. Keep TypeScript delegation disabled until runtime-owned offline typecheck, targeted verifiers and negative tests exist. Ruby remains out of scope.
6. Use isolated fixtures/checkouts in `agentic-engineering/.worktrees/` only when separately approved for implementation; never operate on sibling active worktrees or live Mac Studio processes/services/databases.
7. **No production integration while PR #51 is red or its reviewer-consistency interfaces are unstable.** Rebase the stacked branch after PR #51 fixes are independently accepted; review resulting diff.

## Implementation sequence inside this single PR (future commits)

- **Gate A — Research and compatibility:** audit upstream source/license/dependencies/hook side effects and pin SHA; map overlaps with repository language adapters, task contracts, approvals, evidence and scheduler. Assign Adopt/Adapt/Reject to each finding. No install.
- **Gate B — P0 knowledge selection:** read-only catalog + deterministic resolver + context digest pinning + Go/JS tests; security threat matrix/negative cases. No permission expansion.
- **Gate C — P1 continuity:** ADR lookup and session checkpoint integration on existing durable storage; candidate lesson extraction from runtime-verified accepted outcomes only; human/delegated Lead governance for promotion and rollback.
- **Gate D — P2 optional optimization:** context budgeting and curated specialist templates; only enable if benchmarks justify them and evidence stays consistent.
- **Gate E — Real verification and independent review:** targeted/unit/negative tests, full `npm test`, real sandbox E2E on disposable fixture (no paid providers by default), independently reproduced failures, and Codex review. Preserve exact commands, SHA and test totals.

## Benchmark design

Compare **existing agentic-engineering baseline** versus **curated-ECC-enabled** path using identical pinned model/provider, task fixtures, accepted design, tool ceilings, runtime verifier and Oracle, attempt/time/token budgets and machine state. Cover Go bug fix, JavaScript feature, malicious prompt, design-change/retry and interruption/resume. Prefer paired repeated trials with seeds where supported. Record:

- First-pass independent acceptance and accepted objectives per run
- Attempts/retries, elapsed time, context tokens and cost per accepted objective
- Security boundary violations, false PASS, design drift and recovery correctness
- Failures and confidence intervals/sample counts rather than claims from tiny trials

**Promotion gate:** no security regression or false PASS; at least one predeclared effectiveness metric improves reproducibly without unacceptable cost or latency regression. Otherwise revert/disable the skill.

## Upstream references checked

- [ECC README](https://github.com/affaan-m/ECC)
- [Rules README](https://github.com/affaan-m/ECC/blob/main/rules/README.md): common + language-specific rule layering
- [Hooks README](https://github.com/affaan-m/ECC/blob/main/hooks/README.md): session lifecycle and Pre/PostToolUse hooks; hook metadata fingerprints
- [Continuous Learning v2](https://github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md): project-scoped confidence-weighted instincts and promotion
- [Agent Security Hardening](https://github.com/affaan-m/ECC/blob/main/skills/agent-security-hardening/SKILL.md)
- [Architecture Decision Records](https://github.com/affaan-m/ECC/blob/main/skills/architecture-decision-records/SKILL.md)
- [Context Budget](https://github.com/affaan-m/ECC/blob/main/skills/context-budget/SKILL.md)
- [Agent catalog](https://github.com/affaan-m/ECC/tree/main/agents)

Upstream descriptions are **not proof** of equivalent functionality or runtime guarantees. Any source copied into this project must retain applicable MIT copyright/license notices and be reviewed per file and dependency.

## Open questions for Claude/Codex review

- Where should content manifests and snapshots live so they reuse PR #51's evidence contracts rather than introducing a competing context authority?
- Can lesson promotions be made transactional and rollbackable under the existing runtime without trusting provider output?
- Which ECC lifecycle hooks materially improve session recovery beyond the current M11 checkpoints, and which should be rejected as redundant?
- What is the minimal first A/B trial that does not trigger expensive providers or mutate live worktrees?

**Merge gate:** This blueprint alone is not approval to deploy integration; independent architectural review, implementation evidence and CI must be added before marking the stacked PR ready.

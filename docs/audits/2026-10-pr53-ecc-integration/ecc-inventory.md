# ECC capability inventory

**Upstream:** [affaan-m/ECC](https://github.com/affaan-m/ECC), MIT, pinned at commit `b92f181b3b748d1abbc2afd94af6aa7d8c8fca29` (2026-10-11). The tree contains 71 agent prompts, 311 skills, 23 rules, 97 command files, 68 top-level scripts, 93 library modules (112 entries in `scripts/lib` including subdirectories) and 420 test files.
**Method:** implementation files and their tests were read, not README claims. "Maturity" is ECC's own state: *working* (code with tests), *partial*, *disabled* (code present, execution switched off by its authors), *prompt* (a Markdown instruction document; its quality is untested by ECC), or *experimental*.
**Attribution:** adapted content restates workflows in original wording and names its source files in each manifest's `provenance`; ECC's MIT notice is in `engineering/NOTICE`. No ECC script, hook, installer or Markdown file is copied, loaded or executed.
**Decision vocabulary:** Adopt (use as is), Adapt (take the idea, reimplement against our authority model), Replace (we already have a better-fitting mechanism), Defer (valuable, not now), Reject (conflicts with our architecture).

Principle applied to every row: **adopt proven engineering value, not complexity.** A feature is not valuable because ECC ships it.

## A. What ECC provides, and what we did with it

| # | Capability | ECC source (at pinned SHA) | ECC maturity | Existing equivalent here | Decision |
| --- | --- | --- | --- | --- | --- |
| 1 | Canonical-JSON hashing with strict value handling | `scripts/lib/eval-harness/canonical.js` | working (`tests/lib/eval-harness/canonical.test.js`) | ad-hoc `JSON.stringify` hashes | **Adapt**: `canonical.ts` refuses NaN, cycles, non-plain objects instead of coercing |
| 2 | Hash-linked evidence capsule journal | `eval-harness/capsule.js`, `envelope.js` | working (`capsule.test.js`, `envelope.test.js`, `security.test.js`); ECC states a hash chain does not stop an operator who replaces the whole log | none | **Adapt**: `engineering-capsule.ts`, plus signed receipts (ECC leaves signing as a detached interface) |
| 3 | Offline-verifiable receipts, truncation and stale-checkpoint detection | `eval-harness/receipt.js` | working (`receipt.test.js`) | none | **Adapt**: Ed25519 `evidence-signer` receipts bound to run id, count, root, artifact digest |
| 4 | Candidate execution gate with tripwires | `eval-harness/gate.js` | **disabled by its authors**: "no verified OS containment backend exists" | runtime sandbox (`src/runtime/sandbox`) | **Reject** the gate; keep its lesson. We never claim containment from a copied directory or a flag; fixtures carry commands only after adapter-ceiling validation |
| 5 | Replay-safe tool fixtures | `eval-harness/replay.js` | partial ("first slices") | scripted-model tests | **Defer**: scripted models give deterministic replay for agents now |
| 6 | Retrospective grouping of capsules | `eval-harness/retrospective.js` | working, report-only | learning log | **Defer** |
| 7 | Skill health, versioning, provenance, tracker | `scripts/lib/skill-evolution/*.js` | working (`skill-evolution*.test.js`) | `engineering-skill-health.ts` (unmeasured vs healthy) | **Adapt**: per-version health from signed outcomes, `recommendActions`, rollback by re-promotion |
| 8 | Project-scoped instinct learning with confidence | `skills/continuous-learning-v2` (SKILL.md, `instinct-cli.py`, observe hooks, `config.json`) | working but promotes by observation frequency and model-derived confidence | none | **Adapt, with a stricter rule**: only runtime-verified, independently reviewed outcomes feed candidates; confidence is a Wilson lower bound; activation needs a signed promotion; global scope needs independent cross-project corroboration |
| 9 | Specialist agent role definitions | `agents/*.md` (71 files) | prompt | 2 coding workers | **Adapt**: 20 roles chosen for relevance (see C); each is a manifest with tool boundary, output contract, escalation policy and scenarios; no prompt text copied |
| 10 | Skill library | `skills/*/SKILL.md` (311) | prompt (some with scripts) | none | **Adapt**: 37 skills selected by value for a Go/JS autonomous-engineering runtime; workflows restated, with executable selection scenarios |
| 11 | Layered rules (common + language) | `rules/` (23 files) | prompt | `LANGUAGE_ADAPTERS` conventions | **Replace**: adapters already own conventions and permission ceilings; skills add task-relevant guidance |
| 12 | Lifecycle hooks (SessionStart, PreCompact, PreToolUse, PostToolUse, Stop) | `hooks/hooks.json`, `scripts/hooks/*.js`, `hooks.metadata.json` | working for Claude Code (`tests/hooks`) but installed machine-wide | none | **Adapt the policy, reject the installer**: pure decision functions, durable ordered log, no shell execution, no global configuration |
| 13 | GateGuard fact-forcing before edits | `scripts/lib/gateguard-*.js`, `scripts/hooks/gateguard-*.js` | working (many tests) | runner mutation policy + sandbox | **Defer**: our runtime enforces scope in code; worth revisiting for the Lead's own edits |
| 14 | Hook metadata fingerprints | `hooks/hooks.metadata.json` | working | event fingerprints | **Adapt**: canonical event fingerprints and replay detection |
| 15 | Agent security hardening guidance | `skills/agent-security-hardening`, `agents/security-reviewer.md`, `the-security-guide.md` | prompt | threat matrix in findings register | **Adapt**: threat-modeling, authorization-boundary, prompt-injection and secrets skills, each tied to enforcing code and negative tests |
| 16 | Prompt Defense Baseline in every agent | `agents/*.md` header | prompt | none | **Adapt as defense in depth only**: boundaries are rendered into every specialist, but the controls are code (read-only tool table, root in `RequestContext`, strict report schema) |
| 17 | ADR workflow | `skills/architecture-decision-records`, `recursive-decision-ledger` | prompt | `pinAdr` in memory | **Adapt**: `DurableDecisionLog` with signed acceptance, atomic supersession and task traceability |
| 18 | Context budget and cost-aware pipelines | `skills/context-budget`, `cost-aware-llm-pipeline`, `scripts/lib/context-selection.js`, `context-retrieval.js` | working | `EngineeringKnowledgeCatalog.resolve` budget | **Adapt**: promoted-only, budgeted, dependency-aware selection; mandatory design/verifier text is never in the optional budget |
| 19 | Memory persistence and unified memory | `hooks/memory-persistence`, `scripts/lib/memory-vault*.js`, `skills/unified-memory` | working | durable scheduler and session storage | **Replace**: one source of truth; hooks and checkpoints project from it |
| 20 | Worktree orchestration | `scripts/orchestrate-worktrees.js`, `orchestrate-codex-worker.sh`, `skills/team-agent-orchestration` | working scripts | scheduler, `WorktreeManager`, DAG validation | **Adapt the planning discipline** (DAG, file ownership, handoff); reject running ECC's scripts: we do not build a competing scheduler |
| 21 | Doctor, status, repair, session inspection, harness audit | `scripts/doctor.js`, `status.js`, `repair.js`, `session-inspect.js`, `harness-audit.js` | working | `lead status`, control center | **Adapt, read-only**: `npm run engineering -- status|agents|skills|validate|drift|render`, JSON report, Studio route. Reject `repair`/install lifecycle (writes configuration) |
| 22 | Install lifecycle and manifests | `scripts/install-*.js`, `manifests/*` | working | none | **Reject**: it mutates machine and user configuration; we install nothing globally |
| 23 | Multi-harness conversion | `scripts/qwen-adapt-agents.js`, `gemini-adapt-agents.js`, `lib/agent-ir.js`, `harness-capabilities.js` | working | provider registry | **Adapt**: portable manifests, capability negotiation with explicit unsupported outcomes, a Claude Code renderer that prints text and installs nothing. Other harness renderers deferred |
| 24 | Dashboards and control pane | `ecc_dashboard.py`, `scripts/dashboard-web.js`, `control-pane.js`, `docs/control-plane/*` | working / documentation | control center, Mastra Studio | **Defer**: the JSON status route covers monitoring needs; docs/control-plane is documentation-only |
| 25 | `ecc2` Rust control plane | `ecc2/` | experimental | scheduler | **Reject**: a competing control plane |
| 26 | Slash commands (97) | `commands/*.md` | prompt | `lead` CLI | **Reject**: not applicable to our CLI-driven Lead |
| 27 | Parallel reviewer workflow | `workflows/orch-review.workflow.js` | partial | consensus + independent reviewer | **Adapt the idea**: findings from several specialists merge in `engineering-review-consensus.ts`; HIGH/CRITICAL need independent signed verification |

## B. Where each adopted capability lives, how it is tested, what it is expected to change

| # | Integration point | Tests (positive, negative, concurrency, recovery) | Measurable outcome | Measured? |
| --- | --- | --- | --- | --- |
| 1 | `src/runtime/knowledge/canonical.ts` | key-order, NaN/cycle refusal, secret canaries (`canonical` use throughout) | hash stability across key order | yes (unit) |
| 2, 3 | `engineering-capsule.ts` | `engineering-capsule.test.ts`: tamper, truncation, extension, wrong run, wrong key, replayed key, credential refusal | forged-chain acceptance 0 of 1 | yes (unit, attack A01-A03) |
| 7 | `engineering-skill-health.ts`, `engineering-learning.ts` | `engineering-learning.test.ts` end to end decline → recommendation → signed rollback | decline detected before rollback | yes (unit) |
| 8 | `engineering-learning.ts` (+ `engineering-knowledge-store.ts` for activation) | 11 tests: unsigned/self-reviewed/unverified refused, frequency never promotes, project isolation, global needs independent reviewers, idempotent append-only log, calibration | candidates only from verified acceptances | yes (unit) |
| 9 | `engineering/agents/*.json`, `packs/agents.ts`, `integrations/mastra/specialist-agents.ts`, `specialist-review-workflow.ts` | `packs.test.ts`, `specialist-agents.test.ts`, `specialist-review-workflow.test.ts`: tool boundary, RequestContext, refusals before inference, forged verdicts, timeout, cancel, no fallback | read-only enforced for 20 of 20 roles | yes (unit/integration, scripted model) |
| 10 | `engineering/skills/*.json`, `packs/skills.ts` | scenarios (148+), selection tests, hostile-text test, pin test through store, router and runner | context 1.3 KB/task vs 22.3 KB naive | yes (benchmark) |
| 12, 14 | `engineering-hooks.ts`, `engineering-hooks-store.ts` | malformed/malicious events, ordering, replay, restart resume, corrupted log, session isolation | 0 replayed side effects on resume | yes (unit) |
| 15, 16 | threat skills, `repository-tools.ts` secret denylist, `packs/agents.ts` | `repository-tools-secret-files.test.ts`, workflow hostile-objective and credential tests | credential reads refused 6 of 6 patterns | yes (unit) |
| 17 | `engineering-decisions.ts` | `engineering-decisions.test.ts`: signed accept, replay, atomic supersession, immutability, traceability, not-an-approval | 0 accepted-ADR approvals | yes (unit) |
| 18 | `packs/skills.ts` (`selectSkills`, `pinSkillsForTask`) | `packs.test.ts`, `pin.test.ts`, `tests/bench/engineering-pack.test.ts` | selection F1 0.88 before tuning (author-labelled) | yes |
| 20 | `engineering/skills/worktree-coordination.json`, `engineering-orchestration.ts` | `engineering-orchestration.test.ts` (DAG, cycles, eligibility) | n/a | unit only |
| 21 | `engineering-control.ts`, `engineering-cli.ts`, `engineering-status-route.ts` | `engineering-cli.test.ts` (11), route test (3): read-only proof, drift, probe is loopback-only | n/a | unit |
| 23 | `packs/agents.ts` `negotiate`, `renderClaudeCodeAgent` | `packs.test.ts` capability negotiation and rendering | explicit unsupported outcomes | unit |
| 27 | `engineering-review-consensus.ts` | 9 consensus tests + end to end signed findings | n/a | unit |

## C. Specialist roles: which ECC roles became agents, and why

Adopted (20): code-explorer, spec-miner, architect, engineering-planner, security-reviewer, go-reviewer, javascript-typescript-reviewer (one role for both ecosystems), ruby-reviewer and rust-reviewer (review only), pr-test-analyzer (also covers the Test Analyst role: two roles with one job were merged), silent-failure-hunter, build-error-resolver, performance-optimizer, database-reviewer, reliability-reviewer, refactor-reviewer, documentation-reviewer, harness-optimizer, agent-evaluator, release-readiness-reviewer.

Not adopted: the remaining roughly 50 ECC roles for stacks and domains this repository does not use (Swift, Kotlin, C++, PyTorch, healthcare, SEO, network, marketing, ...), `loop-operator` and `chief-of-staff` (autonomy and scheduling belong to the existing scheduler), `gan-*` (generator/evaluator loops need an evaluation basis we have not measured), `opensource-*` (release packaging), `conversation-analyzer` (reads private transcripts).

Every adopted role declares why it exists (`rationale`) and a positive and a negative task-fit scenario; a test fails if a skill is used by no agent.

## D. Deviations from ECC, and why

1. **Authority is in code, not in prompts.** ECC's strongest controls are instructions plus hooks installed into the user's tool. Here a manifest cannot request a non-read tool, a skill cannot grant anything, and a model cannot sign.
2. **Hash chains are not authenticity.** ECC states this limit; we add signed receipts.
3. **Frequency does not promote.** ECC raises instinct confidence with observations; here only verified, independently reviewed outcomes count, and activation is a signed act.
4. **No installer, no global hooks.** Nothing writes `~/.claude`, `~/.codex` or machine-wide configuration.
5. **Smoke tests are deferred**, not claimed. See the findings register, item N-01.

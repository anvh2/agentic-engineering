# Engineering pack: skills, specialist agents, evidence and learning

**Status:** implemented in PR #53 (stacked on PR #51). Smoke tests against a live Mastra Studio, a real provider and the full scheduler path are **deferred** and not claimed (see `docs/audits/2026-10-pr53-ecc-integration/findings-register.md`, item N-01).

This document describes how the engineering pack fits the existing execution path
(`lead CLI -> scheduler -> executor -> Mastra workflow -> coding runner -> worker -> sandboxed verification -> review -> integration`).
It adds no second path and no second scheduler.

## Trust model

Authority is created in code by the runtime and its operator. Nothing a model can write, and nothing in a manifest, can grant it.

| Question | Answered by | Cannot be influenced by |
| --- | --- | --- |
| Which tools may a specialist call? | `TOOL_CLASSES` in `engineering-hooks.ts` and `SPECIALIST_TOOL_TABLE` in `specialist-agents.ts` (read class only; checked at import and at agent construction) | a manifest, a skill, an objective, model output |
| Which repository may a specialist read? | `checkRepository` against operator-configured roots (`AGENTIC_SPECIALIST_ROOTS`, default the project root), passed through `RequestContext` | the model; a symlink escaping the root is resolved and refused |
| Which files may a worker change, which commands verify? | the task contract and the language-adapter ceiling (unchanged from PR #51) | skills, rules, ADRs, specialist findings |
| Is a skill active? | a signed, single-use promotion by a `promoter` key, bound to the exact entry digest (`engineering-knowledge-store.ts`) | frequency of use, worker prose, a caller-set `approved` flag |
| Is a finding or verification authentic? | Ed25519 signature checked against the runtime keyring; principal ids come from the keyring (`trust.ts`) | any string in a statement |
| Is evidence authentic or only intact? | a signed receipt from an `evidence-signer` key (`engineering-capsule.ts`); a bare hash chain proves integrity only | anyone who can rewrite the journal |
| Did a trial succeed? | derived from a passing runtime verifier, an `accepted` verdict from a reviewer who is not the worker, and no security violation (`engineering-eval.ts`) | a boolean in a trial record |
| Is a design approved for execution? | the runtime's approval records (`design-approval.ts`) | an accepted ADR, which is a record of intent and never an approval |

Key roles: `reviewer` signs findings, `verifier` signs verifications, `promoter` signs promotions and decision changes, `evidence-signer`
signs receipts, trials and outcomes. A principal that authored a finding cannot verify it, even with a second key.
**Private keys are never generated, stored or read by this repository.** The runtime holds only public keys (a keyring). Signing is the
operator's act on a machine and account the agents cannot read.

## Components

| Layer | Module | Role |
| --- | --- | --- |
| Portable data | `engineering/skills/*.json`, `engineering/agents/*.json`, `engineering/NOTICE` | 37 skills and 20 specialist roles as harness-independent manifests with provenance |
| Schemas | `src/runtime/knowledge/packs/schema.ts` | strict zod schemas; there is no field for tools, files, verifier argv or approvals |
| Loading | `packs/loader.ts` | reads only `engineering/{skills,agents}`, refuses symlinks, oversize files and mismatched names; one bad file fails the whole load |
| Selection | `packs/skills.ts` | `selectSkills`: promoted and digest-current skills only, filtered by language and task type, ranked by keyword hits (stemmed whole-word matching), bounded by budget and count, dependencies taken together or not at all, omissions reported |
| Pinning | `packs/skills.ts` `pinSkillsForTask` | turns a selection into `CodingTask.knowledge = {ids, selectionDigest}` resolved in the runtime catalog |
| Agents | `packs/agents.ts` | validation (read-only tools, known skills), task fit, `negotiate` (explicit unsupported outcomes), instruction rendering, strict report parsing, Claude Code renderer |
| Review | `packs/review.ts` | repository check, prompt composition (objective and skills fenced as data), runtime-signed findings, role mapping |
| Mastra | `integrations/mastra/specialist-agents.ts`, `workflows/specialist-review-workflow.ts` | registers agents (no model call), runs one bounded read-only review with trace metadata |
| Evidence | `engineering-capsule.ts`, `engineering-eval.ts`, `engineering-review-consensus.ts` | signed receipts, derived acceptance, pass@k / pass^k, arm comparison gate, signed findings and verifications |
| Durable state | `engineering-knowledge-store.ts`, `engineering-decisions.ts`, `engineering-hooks-store.ts`, `engineering-learning.ts` | SQLite, immutable or append-only by trigger, `BEGIN IMMEDIATE` for check-then-act |
| Operations | `engineering-control.ts`, `engineering-cli.ts`, `scripts/engineering.ts`, `integrations/mastra/engineering-status-route.ts` | read-only report, CLI, `GET /engineering/v1/status` |

Dependency direction follows AGENTS.md: everything under `src/runtime/**` is harness-neutral; only `src/integrations/mastra/**` imports Mastra.

## Data flows

**Skill activation.** manifest -> `skillToCandidate` (inactive) -> operator signs a grant -> `engineering promote` -> store (`engineering_knowledge`, immutable) ->
`selectSkills` considers only skills whose current candidate digest equals an active entry -> `pinSkillsForTask` -> task contract -> routing gate
re-resolves the pin -> runner injects exactly the selected text and records the context fingerprint -> the lifecycle reviewer recomputes it.
A skill edited, superseded or revoked after pinning no longer resolves, so the task stays with Claude with a reason.

**Specialist review.** `specialist-review-workflow` input (specialist, repository, task, objective) ->
refusals before any model call (unknown role, wrong language or task type, unsupported model or context, repository outside the roots, unsafe focus paths) ->
prompt = fenced objective + promoted skills -> one agent run with `RequestContext{repository-root}`, a timeout and the run's abort signal ->
strict report parse (retry once only if the manifest says so) -> advisory result; if a runtime reviewer key is supplied, findings become signed statements ->
`consolidateReviewFindings` / `decideReview`, where HIGH and CRITICAL findings need an independent signed verification.
Any provider failure ends the run with an explicit status. There is no fallback model.

**Learning.** task outcome -> runtime verifies -> independent review -> runtime signs an outcome statement -> `ingestOutcomes` -> `DurableLearningLog` (append-only) ->
`proposeCandidates` (distinct verified tasks, Wilson lower-bound confidence, project scope) -> inactive candidate -> signed promotion -> per-version health from the same outcomes ->
`recommendActions` -> signed supersede or revoke. A global lesson additionally needs several independently qualifying projects and more than one independent reviewer.

**Sessions.** lifecycle events pass through `DurableHookLog.accept`, one write-locked transaction against a session rebuilt from stored events. A replay is flagged and must not repeat its side effect; a corrupted log stops the session.

## Decisions

1. **Manifests are data; authority is code.** Strict schemas, a runtime tool-class table and signed promotion mean a manifest edit can change guidance but never permission.
2. **Skills enter as inactive candidates.** Reusing the knowledge store's promotion path avoids a second authority.
3. **Selective, pinned, recomputable context.** Mandatory design, acceptance and verifier text is outside the optional budget and is never truncated; optional guidance is selected, budgeted and fingerprinted so worker and reviewer see the same bytes.
4. **Specialists are analysts.** Read-only tools, one report schema with no verdict field, advisory result literal. Merging reviewers into a verdict is `engineering-review-consensus.ts`'s job.
5. **Hash chains are not authenticity.** Receipts are signed. The limit of that (a compromised signing process) is stated, not hidden.
6. **One source of truth for state.** Decisions, hook events, outcomes and knowledge live in SQLite under `.workdir/engineering/`; summaries are projections.
7. **No installer, no global hooks.** The CLI is read-only except `promote` and `revoke`, which by default write only `.workdir/engineering/knowledge.db` (an operator can point `--db` elsewhere), and it has no signing command.
8. **Explicit unsupported outcomes.** Harness/provider combinations the repository has no wiring for are refused with a reason (`negotiate`), never silently routed elsewhere.
9. **Language policy unchanged.** Go and JavaScript delegation stay as in PR #51; TypeScript delegation stays disabled; Ruby and Rust skills and agents are review-only and are catalogued as `common` entries selected only for their own language, so no Go or JavaScript worker prompt can contain them.

## Extending

- **A skill:** add `engineering/skills/<id>.json` (filename equals id). It needs workflow, constraints, an example, verification, provenance, and at least one positive and one negative scenario. `engineering validate` and `packs.test.ts` run the scenarios through the real selector. It is inactive until promoted.
- **A specialist:** add `engineering/agents/<id>.json` with a rationale, read-only tools from the table, at least one existing skill, and positive and negative task-fit scenarios. Give it a finding role in `review.ts` if it should file under a specific consensus role. Every skill must be used by some agent (tested).
- **Another harness:** write a renderer from the manifest (see `renderClaudeCodeAgent`), add its provider mapping to `negotiate`, and return explicit unsupported outcomes for anything it cannot express. Do not import a harness into `src/runtime`.
- **A new tool for specialists:** add it to `TOOL_CLASSES` as `read` and to `SPECIALIST_TOOL_TABLE`. A write or execute tool is a permission change and is not available to specialists.

# PR #53 findings register

Independent adversarial review of the ECC integration. Baseline reviewed: PR #53 head `103aa914` (stacked on PR #51). Findings F-01 to
F-09 were reproduced as executable evidence against that head (`docs/audits/2026-10-pr53-ecc-integration/repro-pr53-original.test.ts`, which asserts
the *insecure* behaviour and is expected to fail on a fixed tree). F-10 onward were found while fixing and testing the later work.

Status values: **FIXED** (a named test fails without the fix), **MITIGATED** (risk reduced, residual stated), **OPEN**.
Severity is the severity the issue would have had in production use.

## Summary

| Severity | Total | Fixed | Mitigated | Open |
| --- | --- | --- | --- | --- |
| CRITICAL | 1 | 1 | 0 | 0 |
| HIGH | 11 | 11 | 0 | 0 |
| MEDIUM | 7 | 7 | 0 | 0 |
| LOW | 1 | 1 | 0 | 0 |

No CRITICAL or HIGH finding is open. The items in "Not complete" below are scope and verification gaps, not code defects, and are
listed so that no reader mistakes them for done.

## Findings

### F-01 HIGH: curated knowledge catalog had no production consumer
- **Files:** `src/runtime/knowledge/engineering-knowledge.ts`, `src/runtime/execution/coding-task-runner.ts`, `src/lead/lifecycle/verified-review.ts`.
- **Evidence / repro:** `grep` showed the catalog was constructed only in tests; no worker prompt or reviewer used it.
- **Risk:** the feature claimed to guide workers but changed nothing; reviewers could not recompute what workers saw.
- **Correction:** tasks pin `{ids, selectionDigest}`; the runner and the routing gate resolve it in a runtime-owned catalog; the reviewer recomputes it (commit `cb1cca7`). This PR adds the seam from promoted skills to a pin (`pinSkillsForTask`).
- **Verification:** `src/runtime/execution/coding-task-knowledge.test.ts`, `src/lead/lifecycle/verified-review-knowledge.test.ts`, `src/runtime/knowledge/packs/pin.test.ts` (real store, routing gate and runner).

### F-02 HIGH: revocation could be undone and audit rows rewritten
- **Files:** `src/runtime/knowledge/engineering-knowledge-store.ts`.
- **Repro:** `UPDATE engineering_knowledge SET revoked_at=NULL` and `UPDATE engineering_knowledge_events ...` both succeeded.
- **Risk:** a revoked (possibly harmful) skill could be silently re-enabled and history altered.
- **Correction:** database triggers make promoted rows immutable except a one-way revoke, and make every audit table append-only (`cb1cca7`). The decision log, hook log and learning log use the same pattern.
- **Verification:** `engineering-knowledge-store.test.ts`; `engineering-decisions.test.ts` ("the database itself forbids rewriting"); `engineering-hooks-store.test.ts`; `engineering-learning.test.ts`.

### F-03 HIGH: cross-project knowledge contamination
- **Files:** `engineering-knowledge.ts`, `engineering-knowledge-store.ts`.
- **Repro:** a lesson promoted for project A resolved for project B; the catalog had no project parameter.
- **Correction:** entries carry `projectId`; a catalog built for another project cannot contain them (`cb1cca7`). The learning module only reads one project's outcomes at a time and refuses global scope without independent cross-project evidence.
- **Verification:** `engineering-knowledge-store.test.ts`; `engineering-learning.test.ts` ("project isolation", "global scope needs several projects ... AND more than one independent reviewer").

### F-04 CRITICAL: caller-asserted verifier identity cleared CRITICAL findings
- **Files:** `src/runtime/knowledge/engineering-review-consensus.ts`.
- **Repro:** `decideReview(findings, [{verifierId:'codex', verdict:'refuted'}], ['codex'])` returned `canApprove: true`; the string `'codex'` was the only credential.
- **Risk:** any caller, including a model, could forge an independent approval.
- **Correction:** findings and verifications are Ed25519 statements checked against a runtime-owned keyring (`trust.ts`); principal ids come from the keyring; verifiers need the `verifier` role and cannot be an author of the finding (including through a second key of the same principal); statements are bound to one review id and one domain; unverifiable statements block approval (`a16bb45`).
- **Verification:** `engineering-review-consensus.test.ts`, `trust.test.ts`; end to end in `specialist-review-workflow.test.ts` ("signed findings feed review consensus").

### F-05 HIGH: capsule hash chain forgeable; hashes depended on key order
- **Files:** `src/runtime/knowledge/engineering-capsule.ts`.
- **Repro:** rebuilding a complete chain with a passing verifier verified as `ok`; `{a,b}` and `{b,a}` produced different roots.
- **Risk:** a hash proves integrity only. Anyone who can rewrite a journal recomputes every link, and a truncated prefix is a valid chain.
- **Correction:** canonical JSON hashing; receipts are Ed25519-signed by an `evidence-signer` key and bind run id, entry count, root and artifact digest; verification fails on truncation, tampering, extension (stale receipt), wrong run and wrong key; payloads containing credentials are refused.
- **Verification:** `engineering-capsule.test.ts` (7 tests). The `verifyCapsule` result is "integrity only" by construction; only `verifyCapsuleReceipt` yields authenticity.
- **Residual:** a compromised runtime process that holds the signing key can sign anything. That is the same trust boundary as the scheduler database.

### F-06 MEDIUM: promoting an unrelated lesson invalidated every pinned catalog digest
- **Correction:** tasks pin the digest of exactly the selected entries (`cb1cca7`). **Verification:** `coding-task-knowledge.test.ts` ("an unrelated catalog change does not disturb a pinned task").

### F-07 HIGH: a write-class tool with no path passed the path allowlist
- **Files:** `src/runtime/knowledge/engineering-hooks.ts`.
- **Repro:** `inspectHook({tool:'writeFile'}, {paths:['a.go']})` was accepted.
- **Correction:** a runtime-owned `TOOL_CLASSES` table; write tools require an allow-listed path; unknown tools are rejected even if "allowed"; strict event parsing never throws; canonical fingerprints; ordered, idempotent `HookSession`; durable `DurableHookLog` with verified resume.
- **Verification:** `engineering-hooks.test.ts`, `engineering-hooks-store.test.ts`.

### F-08 HIGH: a caller-set `approved` flag could activate knowledge
- **Correction:** candidates must start inactive; activation is a signed, single-use promotion bound to the entry digest and project (`cb1cca7`). Skills enter only as candidates (`skillToCandidate`). **Verification:** `engineering-knowledge-store.test.ts` ("promotion needs a promoter-signed grant"); `packs.test.ts` (end to end through the store).

### F-09 HIGH: evaluation trials were caller-asserted booleans
- **Files:** `src/runtime/knowledge/engineering-eval.ts`.
- **Repro:** `summarizeTrials([{accepted:true, ...}])` scored an accepted trial with no evidence.
- **Correction:** trials are `evidence-signer` statements; `accepted` is *derived* (runtime verifier passed, reviewer verdict `accepted`, reviewer principal different from the worker, no security violation); duplicates and replays are rejected; provider routing needs an explicit authorized-provider list, zero false passes and enough trials.
- **Verification:** `engineering-eval.test.ts` (11 tests).

### F-10 MEDIUM: TypeScript syntax Node strip-only mode cannot run passed `tsc`
- **Evidence:** a constructor parameter property in `engineering-hooks.ts` compiled but the file failed to load under `node --test`.
- **Correction:** `erasableSyntaxOnly: true` in `tsconfig.json`; verified with a probe file that `tsc` now rejects parameter properties.
- **Verification:** `npm run typecheck`.

### F-11 HIGH: registered Mastra specialists could not read anything in Studio and nothing invoked them
- **Files:** `src/integrations/mastra/specialist-agents.ts` (original), `src/workers/tools/repository-tools.ts`.
- **Evidence:** every repository tool requires `repository-root` in `RequestContext`; Mastra Studio never sets it, so tools threw "No repository is configured". No workflow called a specialist.
- **Risk:** agents appeared in Studio but could not execute or be monitored; the acceptance criterion was unmet.
- **Correction:** manifest-driven agents with a runtime-owned read-only tool table, plus `specialist-review-workflow`: it checks the repository against configured roots, passes the root through `RequestContext`, bounds the run by timeout and cancellation, validates the report, signs findings only with a runtime-held key, and attaches workflow-run metadata to traces.
- **Verification:** `specialist-agents.test.ts` (9), `specialist-review-workflow.test.ts` (15), driven through the real `Agent`, tools and workflow with a scripted offline model.

### F-12 MEDIUM: runner and reviewer could disagree about the implementation language
- **Correction:** one registry function (`knowledgeLanguageForFiles`) used by both (`cb1cca7`). **Verification:** `verified-review-knowledge.test.ts`.

### F-13 HIGH: agent read tools returned credential files
- **Files:** `src/workers/tools/repository-tools.ts` (`readFile`, `searchFiles`).
- **Repro:** `readFile('.env')`, a symlink to `.env`, and `searchFiles('API_KEY')` returned secret contents into model context.
- **Risk:** credentials in prompts, traces, reports and provider logs; applies to coding workers as well as specialists.
- **Correction:** `isSecretPath` denylist (`.env*` except templates, key and certificate extensions, `.ssh`/`.aws`/`.kube`, `.npmrc`, `credentials*` ...) checked against the literal and the symlink-resolved path; `searchFiles` neither scans nor echoes such files.
- **Verification:** `repository-tools-secret-files.test.ts`; the specialist workflow test asserts a secret never reaches model context.
- **Residual:** this is a denylist. Credentials in ordinary files (a token pasted into source) are not detected by the tools; `scanForSecrets` guards evidence, trials and reports only.

### F-14 HIGH: specialist output could be mistaken for a verdict
- **Risk:** free-text "LGTM, approved" or an `approved` field read as authority.
- **Correction:** one strict report schema with no verdict field (`strictObject`); prose, extra fields, approval fields, escaping paths and credentials are rejected; `advisory` is the literal `true`; findings enter consensus only as runtime-signed statements and need independent verification when HIGH/CRITICAL.
- **Verification:** `packs.test.ts` ("specialist output is accepted only if it matches the report contract exactly", "a report can carry no approval"); `specialist-review-workflow.test.ts` ("agent output cannot forge a verdict").

### F-15 MEDIUM: inference calls undercounted; aborted runs misclassified
- **Evidence:** found by tests during development. `generate()` counted once although each step is a model call, which would have understated cost in the benchmark; Mastra returns normally after an abort, so a timeout was reported as `INVALID_OUTPUT`.
- **Correction:** calls are counted per step; the abort state is checked after the call returns (`TIMEOUT`/`CANCELED`).
- **Verification:** `specialist-review-workflow.test.ts` ("runs end to end", "a hung model is cut off", "cancelling the workflow run").

### F-16 MEDIUM: evaluation fixtures could carry arbitrary verifier commands
- **Correction:** fixture `verificationCommands` are validated against the language-adapter ceiling (allow-listed binary; `npx --no-install jest` with allow-listed flags; `go test` with allow-listed self-contained flags and relative package paths; a Go package validator rejected `/abs` and `..`). **Verification:** `engineering-eval.test.ts` ("verifier argv validation mirrors the runtime ceiling").

### F-17 MEDIUM: provider selection was not restricted to authorized providers
- **Correction:** `chooseEvidenceBackedProvider` considers only `authorizedProviders`, returns `null` rather than falling back, and excludes providers with any false pass. **Verification:** `engineering-eval.test.ts` ("provider routing needs authorization ..."), `specialist-review-workflow.test.ts` ("provider failure ... no fallback").

### F-18 HIGH: the skill and specialist catalogs were one-line labels
- **Evidence:** 40 skill entries of a purpose and a trigger; 16 prompts that differed by a sentence; tests asserted array lengths and names.
- **Correction:** 37 manifests with workflow, constraints, examples, verification, provenance, compatibility and executable scenarios; 20 agents with responsibility, rationale, task fit, skill pool, read-only tools, provider compatibility, output contract, escalation and limits. Selective loading by language, task type, keywords, promotion state, budget and dependencies.
- **Verification:** `packs.test.ts` (19), `pin.test.ts` (5), `tests/bench/engineering-pack.test.ts` (6).

### F-19 MEDIUM: accepted ADR could be conflated with execution approval
- **Correction:** `DurableDecisionLog`: signed acceptance, atomic supersession, immutable revisions, task traceability; an accepted ADR does not satisfy `approvedDesign` verification. **Verification:** `engineering-decisions.test.ts` (13, including the routing-gate test).

### F-20 LOW: documentation overstated capability
- **Evidence:** `docs/engineering/mastra-specialist-catalog.md` described registration as sufficient; `docs/plans/ecc-selective-integration.md` was marked "not implemented".
- **Correction:** both rewritten against what exists; deferred and unmeasured items are labelled.

## Not complete (scope and verification gaps)

These are stated plainly so that nothing is read as done.

| ID | Item | State |
| --- | --- | --- |
| N-01 | Smoke tests: Mastra Studio, real agent registration in a live server, real-provider invocation, end-to-end scheduler to specialist to worker to verifier to reviewer | **SMOKE TEST DEFERRED**. Not run. Unit and deterministic integration tests drive the real `Agent`, tools and workflow with a scripted model, which is not a live Studio run. |
| N-02 | Task success, first-attempt acceptance, pass@k and pass^k, cost per accepted task, real tokens and wall clock | **NOT MEASURED**. The evaluation machinery is implemented and tested; no paid or local provider was invoked. |
| N-03 | Key provisioning | Operator responsibility. Nothing in the repository generates, stores or reads private keys. Until an operator provisions a keyring and signs grants, no skill is promoted and no finding is signed. |
| N-04 | Independent labelling of the selection corpus | The corpus is author-labelled; selection numbers are optimistic. |
| N-05 | TypeScript delegation | Remains disabled by design. Ruby and Rust are review-only. |

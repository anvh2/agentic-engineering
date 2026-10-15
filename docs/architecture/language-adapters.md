# ADR — Shared engineering design, pluggable language conventions

Status: Proposed (foundation only, language gates remain fail-closed). The "Current guarantees" section below is the authoritative statement of what the code enforces today; everything else in this document is the target design.
Scope: Engineering Lead, coding workers, verifier, reviewer, and acceptance.

## Current guarantees (what the code enforces today)

Verified by tests in `src/runtime/execution/` and `src/lead/lifecycle/`. This section, not the target design below it, is the statement of record.

**Enforced**

- **Permission ceilings.** The registry policy for the detected language is a ceiling. A caller-supplied `DelegationPolicy` is intersected with it (`effectivePolicy`): it can reduce files, attempts, extensions and verifier binaries but never widen them. The strict jest argv validator is selected by language, not by policy object identity, so a copied or hand-built policy cannot skip it. Exported policy objects are frozen. TypeScript stays non-delegatable.
- **Design approval is a runtime-owned record, not a caller assertion** (`design-approval.ts`). `approvedDesign.approvalRef` is only a lookup key. A design is used only if the scheduler database holds an approval record whose content-derived id matches, whose immutable fields still hash to that id, and which binds: the design fingerprint (HLD, LLD, ADR), the revision, the objective and task, the exact allowed files, the language and risk, the approver, the role and grant, and the authority scope held at approval time. The database refuses to update or delete approval rows or their audit trail.
- **Authority is delegated, scoped and re-checked on every use.** The role and permissions come from the authority's *grant*, never from the request. Issuing needs a credential the `ApprovalAuthority` authenticates over the exact request digest (design, task, objective, revision), so a credential cannot be replayed for another design, task or an older revision. The grant must permit the objective, the language, every allowed path (segment-aware prefixes), and the task risk, and must be inside its validity window. Objective, files, risk, task state and assigned worker are read from the task the scheduler persisted, not from the request. A grant withdrawn, narrowed or expired after approval stops the approval verifying immediately.
- **Separation of duties.** Only the `engineering-lead` role can approve or revoke. A worker cannot approve its own task (the approver may not be the task's assigned worker, at issue time or at verification time), and a design cannot be approved once a worker has EVER started the task. That is read from the append-only event log, not from the `claims` counter, because a lease expiry refunds the counter and returns a started task to READY with `claims = 0`. Reviewer principals can neither approve, supersede nor revoke; an approved design is immutable and a new revision supersedes the old one, which then stops verifying.
- **Fail closed.** The runtime default verifier (`denyAllApprovals`) rejects every attached design. Routing keeps such a task with Claude with the reason; the runner refuses to start; verified review escalates. Legacy tasks with no attached design are unaffected and are recorded as `approval: none`.
- **One pinned context per run.** The engineering context (shared rules, the selected language's conventions, and the verified design) is built once per run as an immutable, versioned snapshot (`schemaVersion`, `fingerprint` = SHA-256 of the prompt body, the verified approval, design digests). The runner refuses an attempt whose prompt does not contain the exact snapshot text and records the fingerprint on every attempt. `engineering-context.json` is persisted beside the other run artifacts, and `summary.json` / `result.json` carry the fingerprint and approval status.
- **Reviewer consistency.** Verified review re-verifies the approval itself against the store and authority (revoked, superseded, edited or unapproved designs escalate), recomputes the expected context fingerprint from the persisted task contract and the verified approval (not from the worker's artifacts), and escalates when the snapshot is missing, fails its own fingerprint, differs from the contract's, or was not what every attempt consumed. The review pack shows the same verified HLD/LLD/ADR and refuses to present an unverified design as the review standard.

- **Approval is atomic with worker claims.** `issueApproval` and `revokeApproval` run as one `BEGIN IMMEDIATE` transaction (the lock a claim needs): the started-check, revision allocation, authority check, supersession, insert and audit event commit together or roll back together. Contention or a lost revision race fails closed as `approval_conflict` with nothing written. Revoking an already-revoked approval is an idempotent no-op that writes nothing.

**Not provided (do not rely on these)**

- **There is no production `ApprovalAuthority`, so no design can currently be approved or verified in production.** The repository has no way to authenticate *which principal* acted (audit actors are free strings such as `--actor`) and no channel only a human can use to grant authority. Shipping an authority that trusts a role or actor field would simulate authentication. Tests use a test-only authority that verifies a real MAC over the request digest. See *Open decision: approval authority*.
- **The scheduler database is the storage trust boundary.** Records are protected from workers and callers because sandboxed code cannot read or write the database, and from silent edits by immutability triggers plus an integrity digest checked on every verification. A process that can write the database *and* drop its triggers can still delete or insert rows; it cannot make a forged row verify (the id and digest are content-derived and the grant is checked live), but it can destroy records.
- **No production path binds an approval to a persisted task yet.** The task spec is immutable after creation and an approval id is content-derived (it includes the revision, approver and time), so it cannot be written into a spec that already exists. `approvedDesign` is set nowhere in production code today. Decide before activation: a scheduler operation that attaches a verified approval to a not-yet-started task (which must then be treated as a spec mutation and re-verify risk and language), or resolution of the approval by (objective, task) at dispatch.
- **The write lock is held while the authority is consulted.** The `ApprovalAuthority` interface is synchronous and must stay cheap; a slow authority would stall worker claims for up to the busy timeout.
- **Credentials carry no freshness.** The signed digest binds objective, task, design and revision but not a time or nonce, so an authority that needs expiring credentials must put that inside its own credential.
- **Go verification commands are allow-listed by binary (`go`, `gofmt`) only.** There is no Go argv validation comparable to the jest validator; they rely on the OS sandbox.
- **Snapshot immutability is process-local plus content-addressed.** The object is frozen in memory and the stored fingerprint lets any reader detect modification; the artifact file is not write-protected.

### Open decision: approval authority (the minimum missing trust mechanism)

What the repository already gives us: a runtime-owned store that sandboxed workers cannot reach, deterministic validators, and an audit trail. That distinguishes runtime-issued records from worker or caller input. What it cannot do is distinguish the Engineering Lead from any other process running as the operator, or establish that a delegated scope was granted by a human rather than by the Lead itself. The smallest addition that closes this, using only `node:crypto` and the existing store:

1. **An operator root key**, held by the human and not by the Lead's process (passphrase-protected or offline), whose *public* key is pinned in runtime configuration. It signs *grants* (`DelegatedAuthority`: role, actions, scope, validity). Expanding scope, adding a language or raising `maxRisk` therefore requires a new human-signed grant; the Lead cannot widen its own authority.
2. **A Lead issuer key** held by the runtime process, authorizing `issueApproval` / `revokeApproval` credentials over the request digest. Its public key appears only inside a human-signed grant, so the runtime can verify that the signer holds delegated authority.
3. **Provisioning and revocation commands** for the human-only operations (sign grant, withdraw grant) and a `lead design approve|revoke|status` CLI that calls the existing functions.

Until that exists, attached designs fail closed.

## Decision

HLD and LLD are **language independent**. Language-specific coding instructions are a late-bound layer that never changes the approved architecture, risk envelope, task scope, or acceptance criteria.

```text
Objective / approved milestone
    |
    v
Shared engineering contract (HLD -> LLD -> task DAG -> risk & acceptance)
    |
    v
Language adapter registry (detect, convention, tool permissions, verifier policy)
    |
    v
Provider-independent task runner -> language-focused coding worker
    |
    v
Runtime-owned formatter / verifier -> independent review -> pinned Oracle
```

### Shared engineering contract (same for Go, TypeScript, Ruby, ...)

- **HLD:** problem boundaries, component responsibilities, interfaces, dataflow, failure modes, constraints, nonfunctional requirements, and ADR tradeoffs.
- **LLD:** API/schema contracts, data structures, invariants, algorithms, concurrency, idempotency, error handling, migrations, observable behavior, and tests.
- **Execution:** explicit task IDs, dependency DAG, maximum writable scope, source/context files, rollout/rollback, owner, model/cost limits, and review gates.
- **Verification:** runtime owns PASS/FAIL; test and oracle files are immutable to workers; integration and acceptance use independently pinned criteria. No worker can authorize its own change, expand allowed paths, run an arbitrary shell command, or auto-merge.

These contracts must be approved *before* the language worker receives an implementation task. A language adapter may **interpret** LLD into idiomatic code; it may not modify HLD, LLD invariants, or acceptance tests.

> **Enforcement status:** an attached HLD/LLD is used only if the runtime verifies a durable approval record for it. No production approval authority is provisioned yet, so attached designs currently fail closed. See *Current guarantees* and *Open decision: approval authority*.

### Language adapter contract

Each supported language registers:
1. A stable ID, matching file extensions and detection rules; unsupported or mixed languages fail closed.
2. Bounded mutation policy (permitted extensions, max files, protected test/config paths).
3. An **explicit verifier-command allow-list** with strict argv validation; never run user/model supplied commands just because they appear in package scripts.
4. Formatter/test runner integration and runtime sandbox toolchain read policy.
5. Coding conventions, style references and worker instructions specific to that language, but always subordinate to HLD/LLD.
6. Benchmark and regression evidence before promotion from *experimental* to *delegatable*.

A language adapter must not provide an alternative retry loop, status authority, security sandbox, approval path or Oracle implementation. Those remain in the shared runtime.

### Existing / planned adapters

| Language | Current status | Conventions / verifier |
| --- | --- | --- |
| Go | Implemented | gofmt; allow-listed go test; Go naming, packages, interfaces, errors and context cancellation |
| JavaScript | Limited delegation | local npx --no-install jest; existing JS style; single source file |
| TypeScript | **Not delegatable yet** | propose project tsconfig typecheck + scoped native node:test or tightly allow-listed test runner; strict types, ESM imports, async behavior |
| Ruby | **Not registered** | future rubocop (offline, pinned) + scoped RSpec/minitest, Rails conventions and migration safety |

For TS, a successful `tsc --noEmit` alone is not sufficient to show changed behavior. Require a targeted test and a typecheck where available. The validator must prevent test runner flags/configs that permit arbitrary code outside the approved sandbox; sandbox code is still treated as untrusted.

### Conventions separation

- `docs/engineering/languages/<language>.md`: coding style, package layout, formatter, test framework and version assumptions. (A `docs/engineering/shared/` directory for language-independent invariants is planned and does not exist yet; the shared rules today are the text in `engineering-context.ts`.)
- The selected adapter injects only its matching language convention into the worker prompt. The review pack shows the reviewer the same design text the worker received (see below).
- Changes to an approved architectural constraint are escalated to the Lead/operator, not silently accepted as "idiomatic style."

### Rollout gates

1. Land registry abstraction without changing Go/JS routes (golden backward-compatibility tests).
2. Add TypeScript adapter with deny-by-default verifier argv validation; Node/TypeScript sandbox parity and isolation tests.
3. Test TS L1–L3 coding ladder and concurrency/recovery. Enable TS delegation only on explicit benchmark PASS.
4. Later Ruby: register adapter and convention docs; no modifications to shared lifecycle, scheduler, acceptance or review logic.
5. First overnight run: approved task backlog and pinned acceptance, max one TS file/task, explicit quota, no auto-merge or deploy.

**Non-goal:** implementing or enabling TypeScript/Ruby merely by recognizing `.ts` or `.rb`. The adapter is incomplete until its sandbox, verifier, policy, and benchmark are proven.

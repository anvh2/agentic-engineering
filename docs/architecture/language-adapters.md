# ADR — Shared engineering design, pluggable language conventions

Status: Proposed (foundation only, language gates remain fail-closed)
Scope: Engineering Lead, coding workers, verifier, reviewer, and acceptance.

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

- `docs/engineering/shared/`: language-independent HLD, LLD, design-review and reliability invariants.
- `docs/engineering/languages/<language>/`: coding style, package layout, formatter, test framework and version assumptions.
- The selected adapter injects only its matching language convention into the worker prompt. The Lead and reviewer always receive the shared design contract and decision log.
- Changes to an approved architectural constraint are escalated to the Lead/operator, not silently accepted as "idiomatic style."

### Rollout gates

1. Land registry abstraction without changing Go/JS routes (golden backward-compatibility tests).
2. Add TypeScript adapter with deny-by-default verifier argv validation; Node/TypeScript sandbox parity and isolation tests.
3. Test TS L1–L3 coding ladder and concurrency/recovery. Enable TS delegation only on explicit benchmark PASS.
4. Later Ruby: register adapter and convention docs; no modifications to shared lifecycle, scheduler, acceptance or review logic.
5. First overnight run: approved task backlog and pinned acceptance, max one TS file/task, explicit quota, no auto-merge or deploy.

**Non-goal:** implementing or enabling TypeScript/Ruby merely by recognizing `.ts` or `.rb`. The adapter is incomplete until its sandbox, verifier, policy, and benchmark are proven.

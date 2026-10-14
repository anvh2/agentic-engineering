# TypeScript implementation conventions (not enabled yet)

Shared HLD/LLD and acceptance invariants take priority over style.

- Preserve project tsconfig, import conventions and type strictness.
- Prefer precise types and discriminated unions; avoid unsafe casts and `any`.
- Keep runtime validation for untrusted input; TypeScript types are not runtime guards.
- Respect cancellation, error handling, idempotency and observable behavior from the LLD.
- Proposed verifier: pinned offline typecheck **and** scoped tests with narrow argv validation inside the OS sandbox.
- Registration does not imply authorization: TS delegation remains disabled until verifier, sandbox integration and benchmark evidence pass.

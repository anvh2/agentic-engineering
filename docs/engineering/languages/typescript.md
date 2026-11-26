# TypeScript implementation conventions

Shared HLD/LLD and acceptance invariants take priority over style.

- Preserve project tsconfig, import conventions and type strictness.
- Prefer precise types and discriminated unions; avoid unsafe casts and `any`.
- Keep runtime validation for untrusted input; TypeScript types are not runtime guards.
- Respect cancellation, error handling, idempotency and observable behavior from the LLD.
- TypeScript has a dedicated Qwen worker and strict runtime verifier profile, but delegation is disabled by default. Only `.ts` implementation files are supported; `.tsx`, `.mts` and `.cts` remain unsupported.
- The fail-closed switch is `AGENTIC_TS_DELEGATION=true`. The scheduler, Lead ownership policy, route gate and execution entry point all require that exact value. Enable it only after TypeScript benchmark and security checks pass.
- `typescript-strict-v1` runs the local compiler as `node ./node_modules/typescript/bin/tsc --noEmit --strict --project <package>/tsconfig.json`, and requires the installed compiler version to match the committed npm lockfile.
- It then runs `node --experimental-strip-types --test <tracked, clean .test.ts file>` for immutable tests in the same package. Shells, `npm run`, package managers, network installs, hidden tests and alternate flags are refused.
- Package manifests, lockfiles, `tsconfig.json` and tests are read-only. A task may change at most four `.ts` implementation files in one package. In this runtime's own repository, the bootstrap exception is limited to `src/lead/objective/`; runtime, worker, verifier, sandbox and policy paths stay protected.

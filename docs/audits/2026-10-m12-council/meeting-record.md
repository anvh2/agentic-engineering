# Meeting record: Engineering council m12-ts-delegation-live-2

- Session `council-m12-ts-delegation-live-2` in thread `council-thread-m12-ts-delegation-live-2`
- Outcome: **decided** (decision m7 by council-architect: defer m3)
- Chair: council-architect; participants: council-architect (architect), council-security-reviewer (reviewer), council-reliability-reviewer (reviewer)
- Usage: 3/3 round(s), 7/9 invocation(s), tokens 23389/120000
- Provenance: through event 17 (`9b0319288b1126d3`), record `f164a573794ea34a`

## Agenda

1. Independent proposals
2. Critique and disagreement
3. Synthesis

## Alternatives

- [5/m1] **open** by council-architect: {"position":"Propose bounded TS delegation with tsc --noEmit precompilation, node --test verification, and safety-critical path lockdowns","rationale":"The delegation gate (src/runtime/execution/delegation.ts) currently blocks .ts files. By adding a TS adapter in language-adapters.ts, we can: (1) Allow .ts files with tsc --noEmit precompilation to JS, then verify with node --test on the output; (2) Lockdown safety-critical paths via file path whitelisting in the sandbox (src/runtime/sandbox). This extends existing execution paths rather than adding parallel ones. Acceptance requires passing all current tests and negative tests for gate/self-modification attempts.","risks":[{"risk":"TS compilation errors could cause sandbox crashes","mitigation":"Strict sandboxing and precompilation validation"},{"risk":"TypeScript's type system may not catch all runtime errors","mitigation":"Retain node --test verification for runtime safety"}],"evidence":["src/runtime/execution/delegation.ts","src/runtime/execution/language-adapters.ts","src/runtime/sandbox"],"unknowns":["How the verifier handles TS type annotations in test cases"]} — outstanding objections m5
- [7/m2] **open** by council-security-reviewer: {"position":"Implement a bounded TypeScript adapter with tsc --noEmit verification","rationale":"The delegation gate lacks TypeScript support, requiring a new adapter in language-adapters.ts. Verify .ts files with tsc --noEmit first, then node --test on compiled outputs. Safety-critical paths must use hardcoded whitelists to prevent self-modification. Acceptance criteria: pass existing JS tests, block non-.ts files, and isolate sandboxed processes.","risks":[{"risk":"Unverified TS code execution","mitigation":"Require tsc --noEmit before node --test"},{"risk":"Delegation gate bypass","mitigation":"Hardcode non-delegatable paths in sandbox/config.ts"},{"risk":"Credential exposure","mitigation":"Use ephemeral sandboxes with dropped privileges"}],"evidence":["src/runtime/execution/language-adapters.ts","src/runtime/sandbox"],"unknowns":["src/runtime/execution/delegation.ts implementation details"]} — outstanding objections m4, m6
- [9/m3] **deferred** by council-reliability-reviewer: {"position":"Implement bounded TypeScript delegation with tsc --noEmit pre-verification","rationale":"The delegation gate in delegation.ts currently blocks .ts files, but language-adapters.ts defines delegatableLanguage. Adding 'ts' to delegatableLanguage and requiring tsc --noEmit before node --test ensures type safety. Safety-critical paths (scheduler, sandbox) are protected by path whitelists in language-adapters.ts. Verification must explicitly run tsc --noEmit on .ts files before node --test, as the repo uses node --test for JS. Delegation gate must exclude core components via path filtering.","risks":[{"risk":"TypeScript compilation errors bypassing sandbox","mitigation":"Require tsc --noEmit in gate to catch syntax errors"},{"risk":"Worker modifying delegation gate","mitigation":"Lock gate updates to runtime verifier only"},{"risk":"Unbounded code execution","mitigation":"Sandbox with file path whitelisting"}],"evidence":["src/runtime/execution/delegation.ts","src/runtime/execution/language-adapters.ts"],"unknowns":["Sandbox isolation specifics","Test file selection criteria"]}

## Objections

- [11/m4] **outstanding** council-architect on m2: {"stance":"object","targetMember":"security-reviewer","critique":"The proposal assumes tsc --noEmit verification but lacks alignment with the repository's node --test testing infrastructure for JS. The security-reviewer's plan to run node --test on compiled outputs ignores the existing test framework's reliance on direct .js execution. The unknowns about delegation.ts implementation details (e.g., how paths are filtered) create gaps in ensuring safety-critical paths remain non-delegatable. The reliability-reviewer's proposal explicitly ties verification to the repo's node --test command, addressing this gap.","evidence":["src/runtime/execution/delegation.ts","src/runtime/execution/language-adapters.ts","src/runtime/sandbox"],"concessions":["Requires explicit tsc --noEmit verification before node --test","Hardcoded path whitelists in delegation gate","Ephemeral sandboxes for credential isolation"]}
- [13/m5] **outstanding** council-security-reviewer on m1: {"stance":"object","targetMember":"architect","critique":"The proposal lacks validation of precompiled TypeScript output. The architect's plan assumes tsc --noEmit converts .ts to JS but doesn't verify the compiled code's safety. This creates a gap where malicious TS code could bypass syntax checks via precompilation. The reliability-reviewer's proposal explicitly requires tsc --noEmit in the gate to catch syntax errors, which addresses this. Additionally, the architect's mention of 'file path whitelisting' in sandbox doesn't show how the sandbox enforces this compared to the reliability-reviewer's explicit sandbox isolation unknowns.","evidence":["src/runtime/execution/delegation.ts","src/runtime/execution/language-adapters.ts","src/runtime/sandbox"],"concessions":["Precompilation validation assumptions","File path whitelisting enforcement details"]}
- [15/m6] **outstanding** council-reliability-reviewer on m2: {"stance":"object","targetMember":"security-reviewer","critique":"The proposal assumes delegation.ts lacks TypeScript support without confirming its current implementation details. The security-reviewer’s unknowns include delegation.ts, but the architect’s proposal cites it as evidence, implying it was read. This creates a gap: the security-reviewer’s risk assessment for delegation gate bypass relies on assumptions about delegation.ts’s logic, which were not verified. For example, if delegation.ts already enforces file-type checks via regex or glob patterns, the proposed hardcoded whitelists in sandbox/config.ts might redundantly block valid paths. Without reading delegation.ts, the security-reviewer cannot ensure their mitigation aligns with existing gate logic.","evidence":["src/runtime/execution/delegation.ts"],"concessions":["Need to verify delegation.ts implementation for gate logic"]}

## Questions

(none)

## Agreements

(no explicit support was given)

## Decisions

- [17/m7] council-architect: **defer** m3 — The reliability-reviewer's proposal aligns with the repository's node --test testing infrastructure for JS, requiring tsc --noEmit precompilation to catch syntax errors before node --test verification. This addresses the architect's concern about test framework alignment and the security-reviewer's precompilation validation gap. However, the security-reviewer's objection about hardcoded whitelists in sandbox/config.ts relies on assumptions about delegation.ts's implementation details, which were not verified. The reliability-reviewer's plan requires explicit tsc --noEmit verification in the gate, but without confirming delegation.ts's current file-type filtering logic (e.g., regex/glob patterns), we cannot ensure hardcoded whitelists won't redundantly block valid paths. The architect and reliability-reviewer cited delegation.ts as evidence, but the security-reviewer's unknowns about its implementation details remain unresolved. (grants no authority)

## Action items

- [ ] council-operator: Verify delegation.ts's implementation details to confirm gate logic (from m7 [17/m7])
- [ ] council-operator: Validate sandbox/config.ts whitelists against existing non-delegatable paths (from m7 [17/m7])

## Unresolved

- [5/m1] proposal m1: council-architect's proposal was not decided
- [7/m2] proposal m2: council-security-reviewer's proposal was not decided
- [9/m3] proposal m3: council-reliability-reviewer's proposal was deferred
- [11/m4] objection m4: council-architect objects to m2
- [13/m5] objection m5: council-security-reviewer objects to m1
- [15/m6] objection m6: council-reliability-reviewer objects to m2

## Corrections

(none)

## Turns

- r1.t0 a1 council-architect: message proposal m1 (event 5)
- r1.t1 a1 council-security-reviewer: message proposal m2 (event 7)
- r1.t2 a1 council-reliability-reviewer: message proposal m3 (event 9)
- r2.t0 a1 council-architect: message objection m4 (event 11)
- r2.t1 a1 council-security-reviewer: message objection m5 (event 13)
- r2.t2 a1 council-reliability-reviewer: message objection m6 (event 15)
- r3.t0 a1 council-architect: message decision m7 (event 17)

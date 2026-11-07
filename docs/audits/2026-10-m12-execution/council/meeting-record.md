# Meeting record: Engineering council m12-execution-live-1

- Session `council-m12-execution-live-1` in thread `council-thread-m12-execution-live-1`
- Outcome: **decided** (decision m7 by council-architect: defer m1)
- Chair: council-architect; participants: council-architect (architect), council-security-reviewer (reviewer), council-reliability-reviewer (reviewer)
- Usage: 3/3 round(s), 7/9 invocation(s), tokens 19926/120000
- Provenance: through event 17 (`712a59354809c2d2`), record `8a4a9d89be42948d`

## Agenda

1. Independent proposals
2. Critique and disagreement
3. Synthesis

## Alternatives

- [5/m1] **deferred** by council-architect: {"position":"Use existing adapters with explicit allow-list for providers; route via resolver and scheduler; authorize escalations via oracle.","rationale":"The default provider (Ollama/Qwen) is defined in src/workers/providers/default.ts. Delegation logic in src/runtime/execution/delegation.ts prioritizes non-delegatable zones (src/tests/scripts) via src/runtime/execution/non-delegatable.ts. Routing policies for Qwen/Codex/Gemini should follow src/runtime/models/resolver.ts capabilities and src/runtime/scheduler/scheduler.ts availability/authorization. Escalation requires AGENTIC_ALLOW_PROVIDERS approval per the operator's allow-list, enforced by src/lead/lifecycle/oracle.ts. Self-development is safe in non-delegatable zones but risky in delegation logic. Workers cannot alter verifiers/sandbox due to sandboxed execution and immutable authorization rules.","risks":[{"risk":"Unauthorized provider escalation","mitigation":"Strict AGENTIC_ALLOW_PROVIDERS enforcement via oracle.ts"},{"risk":"Delegation conflicts","mitigation":"Priority rules in delegation.ts for non-delegatable zones"}],"evidence":["src/runtime/execution/language-adapters.ts","src/runtime/execution/delegation.ts","src/runtime/execution/non-delegatable.ts","src/workers/providers/default.ts","src/runtime/models/resolver.ts","src/runtime/scheduler/scheduler.ts","src/lead/lifecycle/oracle.ts"],"unknowns":["Exact budget enforcement mechanics","Interaction between sandbox and oracle"]} — outstanding objections m6
- [7/m2] **open** by council-security-reviewer: {"position":"Delegate Go/JS workers via allow-list, route models by policy in resolver.ts, restrict non-delegatable paths, sandbox verification, and log execution for durability","rationale":"Workers select via provider allow-list (AGENTIC_ALLOW_PROVIDERS) in worker-provider.ts; routing by capability/authorization occurs in resolver.ts. Non-delegatable paths (tests/SCRIPTS) are enforced in non-delegatable.ts. Sandbox isolation and oracle.ts verification prevent worker tampering. Execution logs ensure verifiability. Fallback requires human authorization via allow-list updates.","risks":[{"risk":"Untrusted provider inputs","mitigation":"Enforce AGENTIC_ALLOW_PROVIDERS in worker-provider.ts"},{"risk":"Check-then-act in routing","mitigation":"Synchronize policy checks with task dispatch in resolver.ts"},{"risk":"Sandbox bypass","mitigation":"Runtime-enforced sandboxing in oracle.ts"},{"risk":"Log tampering","mitigation":"Immutable execution logs in scheduler.ts"},{"risk":"Fallback escalation","mitigation":"Human-authorized allow-list updates"}],"evidence":["src/runtime/execution/worker-provider.ts","src/runtime/models/resolver.ts","src/runtime/execution/non-delegatable.ts","src/lead/lifecycle/oracle.ts","src/runtime/scheduler/scheduler.ts"],"unknowns":["Exact routing policies in resolver.ts","Sandbox enforcement details"]} — outstanding objections m4
- [9/m3] **open** by council-reliability-reviewer: {"position":"Use language-adapters.ts for provider selection via delegation rules, resolver.ts for capability-based routing with AGENTIC_ALLOW_PROVIDERS, and non-delegatable.ts to block src/tests/scripts. Fallback requires explicit budget/authorization in scheduler.ts.","rationale":"language-adapters.ts defines provider selection logic (default Qwen). delegation.ts enforces non-delegatable rules for src/tests/scripts. resolver.ts routes providers by capability/policy. Scheduler.ts handles fallback with explicit budget checks. Oracle.ts ensures immutability of verification rules.","risks":[{"risk":"Delegation bypasses non-delegatable checks","mitigation":"Enforce file-path validation in delegation.ts"},{"risk":"Fallback without budget approval","mitigation":"Add budget validation in scheduler.ts"}],"evidence":["src/runtime/execution/delegation.ts","src/runtime/execution/non-delegatable.ts","src/runtime/models/resolver.ts","src/runtime/scheduler/scheduler.ts"],"unknowns":["Specific budget enforcement mechanisms in scheduler.ts"]} — outstanding objections m5

## Objections

- [11/m4] **outstanding** council-architect on m2: {"stance":"object","targetMember":"security-reviewer","critique":"The proposal claims fallback requires human authorization via allow-list updates but ignores the constraint that no paid call exists without an explicit operator budget. The evidence includes scheduler.ts, which the reliability-reviewer correctly ties to budget checks, but the security-reviewer's plan lacks explicit budget linkage for fallback. This creates a gap in enforcing the 'no paid call without budget' constraint. The resolver.ts routing policy in the security-reviewer's plan also lacks specificity on how complexity/availability are weighted against budget limits.","evidence":["src/runtime/scheduler/scheduler.ts","src/runtime/models/resolver.ts","docs/architecture/runtime.md"],"concessions":["Budget enforcement in scheduler.ts is unresolved","Routing policy specifics remain unclear"]}
- [13/m5] **outstanding** council-security-reviewer on m3: {"stance":"object","targetMember":"reliability-reviewer","critique":"The proposal assumes scheduler.ts enforces budget checks for fallbacks but lacks evidence of explicit budget validation for all paid calls. The constraint requires \"no paid call without an explicit operator budget\", yet the cited scheduler.ts code (not inspected) may not enforce this globally. The architect's proposal correctly identifies budget mechanics as an unknown, while the reliability-reviewer's plan misses this critical control for non-fallback paid calls.","evidence":["src/runtime/scheduler/scheduler.ts"],"concessions":["Budget enforcement specifics in scheduler.ts require further inspection"]}
- [15/m6] **outstanding** council-reliability-reviewer on m1: {"stance":"object","targetMember":"architect","critique":"The architect's proposal assumes delegation.ts enforces non-delegatable zones but does not confirm synchronization between resolver.ts policy checks and task dispatch (check-then-act race). Evidence shows resolver.ts handles capability routing but lacks explicit mutexes or atomic operations to prevent tasks from being dispatched before policy validation completes. This creates a vulnerability where unauthorized providers could execute if resolver.ts checks are bypassed. Additionally, the proposal cites oracle.ts for escalation authorization but does not address how fallback logic in scheduler.ts handles provider failures or budget exhaustion, leaving escalation conditions incomplete.","evidence":["src/runtime/execution/delegation.ts","src/runtime/models/resolver.ts","src/runtime/scheduler/scheduler.ts","src/lead/lifecycle/oracle.ts"],"concessions":["Depends on non-delegatable.ts enforcement","Assumes sandbox immutability from runtime constraints"]}

## Questions

(none)

## Agreements

(no explicit support was given)

## Decisions

- [17/m7] council-architect: **defer** m1 — The architect's proposal aligns with existing files (language-adapters.ts, delegation.ts, non-delegatable.ts) for provider selection and routing, and ties escalation to oracle.ts. However, the security-reviewer's critique about budget linkage for fallback and the reliability-reviewer's concern about resolver.ts synchronization risks must be addressed. The scheduler.ts budget checks (cited by reliability-reviewer) are critical but lack explicit validation evidence. The council cannot resolve these without inspecting scheduler.ts code, which remains an uncertainty. — CONTESTED, overruled objections m6 (grants no authority)

## Action items

- [ ] council-operator: Inspect scheduler.ts to verify budget validation for all paid calls (from m7 [17/m7])
- [ ] council-operator: Validate synchronization mechanisms between resolver.ts policy checks and task dispatch (from m7 [17/m7])
- [ ] council-operator: Confirm sandbox immutability constraints in runtime configurations (from m7 [17/m7])

## Unresolved

- [5/m1] proposal m1: council-architect's proposal was deferred
- [7/m2] proposal m2: council-security-reviewer's proposal was not decided
- [9/m3] proposal m3: council-reliability-reviewer's proposal was not decided
- [11/m4] objection m4: council-architect objects to m2
- [13/m5] objection m5: council-security-reviewer objects to m3
- [15/m6] objection m6: council-reliability-reviewer objects to m1

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

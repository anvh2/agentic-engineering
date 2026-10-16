/**
 * Minimal curated engineering guidance derived from ECC concepts.
 * Original summaries authored for agentic-engineering; no ECC executable scripts copied.
 * Upstream: affaan-m/ECC at b92f181b3b748d1abbc2afd94af6aa7d8c8fca29 (MIT).
 *
 * IMPORTANT: these are *candidate* entries, not active instructions.
 * Promotion requires an explicit versioned catalog decision and benchmark evidence.
 */
import type { KnowledgeEntry } from './engineering-knowledge.ts';

export const ECC_CANDIDATES: readonly KnowledgeEntry[] = Object.freeze([
  { id:'ecc-common-standards', revision:'v1', kind:'rule', language:'common', source:'ECC rules/common',
    body:'Treat execution scope, independent tests and repository conventions as requirements. Explain uncertainties explicitly.', approved:false },
  { id:'ecc-go-conventions', revision:'v1', kind:'rule', language:'go', source:'ECC rules/golang',
    body:'Keep package boundaries explicit; handle errors and context cancellation; use gofmt and approved focused tests.', approved:false },
  { id:'ecc-js-conventions', revision:'v1', kind:'rule', language:'js', source:'ECC rules/typescript',
    body:'Respect ESM/CommonJS module boundaries, promise error handling, and dependency controls. Run only approved offline verification.', approved:false },
  { id:'ecc-security-review', revision:'v1', kind:'skill', language:'common', source:'ECC skills/agent-security-hardening',
    body:'Map untrusted data to side effects and identify the authenticating principal, deterministic boundary validator, audit evidence and fail-closed behavior for every mutation.', approved:false },
  { id:'ecc-adr-decisions', revision:'v1', kind:'skill', language:'common', source:'ECC skills/architecture-decision-records',
    body:'For consequential architecture decisions record context, alternatives, chosen solution, tradeoffs, consequences and revision; distinguish proposed from accepted.', approved:false },
  { id:'ecc-continuous-learning', revision:'v1', kind:'skill', language:'common', source:'ECC skills/continuous-learning-v2',
    body:'Extract narrowly scoped candidate engineering lessons from independently accepted outcomes. Never treat observation frequency or model prose as approval.', approved:false },
  { id:'ecc-session-continuity', revision:'v1', kind:'skill', language:'common', source:'ECC hooks/memory-persistence',
    body:'On context restart, reconstruct the last task state from durable checkpoint and source evidence; never restart a verified side effect from an ambiguous in-flight state.', approved:false },
  { id:'ecc-context-budget', revision:'v1', kind:'skill', language:'common', source:'ECC skills/context-budget',
    body:'Select only relevant version-pinned guidance. Report omitted optional content and never remove approved design, acceptance criteria or verifier controls to fit a budget.', approved:false },
  { id:'ecc-specialist-review', revision:'v1', kind:'role', language:'common', source:'ECC agents/code-reviewer and agents/security-reviewer',
    body:'Review code against pinned requirements and reproducible tests. Reviewer recommendations are not runtime PASS and do not authorize new tool capabilities.', approved:false },
]);

/**
 * Portable skill summaries inspired by ECC's skill catalog.
 * Skills are data and never carry tool permissions. Source reference is attribution,
 * not proof that a behavior has been independently evaluated.
 */
export interface SkillDefinition {id:string;category:string;purpose:string;source:string;trigger:string}
const skill=(id:string,category:string,purpose:string,source:string,trigger:string):SkillDefinition=>Object.freeze({id,category,purpose,source,trigger});
export const ENGINEERING_SKILLS:readonly SkillDefinition[]=Object.freeze([
 skill('codebase-exploration','research','Trace entry points and call chains','skills/codebase-onboarding','New codebase feature'),
 skill('dependency-tracing','research','Map dependencies and interfaces','skills/change-impact','Cross-module change'),
 skill('brownfield-spec-mining','research','Extract observable requirements','agents/spec-miner.md','Legacy system change'),
 skill('change-impact','architecture','Analyze change surface and rollback','skills/change-impact','Cross-boundary mutation'),
 skill('system-design','architecture','Compare architectural alternatives','skills/agent-architecture-audit','Architecture decision'),
 skill('architecture-decisions','architecture','Record ADR context and consequences','skills/architecture-decision-records','Design decisions'),
 skill('contract-first','architecture','Pin machine-checkable API contracts','skills/contract-first','Cross-service integration'),
 skill('api-design','architecture','Design stable API contracts','skills/api-design','API change'),
 skill('go-patterns','implementation','Review idiomatic Go boundaries','skills/golang-patterns','Go implementation'),
 skill('go-testing','quality','Create targeted Go tests','skills/golang-testing','Go regression'),
 skill('typescript-patterns','implementation','Preserve strict TypeScript types','rules/typescript','TS code review'),
 skill('javascript-patterns','implementation','Handle JS module and async boundaries','rules/typescript','JS code review'),
 skill('refactoring','implementation','Refactor without behavior changes','agents/refactor-cleaner.md','Refactor task'),
 skill('error-handling','implementation','Prevent swallowed and misleading errors','skills/error-handling','Error path'),
 skill('build-diagnostics','quality','Diagnose failing build and tests','agents/build-error-resolver.md','Compiler failure'),
 skill('test-analysis','quality','Evaluate behavior test completeness','agents/pr-test-analyzer.md','PR review'),
 skill('ai-regression-testing','quality','Guard against shared AI blind spots','skills/ai-regression-testing','Agent-authored changes'),
 skill('test-driven-development','quality','Specify tests before implementation','agents/tdd-guide.md','New behavior'),
 skill('threat-modeling','security','Review attacker capabilities and boundaries','skills/agent-security-hardening','Sensitive change'),
 skill('authorization-audit','security','Verify permission source and scope','skills/agent-security-hardening','Authorization flow'),
 skill('security-regression','security','Build negative security assertions','skills/agent-security-hardening','Security bug'),
 skill('reliability-review','reliability','Analyze retries, fallback and errors','agents/silent-failure-hunter.md','Resilience change'),
 skill('distributed-systems','reliability','Check distributed state invariants','skills/backend-patterns','Async service'),
 skill('transaction-safety','reliability','Verify atomicity and idempotency','skills/database-migrations','Transactional flow'),
 skill('database-migrations','reliability','Review data migration and rollback','skills/database-migrations','Schema change'),
 skill('observability-review','operations','Verify evidence, logs and metrics','skills/enterprise-agent-ops','Production support'),
 skill('agent-evaluation','agent-engineering','Compare verified agent outcomes','skills/agent-eval','Provider selection'),
 skill('agent-introspection','agent-engineering','Diagnose looping tool behavior','skills/agent-introspection-debugging','Agent stalled'),
 skill('harness-construction','agent-engineering','Optimize agent tool schemas','skills/agent-harness-construction','Tool changes'),
 skill('benchmark-optimization','optimization','Compare reproducible variants','skills/benchmark-optimization-loop','Performance task'),
 skill('cost-aware-routing','optimization','Select provider with outcome/cost evidence','skills/cost-aware-llm-pipeline','Cost optimization'),
 skill('context-budget','optimization','Limit optional context safely','skills/context-budget','Prompt growth'),
 skill('skill-health','optimization','Track independent skill efficacy','scripts/lib/skill-evolution/health.js','Skill decline'),
 skill('docs-governance','operations','Identify stale docs and decisions','skills/docs-governance','Post-implementation'),
 skill('session-recovery','operations','Restore verified checkpoint state','hooks/memory-persistence','Session resumption'),
 skill('worktree-management','operations','Keep isolated change ownership','scripts/orchestrate-worktrees.js','Concurrent tasks'),
 skill('release-readiness','operations','Evaluate release verification gates','skills/delivery-gate','Deployment approval'),
 skill('incident-analysis','operations','Extract incident root cause','skills/automation-audit-ops','Incident review'),
 skill('hook-security','operations','Validate lifecycle hook constraints','hooks/README.md','Hook installation'),
 skill('multi-harness-adaptation','agent-engineering','Negotiate native tool compatibility','scripts/qwen-adapt-agents.js','Provider migration'),
]);
export function validateSkillDefinitions(skills:readonly SkillDefinition[]):void{
 const ids=new Set<string>();
 for(const s of skills){
  if(!/^[a-z][a-z0-9-]{2,63}$/.test(s.id)||ids.has(s.id)||!s.category.trim()||!s.purpose.trim()||!s.source.trim()||!s.trigger.trim())
   throw new Error('skills: invalid definition');
  ids.add(s.id);
 }
}
validateSkillDefinitions(ENGINEERING_SKILLS);
export const skillById=(id:string):SkillDefinition|undefined=>ENGINEERING_SKILLS.find(s=>s.id===id);

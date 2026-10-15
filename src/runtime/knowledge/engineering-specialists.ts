/**
 * Portable engineering specialist definitions, adapted from ECC's role taxonomy.
 * No Mastra imports here: other harnesses can render these definitions.
 * Profiles describe intent, NEVER grant authorization or execution rights.
 */
export interface SpecialistDefinition {
 id:string;name:string;purpose:string;reviewDimension:string;
 skills:readonly string[];mode:'read-only';source:string;
}
const mk=(id:string,name:string,purpose:string,skills:string[],source:string):SpecialistDefinition=>Object.freeze({
 id,name,purpose,reviewDimension:purpose,skills:Object.freeze(skills),mode:'read-only' as const,source
});
export const ENGINEERING_SPECIALISTS:readonly SpecialistDefinition[]=Object.freeze([
 mk('code-explorer','Code Explorer','Map actual entry points, call paths and contracts before planning.',['codebase-exploration','dependency-tracing'],'agents/code-explorer.md'),
 mk('spec-miner','Specification Miner','Extract behavior, invariants and existing test anchors from legacy code.',['brownfield-spec-mining','change-impact'],'agents/spec-miner.md'),
 mk('architecture-reviewer','Architecture Reviewer','Assess system boundaries, tradeoffs and design compatibility.',['system-design','architecture-decisions'],'agents/architect.md'),
 mk('security-reviewer','Security Reviewer','Identify threat boundaries, authorization gaps and injection paths.',['threat-modeling','authorization-audit'],'agents/security-reviewer.md'),
 mk('pr-test-analyzer','PR Test Analyzer','Review behavioral coverage and negative test quality against changes.',['ai-regression-testing','test-analysis'],'agents/pr-test-analyzer.md'),
 mk('silent-failure-hunter','Silent Failure Hunter','Find swallowed failures, misleading fallbacks and missing propagation.',['error-handling','reliability-review'],'agents/silent-failure-hunter.md'),
 mk('go-reviewer','Go Reviewer','Check Go correctness, package boundaries and cancellation behavior.',['go-patterns','go-testing'],'agents/go-reviewer.md'),
 mk('typescript-reviewer','TypeScript Reviewer','Check strict typing, runtime validation and module boundaries.',['typescript-patterns','contract-first'],'agents/typescript-reviewer.md'),
 mk('build-error-resolver','Build Error Resolver','Diagnose compiler or test failures from reproduced evidence.',['build-diagnostics','agent-introspection'],'agents/build-error-resolver.md'),
 mk('performance-reviewer','Performance Reviewer','Identify measurable hot paths and benchmark opportunities.',['benchmark-optimization','cost-aware-routing'],'agents/performance-optimizer.md'),
 mk('harness-optimizer','Harness Optimizer','Suggest eval-backed routing and harness configuration changes.',['agent-evaluation','harness-construction'],'agents/harness-optimizer.md'),
 mk('agent-evaluator','Agent Evaluator','Evaluate task outcomes, quality and consistency from verified evidence.',['agent-evaluation','skill-health'],'agents/agent-evaluator.md'),
 mk('docs-reviewer','Documentation Reviewer','Check architecture and documentation drift against actual code.',['docs-governance','architecture-decisions'],'agents/doc-updater.md'),
 mk('refactor-reviewer','Refactor Reviewer','Flag unsafe refactors, coupling and behavior regression risks.',['refactoring','change-impact'],'agents/refactor-cleaner.md'),
 mk('database-reviewer','Database Reviewer','Review migrations, transactions, indexes and concurrency.',['database-migrations','transaction-safety'],'agents/database-reviewer.md'),
 mk('reliability-reviewer','Reliability Reviewer','Review idempotency, retries, failure recovery and telemetry.',['distributed-systems','reliability-review'],'agents/silent-failure-hunter.md'),
]);
export function validateSpecialists(profiles:readonly SpecialistDefinition[]):void{
 const ids=new Set<string>();
 for(const p of profiles){
  if(!/^[a-z][a-z0-9-]{2,63}$/.test(p.id)||ids.has(p.id)||!p.name.trim()||!p.purpose.trim()
    ||p.mode!=='read-only'||!p.source.startsWith('agents/')||p.skills.length===0
    ||p.skills.some(s=>!/^[a-z][a-z0-9-]{2,63}$/.test(s)))throw new Error('specialists: invalid profile');
  ids.add(p.id);
 }
}
validateSpecialists(ENGINEERING_SPECIALISTS);

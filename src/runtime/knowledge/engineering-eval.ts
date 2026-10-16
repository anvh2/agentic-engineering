/**
 * Deterministic evaluation of bounded engineering providers.
 * Evaluators ingest runtime-owned evidence, never model-reported success.
 * Inspired by ECC's agent-eval workflow, implemented without launching providers.
 */
export interface Trial {
  fixtureId: string;
  fixtureCommit: string;
  providerId: string;
  repetition: number;
  accepted: boolean;
  independentReview: boolean;
  verifierPassed: boolean;
  securityViolation: boolean;
  elapsedMs: number;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}
export interface ProviderScore {
  providerId: string;
  trials: number;
  accepted: number;
  firstAttemptAccepted: number;
  securityViolations: number;
  acceptedRate: number;
  firstAttemptRate: number;
  averageElapsedMs: number;
  totalCostUsd: number | null;
  costPerAcceptedUsd: number | null;
  fixtures: readonly string[];
}
const positive = (v: number) => Number.isFinite(v) && v >= 0;
export function summarizeTrials(trials: readonly Trial[]): readonly ProviderScore[] {
  const unique = new Set<string>();
  for (const t of trials) {
    if (!t.fixtureId.trim() || !/^[a-f0-9]{40}$/.test(t.fixtureCommit) || !t.providerId.trim()
      || !Number.isSafeInteger(t.repetition) || t.repetition < 0
      || !Number.isSafeInteger(t.attempts) || t.attempts < 1
      || !positive(t.elapsedMs)
      || (t.inputTokens !== null && !positive(t.inputTokens))
      || (t.outputTokens !== null && !positive(t.outputTokens))
      || (t.costUsd !== null && !positive(t.costUsd))) throw new Error('eval: invalid trial');
    if (t.accepted && (!t.verifierPassed || !t.independentReview || t.securityViolation)) throw new Error('eval: accepted outcome lacks independent evidence');
    const key = JSON.stringify([t.fixtureId,t.fixtureCommit,t.providerId,t.repetition]);
    if (unique.has(key)) throw new Error('eval: duplicate fixture/provider repetition');
    unique.add(key);
  }
  const providers = [...new Set(trials.map(t=>t.providerId))].sort();
  return Object.freeze(providers.map(providerId=>{
    const rows=trials.filter(t=>t.providerId===providerId);
    const accepted=rows.filter(t=>t.accepted).length;
    const costKnown=rows.every(t=>t.costUsd!==null);
    const cost=costKnown?rows.reduce((n,t)=>n+t.costUsd!,0):null;
    return Object.freeze({
      providerId,trials:rows.length,accepted,
      firstAttemptAccepted:rows.filter(t=>t.accepted&&t.attempts===1).length,
      securityViolations:rows.filter(t=>t.securityViolation).length,
      acceptedRate:accepted/rows.length,
      firstAttemptRate:rows.filter(t=>t.accepted&&t.attempts===1).length/rows.length,
      averageElapsedMs:rows.reduce((n,t)=>n+t.elapsedMs,0)/rows.length,
      totalCostUsd:cost,
      costPerAcceptedUsd:cost!==null&&accepted>0?cost/accepted:null,
      fixtures:Object.freeze([...new Set(rows.map(t=>t.fixtureId))].sort()),
    });
  }));
}
export interface RoutingPolicy { minimumTrials: number; requireZeroSecurityViolations: boolean; maxCostPerAcceptedUsd?: number; }
export function chooseEvidenceBackedProvider(scores:readonly ProviderScore[], policy:RoutingPolicy):string|null {
  if (!Number.isSafeInteger(policy.minimumTrials)||policy.minimumTrials<1
    || (policy.maxCostPerAcceptedUsd!==undefined && !positive(policy.maxCostPerAcceptedUsd))) throw new Error('eval: invalid routing policy');
  const eligible=scores.filter(s=>s.trials>=policy.minimumTrials&&s.accepted>0
    && (!policy.requireZeroSecurityViolations||s.securityViolations===0)
    && (policy.maxCostPerAcceptedUsd===undefined||(s.costPerAcceptedUsd!==null&&s.costPerAcceptedUsd<=policy.maxCostPerAcceptedUsd)));
  eligible.sort((a,b)=> b.acceptedRate-a.acceptedRate || b.firstAttemptRate-a.firstAttemptRate
    || (a.costPerAcceptedUsd??Infinity)-(b.costPerAcceptedUsd??Infinity)
    || a.averageElapsedMs-b.averageElapsedMs || a.providerId.localeCompare(b.providerId));
  return eligible[0]?.providerId??null;
}
/** A fixture manifest does not authorize a command: runtime verifier still validates argv. */
export interface EvalFixture { id:string; commit:string; language:'go'|'js'; allowedFiles:readonly string[]; expectedCriteria:readonly string[]; }
export function validateFixtures(fixtures:readonly EvalFixture[]): void {
  const ids=new Set<string>();
  for(const f of fixtures){
    if(!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(f.id)||ids.has(f.id)||!/^[a-f0-9]{40}$/.test(f.commit)
      ||!['go','js'].includes(f.language)||!f.allowedFiles.length||!f.expectedCriteria.length
      ||f.allowedFiles.some(p=>!p||p.startsWith('/')||p.split('/').includes('..')||p.includes('\\')))throw new Error('eval: invalid fixture');
    ids.add(f.id);
  }
}

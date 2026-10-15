/** Deterministic aggregation of independent specialist findings.
 * Reviewer prose is advisory; HIGH/CRITICAL require independent confirmation.
 */
export type Severity='LOW'|'MEDIUM'|'HIGH'|'CRITICAL';
export interface ReviewFinding {
 reviewerId:string; role:'code'|'language'|'security'|'tests';
 evidence:string; path:string; severity:Severity; description:string;
}
export interface ConsolidatedFinding {
 key:string; path:string; evidence:string; severity:Severity;
 reviewerIds:readonly string[]; roles:readonly ReviewFinding['role'][];
 status:'needs-verification'|'advisory';
}
const severity:Record<Severity,number>={LOW:1,MEDIUM:2,HIGH:3,CRITICAL:4};
export function consolidateReviewFindings(findings:readonly ReviewFinding[]):readonly ConsolidatedFinding[]{
 const groups=new Map<string,ReviewFinding[]>();
 for(const f of findings){
  if(!f.reviewerId.trim()||!f.evidence.trim()||!f.path.trim()||!f.description.trim()
    ||!Object.hasOwn(severity,f.severity)||!['code','language','security','tests'].includes(f.role))
    throw new Error('review: malformed finding');
  const path=f.path.replaceAll('\\','/');
  if(path.startsWith('/')||path.split('/').includes('..'))throw new Error('review: unsafe path');
  const key=JSON.stringify([path,f.evidence.trim().replace(/\s+/g,' ')]);
  groups.set(key,[...(groups.get(key)??[]),f]);
 }
 return Object.freeze([...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,group])=>{
  const max=group.reduce((a,b)=>severity[a.severity]>=severity[b.severity]?a:b);
  return Object.freeze({
   key,path:max.path,evidence:max.evidence,severity:max.severity,
   reviewerIds:Object.freeze([...new Set(group.map(f=>f.reviewerId))].sort()),
   roles:Object.freeze([...new Set(group.map(f=>f.role))].sort()),
   status:severity[max.severity]>=3?'needs-verification' as const:'advisory' as const,
  });
 }));
}
export interface FindingVerification {
 key:string; verifierId:string; verdict:'confirmed'|'refuted'|'inconclusive'; evidence:string;
}
export function decideReview(findings:readonly ConsolidatedFinding[],verifications:readonly FindingVerification[]):{
 canApprove:boolean;blocking:readonly string[];unresolved:readonly string[];
}{
 const byKey=new Map<string,FindingVerification>();
 for(const v of verifications){
  if(!v.verifierId.trim()||!v.evidence.trim()||!['confirmed','refuted','inconclusive'].includes(v.verdict)
    ||byKey.has(v.key))throw new Error('review: invalid or duplicate verification');
  byKey.set(v.key,v);
 }
 const blocking:string[]=[],unresolved:string[]=[];
 for(const f of findings){
  if(f.status==='advisory')continue;
  const v=byKey.get(f.key);
  if(!v||f.reviewerIds.includes(v.verifierId)||v.verdict==='inconclusive')
    unresolved.push(f.key);
  else if(v.verdict==='confirmed')blocking.push(f.key);
 }
 return {canApprove:blocking.length===0&&unresolved.length===0,blocking,unresolved};
}

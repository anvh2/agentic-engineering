/**
 * Provider-agnostic planning guidance and capability negotiation.
 * Suggestions never bypass scheduler policy, auth, capacity or review.
 */
export type EngineeringRole='lead'|'worker'|'reviewer'|'test-analyst'|'security-reviewer';
export interface HarnessCapability {
  id:string;
  supportedLanguages: readonly ('go'|'js'|'ts')[];
  roles: readonly EngineeringRole[];
  available:boolean;
  isolatedExecution:boolean;
  supportsCancellation:boolean;
}
export interface EngineeringUnit {
 id:string;objective:string;acceptanceCriteria:readonly string[];
 allowedFiles:readonly string[];risk:'low'|'medium'|'high';
 dependencies:readonly string[];
}
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export function validateEngineeringPlan(units:readonly EngineeringUnit[]): readonly EngineeringUnit[]{
 const map=new Map<string,EngineeringUnit>();
 for(const u of units){
  if(!ID.test(u.id)||!u.objective.trim()||!u.acceptanceCriteria.length||!u.allowedFiles.length
    ||!['low','medium','high'].includes(u.risk)||map.has(u.id)
    ||u.allowedFiles.some(p=>!p||p.startsWith('/')||p.split('/').includes('..')))throw new Error('orchestration: invalid task');
  map.set(u.id,u);
 }
 const visited=new Set<string>(),visiting=new Set<string>(),sorted:EngineeringUnit[]=[];
 const visit=(id:string)=>{
  if(visiting.has(id))throw new Error('orchestration: dependency cycle');
  if(visited.has(id))return;
  const node=map.get(id);
  if(!node)throw new Error('orchestration: unknown dependency');
  visiting.add(id);
  for(const dep of node.dependencies)visit(dep);
  visiting.delete(id);visited.add(id);sorted.push(node);
 };
 for(const id of [...map.keys()].sort())visit(id);
 return Object.freeze(sorted);
}
export function eligibleHarnesses(units:readonly EngineeringUnit[],harnesses:readonly HarnessCapability[],language:'go'|'js'|'ts',role:EngineeringRole):readonly string[]{
 // This only enumerates candidates; scheduler still enforces actual permissions.
 validateEngineeringPlan(units);
 if(language==='ts'&&role==='worker')return Object.freeze([]);
 return Object.freeze(harnesses.filter(h=>h.available&&h.isolatedExecution&&h.supportsCancellation
   &&h.supportedLanguages.includes(language)&&h.roles.includes(role)
   &&ID.test(h.id)).map(h=>h.id).sort());
}

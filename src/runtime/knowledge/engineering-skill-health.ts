/** Skill efficacy accounting from verified run evidence.
 * Zero samples are UNMEASURED, not automatically healthy.
 */
export interface SkillRun {
 skillId:string;revision:string;taskId:string;projectId:string;
 outcome:'accepted'|'rejected';independentlyVerified:boolean;at:number;
}
export interface SkillHealth {
 skillId:string;revision:string;sampleCount:number;acceptedCount:number;
 acceptanceRate:number|null;recentAcceptanceRate:number|null;
 priorAcceptanceRate:number|null;trend:'unmeasured'|'insufficient'|'declining'|'stable'|'improving';
}
export function skillHealth(runs:readonly SkillRun[],now:number,options:{windowMs?:number;minSamples?:number;declineThreshold?:number}={}):readonly SkillHealth[]{
 const window=options.windowMs??30*86400000,minimum=options.minSamples??3,threshold=options.declineThreshold??0.1;
 if(!Number.isFinite(now)||!Number.isSafeInteger(window)||window<=0||!Number.isSafeInteger(minimum)||minimum<1
 ||threshold<0||threshold>1)throw new Error('skill: invalid health policy');
 const grouped=new Map<string,SkillRun[]>();
 const seen=new Set<string>();
 for(const r of runs){
  if(!r.skillId.trim()||!r.revision.trim()||!r.projectId.trim()||!r.taskId.trim()
   ||!Number.isFinite(r.at)||r.at>now||!r.independentlyVerified)throw new Error('skill: invalid evidence');
  const id=JSON.stringify([r.skillId,r.revision,r.projectId,r.taskId]);
  if(seen.has(id))throw new Error('skill: duplicate run');
  seen.add(id);
  const key=JSON.stringify([r.skillId,r.revision]);
  grouped.set(key,[...(grouped.get(key)??[]),r]);
 }
 const rate=(v:SkillRun[]):number|null=>v.length?v.filter(x=>x.outcome==='accepted').length/v.length:null;
 return Object.freeze([...grouped.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,all])=>{
  const [skillId,revision]=JSON.parse(key) as [string,string];
  const recent=all.filter(r=>r.at>now-window),prior=all.filter(r=>r.at<=now-window&&r.at>now-2*window);
  const current=rate(recent),previous=rate(prior);
  let trend:SkillHealth['trend']='unmeasured';
  if(recent.length)trend=recent.length<minimum||prior.length<minimum?'insufficient'
    :current!<previous!-threshold?'declining':current!>previous!+threshold?'improving':'stable';
  return Object.freeze({skillId,revision,sampleCount:recent.length,acceptedCount:recent.filter(r=>r.outcome==='accepted').length,
   acceptanceRate:rate(all),recentAcceptanceRate:current,priorAcceptanceRate:previous,trend});
 }));
}

import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {skillHealth,type SkillRun} from './engineering-skill-health.ts';
const day=86400000,now=100*day;
const run=(id:number,at:number,outcome:'accepted'|'rejected'):SkillRun=>({skillId:'go-rule',revision:'v1',taskId:'t'+id,projectId:'project',outcome,independentlyVerified:true,at});
test('missing current observations are unmeasured, not healthy',()=>{
 const h=skillHealth([run(1,now-40*day,'accepted')],now);
 assert.equal(h[0]!.trend,'unmeasured');assert.equal(h[0]!.recentAcceptanceRate,null);
});
test('measured decline is surfaced with sufficient independent trials',()=>{
 const records=[run(1,now-40*day,'accepted'),run(2,now-39*day,'accepted'),run(3,now-38*day,'accepted'),
 run(4,now-day,'rejected'),run(5,now-2*day,'rejected'),run(6,now-3*day,'accepted')];
 assert.equal(skillHealth(records,now)[0]!.trend,'declining');
 assert.throws(()=>skillHealth([...records,{...records[0]!}],now),/duplicate/);
 assert.throws(()=>skillHealth([{...records[0]!,independentlyVerified:false}],now),/invalid evidence/);
});

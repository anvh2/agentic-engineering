import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ENGINEERING_SPECIALISTS } from '../../runtime/knowledge/engineering-specialists.ts';
import { mastraSpecialistAgents, renderSpecialistInstructions } from './specialist-agents.ts';

test('all portable specialists are materialized as Mastra agents with stable registry keys',()=>{
 const expected=ENGINEERING_SPECIALISTS.map(p=>`specialist_${p.id.replaceAll('-','_')}`).sort();
 assert.deepEqual(Object.keys(mastraSpecialistAgents).sort(),expected);
 for(const profile of ENGINEERING_SPECIALISTS){
   const prompt=renderSpecialistInstructions(profile);
   assert.match(prompt,/READ-ONLY/);
   assert.match(prompt,/advisory/);
   for(const skill of profile.skills)assert.ok(prompt.includes(skill),`missing ${skill} in ${profile.id}`);
 }
});
test('the specialist renderer rejects undeclared skills instead of silently omitting them',()=>{
 const sample=ENGINEERING_SPECIALISTS[0]!;
 assert.throws(()=>renderSpecialistInstructions({...sample,skills:['unknown-skill']}),/unknown skill/);
});

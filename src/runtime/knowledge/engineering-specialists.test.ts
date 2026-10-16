import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ENGINEERING_SPECIALISTS,validateSpecialists } from './engineering-specialists.ts';
import { ENGINEERING_SKILLS,validateSkillDefinitions,skillById } from './engineering-skills.ts';

test('portable catalog contains distinct bounded specialist roles and forty skills',()=>{
 assert.equal(ENGINEERING_SPECIALISTS.length,16);
 assert.equal(ENGINEERING_SKILLS.length,40);
 validateSpecialists(ENGINEERING_SPECIALISTS);
 validateSkillDefinitions(ENGINEERING_SKILLS);
 assert.equal(new Set(ENGINEERING_SPECIALISTS.map(x=>x.id)).size,ENGINEERING_SPECIALISTS.length);
 assert.equal(new Set(ENGINEERING_SKILLS.map(x=>x.id)).size,ENGINEERING_SKILLS.length);
 for(const p of ENGINEERING_SPECIALISTS){
  assert.equal(p.mode,'read-only');
  for(const id of p.skills) assert.ok(skillById(id),`missing skill ${id}`);
 }
});
test('catalog profile boundaries reject writable roles and invalid skill names',()=>{
 assert.throws(()=>validateSpecialists([{...ENGINEERING_SPECIALISTS[0]!,mode:'write' as 'read-only'}]),/invalid/);
 assert.throws(()=>validateSkillDefinitions([...ENGINEERING_SKILLS,ENGINEERING_SKILLS[0]!]),/invalid/);
});

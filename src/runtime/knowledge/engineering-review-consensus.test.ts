import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {consolidateReviewFindings,decideReview} from './engineering-review-consensus.ts';
test('merges duplicate evidence across reviewers and chooses strictest severity',()=>{
 const findings=consolidateReviewFindings([
  {reviewerId:'code',role:'code',path:'src/a.go',evidence:'bad  input',severity:'MEDIUM',description:'bug'},
  {reviewerId:'security',role:'security',path:'src/a.go',evidence:'bad input',severity:'HIGH',description:'injection'},
 ]);
 assert.equal(findings.length,1);assert.equal(findings[0]!.severity,'HIGH');
 assert.equal(findings[0]!.reviewerIds.length,2);
 assert.equal(decideReview(findings,[]).canApprove,false);
 assert.equal(decideReview(findings,[{key:findings[0]!.key,verifierId:'independent',verdict:'confirmed',evidence:'reproduced'}]).canApprove,false);
 assert.equal(decideReview(findings,[{key:findings[0]!.key,verifierId:'independent',verdict:'refuted',evidence:'counterexample'}]).canApprove,true);
});
test('refuses unsafe paths and self-verification of a sole reviewer',()=>{
 assert.throws(()=>consolidateReviewFindings([{reviewerId:'x',role:'code',path:'../secret',evidence:'e',severity:'HIGH',description:'d'}]));
 const f=consolidateReviewFindings([{reviewerId:'x',role:'code',path:'src/a.go',evidence:'bug',severity:'HIGH',description:'bug'}]);
 assert.equal(decideReview(f,[{key:f[0]!.key,verifierId:'x',verdict:'refuted',evidence:'no'}]).canApprove,false);
});

test('a member of a multi-reviewer finding cannot self-refute',()=>{
 const findings=consolidateReviewFindings([
  {reviewerId:'a',role:'security',path:'src/auth.go',evidence:'bypass',severity:'HIGH',description:'risk'},
  {reviewerId:'b',role:'code',path:'src/auth.go',evidence:'bypass',severity:'CRITICAL',description:'risk'},
 ]);
 const attempt=decideReview(findings,[{key:findings[0]!.key,verifierId:'b',verdict:'refuted',evidence:'I disagree'}]);
 assert.equal(attempt.canApprove,false);
 assert.equal(attempt.unresolved.length,1);
});

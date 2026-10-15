import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { inspectHook, compactSession } from './engineering-hooks.ts';
const allow={taskId:'t1',tools:['readFile','writeFile'],paths:['src/a.go']};
const baseline={sessionId:'s1',seq:1,phase:'PreToolUse' as const,taskId:'t1',tool:'writeFile',relativePath:'src/a.go'};
test('hook guard limits tools and paths',()=>{
 assert.equal(inspectHook(baseline,allow).accepted,true);
 assert.equal(inspectHook({...baseline,tool:'shell'},allow).accepted,false);
 assert.equal(inspectHook({...baseline,relativePath:'../secrets'},allow).accepted,false);
 assert.equal(inspectHook({...baseline,relativePath:'src/a.go/../secret'},allow).accepted,false);
 assert.equal(inspectHook({...baseline,taskId:'other'},allow).accepted,false);
});
test('compaction preserves verified and unverified task status without truncation',()=>{
 const data={taskId:'t1',checkpointDigest:'a'.repeat(64),completedSteps:['tested'],pendingSteps:['review'],unverifiedClaims:['model said pass']};
 assert.deepEqual(JSON.parse(compactSession(data)).unverifiedClaims,['model said pass']);
 assert.throws(()=>compactSession({...data,pendingSteps:['x'.repeat(5000)]},512),/truncate/);
});

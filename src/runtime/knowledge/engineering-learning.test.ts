import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { proposeLesson, latestCheckpoint } from './engineering-knowledge.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('learning proposals require runtime verified and independent acceptance', () => {
  const good = { taskId:'task-1',projectId:'project-a',status:'PASS' as const,runtimeVerified:true,independentlyAccepted:true,evidenceHash:sha('e') };
  const lesson = proposeLesson({id:'approved-pattern',projectId:'project-a',body:'Preserve context cancellation',outcomes:[good]});
  assert.equal(lesson.status,'candidate');
  assert.deepEqual(lesson.evidenceHashes,[good.evidenceHash]);
  assert.throws(()=>proposeLesson({id:'approved-pattern',projectId:'project-a',body:'no',outcomes:[{...good,runtimeVerified:false}]}));
  assert.throws(()=>proposeLesson({id:'approved-pattern',projectId:'project-a',body:'no',outcomes:[{...good,independentlyAccepted:false}]}));
  assert.throws(()=>proposeLesson({id:'approved-pattern',projectId:'project-a',body:'no',outcomes:[{...good,projectId:'project-b'}]}));
});

test('session checkpoint projection is deterministic and detects conflicting sequences', () => {
  const events = [
    {sessionId:'s',taskId:'t',seq:1,state:'READY',evidenceHash:sha('1')},
    {sessionId:'s',taskId:'t',seq:2,state:'RUNNING',evidenceHash:sha('2')},
  ];
  assert.equal(latestCheckpoint(events,'s')?.state,'RUNNING');
  assert.equal(latestCheckpoint(events,'other'),undefined);
  assert.throws(()=>latestCheckpoint([...events,{...events[1],evidenceHash:sha('conflict')}],'s'));
});

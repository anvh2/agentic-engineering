import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceMission, classifyExit, createMission, initState, pendingMission, readState, validateServer, writeState } from './state.ts';

test('headless refuses duplicate/unsafe objective names and live/external endpoints', () => {
  assert.throws(() => createMission({ mission: 'm', server: 'http://127.0.0.1:4211', objectives: ['x', 'x'] }));
  assert.throws(() => createMission({ mission: 'm', server: 'http://127.0.0.1:4211', objectives: ['../evil'] }));
  for (const url of ['http://127.0.0.1:4111', 'https://127.0.0.1:4211',
    'http://example.com:4211', 'http://localhost:4211/hidden']) assert.throws(() => validateServer(url));
  assert.equal(validateServer('http://127.0.0.1:4211'), 'http://127.0.0.1:4211');
});

test('exit codes preserve the distinction between verified acceptance and unknown outcome', () => {
  const s = createMission({ mission: 'm', server: 'http://127.0.0.1:4211', objectives: ['one', 'two'] });
  assert.equal(pendingMission(s)?.objectiveId, 'one');
  const first = advanceMission(s, 'one', 4);
  assert.equal(first.jobs[0].phase, 'AWAITING_OPERATOR');
  assert.equal(pendingMission(first)?.objectiveId, 'two');
  assert.equal(classifyExit(2), 'UNKNOWN');
  assert.equal(classifyExit(null), 'UNKNOWN');
  assert.equal(advanceMission(s, 'one', 0).jobs[0].phase, 'ACCEPTED');
});

test('mission state is durable; initialization cannot clobber an existing mission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm11-checkpoint-'));
  try {
    const file = join(dir, 'mission.json');
    const initial = createMission({ mission: 'm', server: 'http://localhost:4211', objectives: ['task'] });
    await initState(file, initial);
    await assert.rejects(initState(file, initial));
    await writeState(file, advanceMission(initial, 'task', 3));
    assert.equal((await readState(file)).jobs[0].phase, 'ESCALATED');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).schema, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

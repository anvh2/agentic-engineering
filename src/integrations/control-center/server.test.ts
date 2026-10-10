import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { request } from 'node:http';
import { createGateway } from './server.ts';
import { fixture } from './__testing__/fixture.ts';

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const f = fixture();
  const gateway = createGateway({ reader: f.reader, assetsDir: f.directory, pollMs: 20 });
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  const url = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  t.after(async () => {
    gateway.closeStreams();
    gateway.server.closeAllConnections();
    await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    f.close();
  });
  return { ...f, url };
}
test('HTTP allows reads only, rejects cross-origin/rebinding and hides errors and secret payloads', async (t) => {
  const f = await setup(t);
  const response = await fetch(`${f.url}/api/v1/snapshot?objectiveId=B1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal((await response.json()).tasks.length, 2);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await fetch(`${f.url}/api/v1/snapshot`, { method })).status, 405);
  assert.equal((await fetch(`${f.url}/api/v1/snapshot`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const status = await new Promise<number>((resolve) => {
    request(`${f.url}/api/v1/snapshot`, { headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).end();
  });
  assert.equal(status, 403);
  assert.equal((await fetch(`${f.url}/api/v1/snapshot?objectiveId=..%2F.env`)).status, 400);
  assert.equal((await fetch(`${f.url}/.env`)).status, 404);
  assert.equal((await fetch(`${f.url}/`)).status, 503);
  f.store.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('sk-abcdefghijklmno', 'task-a');
  assert.ok(!(await (await fetch(`${f.url}/api/v1/snapshot?objectiveId=B1`)).text()).includes('sk-abcdefghijklmno'));
});
async function readUntil(response: Response, marker: string) {
  const reader = response.body!.getReader();
  let text = '';
  try {
    while (!text.includes(marker)) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    return text;
  } finally {
    await reader.cancel();
  }
}
test('SSE replays persisted events by Last-Event-ID, reconnects without duplicate events and resets invalid history', async (t) => {
  const f = await setup(t);
  const cursor = f.reader.snapshot('B1').cursor!;
  f.store.promote();
  const response = await fetch(`${f.url}/api/v1/events?objectiveId=B1`, {
    headers: { 'Last-Event-ID': cursor },
    signal: AbortSignal.timeout(3000),
  });
  const body = await readUntil(response, 'event: checkpoint');
  assert.ok(body.includes('event: task.queued'));
  assert.ok(!body.includes('event: provider.started'));
  const next = f.reader.snapshot('B1').cursor!;
  const resumed = await readUntil(
    await fetch(`${f.url}/api/v1/events?objectiveId=B1`, { headers: { 'Last-Event-ID': next }, signal: AbortSignal.timeout(3000) }),
    'event: checkpoint',
  );
  assert.ok(!resumed.includes('event: task.queued'));
  assert.ok(resumed.includes('event: snapshot'));
  const reset = await readUntil(
    await fetch(`${f.url}/api/v1/events?objectiveId=B1&cursor=bad`, { signal: AbortSignal.timeout(3000) }),
    'event: checkpoint',
  );
  assert.ok(reset.includes('event: reset'));
});

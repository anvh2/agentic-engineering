import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createControlCenterApp } from './http-app.ts';
import { createControlCenterRoutes } from './mastra-routes.ts';
import { fixture } from './__testing__/fixture.ts';

test('Mastra routes are opt-in and avoid the reserved /api prefix (the server refuses to start otherwise)', t => {
  const previous = process.env.CONTROL_CENTER_ENABLED;
  t.after(() => { if (previous === undefined) delete process.env.CONTROL_CENTER_ENABLED; else process.env.CONTROL_CENTER_ENABLED = previous; });
  delete process.env.CONTROL_CENTER_ENABLED;
  assert.deepEqual(createControlCenterRoutes(), []);
  process.env.CONTROL_CENTER_ENABLED = '1';
  const routes = createControlCenterRoutes();
  assert.deepEqual(routes.map(r => r.path), ['/control-center/v1/*', '/organization-app/*']);
  for (const route of routes) {
    assert.ok(!route.path.startsWith('/api/'), route.path);
    assert.equal(route.requiresPermission, 'observability:read');
  }
});

test('embedded transport stays same-origin/read-only; collaboration has no production fixtures', async t => {
  const f = fixture(); t.after(() => f.close());
  const app = createControlCenterApp({ reader: f.reader, assetsDir: f.directory, embedded: true });
  const get = (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost:4111${path}`, init));
  writeFileSync(`${f.directory}/index.html`, '<link href="/app.css"><script src="/app.js"></script>');
  const index = get('/organization-app/');
  assert.match(index.headers.get('content-security-policy')!, /frame-ancestors 'self'/);
  assert.match(await index.text(), /\/organization-app\/app.js/);
  assert.equal(get('/api/v1/snapshot').status, 404);
  assert.equal(get('/api/control-center/v1/snapshot').status, 404);
  assert.equal(get('/control-center/v1/snapshot').status, 200);
  assert.equal(get('/control-center/v1/snapshot', { method: 'POST' }).status, 405);
  assert.equal(get('/control-center/v1/snapshot', { headers: { origin: 'https://external.example' } }).status, 403);
  assert.equal(app.fetch(new Request('http://external.example/control-center/v1/snapshot')).status, 403);
  assert.equal(get('/organization-app/.env').status, 404);
  const collaboration = await get('/control-center/v1/collaboration').json();
  assert.equal(collaboration.availability, 'NOT_AVAILABLE');
  assert.equal(collaboration.source, 'unavailable');
  assert.deepEqual(collaboration.threads, []);
  assert.deepEqual(collaboration.meetings, []);
});

test('embedded SSE uses the durable cursor; closes on abort and replay does not invent provider events', async t => {
  const f = fixture(); t.after(() => f.close());
  const app = createControlCenterApp({ reader: f.reader, assetsDir: f.directory, embedded: true });
  t.after(() => app.closeStreams());
  const cursor = f.reader.snapshot('B1').cursor!;
  f.store.promote();
  const abort = new AbortController();
  const response = app.fetch(new Request('http://localhost:4111/control-center/v1/events?objectiveId=B1', { signal: abort.signal, headers: { 'Last-Event-ID': cursor } }));
  const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('event: checkpoint')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: task.queued/);
  assert.doesNotMatch(text, /event: provider.started/);
  abort.abort();
  assert.equal((await reader.read()).done, true);
});

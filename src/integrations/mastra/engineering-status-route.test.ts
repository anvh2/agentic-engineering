import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngineeringStatusRoute, readEngineeringStatus } from './engineering-status-route.ts';

test('the status read reflects the live pack, tolerates a missing database, and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-'));
  try {
    const report = readEngineeringStatus({ dbPath: join(dir, 'none.db'), now: () => 5, env: {} });
    assert.equal(report.schema, 'engineering-status/v1');
    assert.equal(report.pack.loaded, true);
    assert.equal(report.generatedAt, 5);
    assert.ok(report.agents.length >= 18);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unavailable pack is reported as an error in the body, not a crash', () => {
  const report = readEngineeringStatus({ root: null, now: () => 1, env: {} });
  assert.equal(report.pack.loaded, false);
  assert.ok(report.issues.some((i) => i.code === 'pack_unloaded' && i.level === 'error'));
});

test('the route is a read-only GET that requires the observability permission', () => {
  const route = createEngineeringStatusRoute() as unknown as { path: string; method: string; requiresPermission?: string };
  assert.equal(route.path, '/engineering/v1/status');
  assert.equal(route.method, 'GET');
  assert.equal(route.requiresPermission, 'observability:read');
});

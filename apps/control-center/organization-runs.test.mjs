import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const origin = process.env.STUDIO_TEST_ORIGIN ?? 'http://127.0.0.1:4513';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Local Studio required');

test('actual Studio: four sections, persisted Runs filters, workers, counters, DAG and evidence boundaries',
  { skip: !process.env.CHROME_EXECUTABLE && 'Set CHROME_EXECUTABLE', timeout: 90000 }, async t => {
    const discovery = await (await fetch(`${origin}/control-center/v1/snapshot`)).json();
    assert.equal(discovery.source, 'connected');
    let observed;
    for (const batch of discovery.objectives) {
      const data = await (await fetch(`${origin}/control-center/v1/snapshot?objectiveId=${encodeURIComponent(batch.id)}`)).json();
      if (data.tasks.length && !observed) observed = data;
      if (data.tasks.some(t => t.workerId && t.provider !== 'claude' && t.runIds.length)) { observed = data; break; }
    }
    assert.ok(observed, 'Persisted tasks required; no fixture fallback');
    const task = observed.tasks.find(t => t.workerId && t.provider !== 'claude' && t.runIds.length) ?? observed.tasks[0];
    const batch = discovery.objectives.find(o => o.id === observed.objectiveId);
    const out = fileURLToPath(new URL('../../.workdir/control-center/m13/', import.meta.url));
    mkdirSync(out, { recursive: true });
    const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const req = route.request();
      if (new URL(req.url()).origin !== origin || !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.abort();
      return route.continue();
    });
    const workspace = page.frameLocator('iframe[title="Organization workspace"]');
    if (process.env.M13_BASELINE_ASSETS) {
      await page.route('**/organization-app/app.*', route => {
        const name = new URL(route.request().url()).pathname.split('/').at(-1);
        return route.fulfill({ path: `${process.env.M13_BASELINE_ASSETS}/${name}` });
      });
      await page.goto(`${origin}/organization`);
      await workspace.getByRole('heading', { name: 'Agent hierarchy', exact: false }).waitFor();
      await workspace.getByLabel('Objective', { exact: true }).selectOption(batch.id);
      await workspace.getByRole('button', { name: 'Runs', exact: true }).click();
      await workspace.getByRole('heading', { name: 'Persisted workflow runs' }).waitFor();
      await page.screenshot({ path: `${out}/before-runs.png`, fullPage: true });
      await page.unroute('**/organization-app/app.*');
    }
    await page.goto(`${origin}/organization`);
    const navigation = workspace.getByRole('navigation', { name: 'Organization views' });
    await navigation.getByRole('button', { name: 'Overview', exact: true }).waitFor();
    assert.deepEqual(await navigation.getByRole('button').allTextContents(), ['Overview', 'Runs', 'Collaboration', 'Usage']);
    // The scope is shared: it sits above every section, not only Runs.
    assert.equal(await workspace.getByLabel('Objective / scheduler batch', { exact: true }).count(), 1);
    await navigation.getByRole('button', { name: 'Runs', exact: true }).click();
    await workspace.getByLabel('Project', { exact: true }).selectOption(batch.label);
    await workspace.getByLabel('Objective / scheduler batch', { exact: true }).selectOption(batch.id);
    await workspace.getByRole('heading', { name: 'Tasks & dependencies' }).waitFor();
    assert.equal(await workspace.getByRole('table', { name: 'Objective DAG' }).locator('tbody tr').count(), observed.tasks.length);
    await workspace.getByRole('button', { name: task.title, exact: true }).click();
    const inspector = workspace.getByRole('complementary', { name: 'Details inspector' });
    await inspector.getByRole('heading', { name: 'Task execution evidence' }).waitFor();
    const text = await inspector.innerText();
    assert.ok(text.includes(batch.label));
    assert.ok(text.includes(task.workerId ?? 'UNKNOWN'));
    assert.ok(text.includes('Task state is not a verifier PASS'));
    assert.ok(text.includes(`Coding attempts (all runs)\n${task.execution.attempts}`));
    await page.screenshot({ path: `${out}/after-runs-detail.png`, fullPage: true });
    await workspace.getByRole('button', { name: 'Close inspector' }).click();
    await workspace.getByLabel('Task status', { exact: true }).selectOption(task.state);
    const tasks = workspace.locator('section').filter({ has: workspace.getByRole('heading', { name: 'Tasks & dependencies', exact: true }) });
    assert.equal(await tasks.locator('tbody tr').count(), observed.tasks.filter(t => t.state === task.state).length);
    await page.screenshot({ path: `${out}/after-runs.png`, fullPage: true });
    await navigation.getByRole('button', { name: 'Collaboration', exact: true }).click();
    for (const kind of ['Discussions', 'Meetings', 'Council']) {
      await workspace.getByRole('navigation', { name: 'Collaboration views' }).getByRole('button', { name: kind, exact: true }).click();
      await workspace.getByRole('navigation', { name: 'Collaboration views' }).getByRole('button', { name: kind, exact: true }).waitFor();
    }
    // Embedded, the scope lives in Studio's own address bar: a copied Studio link restores it, and Back walks it.
    await navigation.getByRole('button', { name: 'Runs', exact: true }).click();
    await workspace.getByLabel('Project', { exact: true }).selectOption(batch.label);
    const studioUrl = new URL(page.url());
    assert.equal(studioUrl.pathname, '/organization');
    assert.equal(studioUrl.searchParams.get('project'), batch.label);
    assert.equal(studioUrl.searchParams.get('section'), 'runs');
    await workspace.getByLabel('Objective / scheduler batch', { exact: true }).selectOption(batch.id);
    await workspace.getByRole('heading', { name: 'Tasks & dependencies' }).waitFor();
    await page.reload();
    await workspace.getByRole('heading', { name: 'Tasks & dependencies' }).waitFor();
    assert.equal(await workspace.getByLabel('Objective / scheduler batch', { exact: true }).inputValue(), batch.id);
    await page.goBack();
    await workspace.getByRole('heading', { name: 'Tasks & dependencies' }).waitFor();
    assert.equal(await workspace.getByLabel('Objective / scheduler batch', { exact: true }).inputValue(), '');
    assert.equal(await workspace.getByLabel('Project', { exact: true }).inputValue(), batch.label);
    assert.equal(new URL(page.url()).pathname, '/organization', 'Back stays inside the Organization page');
    // A link opened fresh restores the same view.
    await page.goto(`${origin}/organization?section=runs&project=${encodeURIComponent(batch.label)}&objective=${encodeURIComponent(batch.id)}`);
    await workspace.getByRole('heading', { name: 'Tasks & dependencies' }).waitFor();
    assert.equal(await workspace.getByLabel('Objective / scheduler batch', { exact: true }).inputValue(), batch.id);
    await page.screenshot({ path: `${out}/shared-scope-runs.png`, fullPage: true });
    await page.reload();
    await navigation.getByRole('button', { name: 'Runs', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    writeFileSync(`${out}/evidence.json`, JSON.stringify({ origin, batchId: batch.id, project: batch.label, taskId: task.id, workerId: task.workerId, state: task.state, execution: task.execution, observedAt: observed.observedAt, source: 'persisted scheduler database; no fixture fallback', errors }, null, 2));
  });

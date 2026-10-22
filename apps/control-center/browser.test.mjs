import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { fixture } from '../../src/integrations/control-center/__testing__/fixture.ts';
import { createGateway } from '../../src/integrations/control-center/server.ts';

test(
  'Organization slice: scoped data, keyboard inspector, themes, responsive layout, live transitions and disconnect',
  { skip: !process.env.CHROME_EXECUTABLE && 'Set CHROME_EXECUTABLE to an installed Chrome/Chromium binary' },
  async (t) => {
    const f = fixture(Date.now());
    const gateway = createGateway({ reader: f.reader, assetsDir: fileURLToPath(new URL('./dist/', import.meta.url)), pollMs: 100 });
    gateway.server.listen(0, '127.0.0.1');
    await once(gateway.server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
    t.after(async () => {
      await browser.close();
      gateway.closeStreams();
      gateway.server.closeAllConnections();
      await new Promise((resolve) => gateway.server.close(resolve));
      f.close();
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const mutations = [];
    page.on('request', (req) => {
      if (req.method() !== 'GET') mutations.push(req.method());
    });
    await page.goto(`http://127.0.0.1:${gateway.server.address().port}`);
    await page.getByText('Scheduler connected', { exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.deepEqual(await page.getByRole('navigation', { name: 'Primary' }).getByRole('button').allTextContents(), ['Overview', 'Runs', 'Collaboration', 'Usage']);
    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    await page.getByLabel('Objective / scheduler batch', { exact: true }).selectOption('B1');
    // Separate scheduler state, outcome and trace evidence; a task without a run says so.
    await page.getByRole('columnheader', { name: 'Outcome (failure · review)' }).waitFor();
    await page.getByText('No run recorded', { exact: true }).first().waitFor();
    await page.getByLabel('Task status', { exact: true }).selectOption('__attention');
    await page.getByText('No tasks in this scope.', { exact: false }).waitFor();
    await page.getByLabel('Task status', { exact: true }).selectOption('');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    // Lanes are persisted providers only: no model names as workers, no assumed lead identity.
    await page.getByRole('heading', { name: 'Execution lanes by provider', exact: false }).waitFor();
    for (const name of ['Qwen', 'Claude Engineering Lead', 'Codex', 'Gemini']) assert.equal(await page.locator('.agent-table').getByText(name, { exact: false }).count(), 0, name);
    await page.locator('.agent-table').getByText('OBSERVED', { exact: true }).first().waitFor();
    assert.ok((await page.locator('.agent-table').innerText()).includes('NO ACTIVE RUN'));
    const qwen = page.getByRole('button', { name: /^ollama/ });
    await qwen.waitFor();
    await qwen.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('complementary', { name: 'Details inspector' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Close inspector' }).evaluate((el) => el === document.activeElement), true);
    await page.getByRole('tab', { name: 'Overview', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Usage', exact: true }).getAttribute('aria-selected'), 'true');
    assert.ok((await page.getByRole('tabpanel').innerText()).includes('Core telemetry unavailable'));
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('tab', { name: 'Runs', exact: true }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await page.getByRole('tab', { name: 'Overview', exact: true }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('complementary').count(), 0);
    assert.equal(await qwen.evaluate((el) => el === document.activeElement), true);
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    const output = fileURLToPath(new URL('../../.workdir/control-center/screenshots/', import.meta.url));
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: `${output}/organization-light.png`, fullPage: true });
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    f.advance(Date.now() - f.reader.snapshot().observedAt);
    const claim = f.claim();
    f.store.heartbeat('task-a', claim.fence, 60000);
    f.store.recordRun('task-a', claim.fence, 'synthetic-run-a');
    f.store.transition('task-a', 'CODING', { actor: 'worker-1', fence: claim.fence });
    f.store.transition('task-a', 'VERIFYING', { actor: 'worker-1', fence: claim.fence });
    await page.locator('.agent-table').getByText('VERIFYING', { exact: true }).waitFor();
    await page.locator('.agent-table').getByText('ACTIVE', { exact: true }).waitFor();
    await qwen.click();
    const inspector = page.getByRole('complementary');
    await inspector.getByText('Implement scoped parser', { exact: true }).waitFor();
    assert.equal(
      await inspector.getByRole('link', { name: 'Mastra run' }).first().getAttribute('href'),
      'http://localhost:4111/workflows/coding-task-workflow/graph/synthetic-run-a',
    );
    await page.screenshot({ path: `${output}/organization-dark-inspector.png`, fullPage: true });
    f.store.transition('task-a', 'REVIEW_PENDING', { actor: 'worker-1', fence: claim.fence, review: {} });
    await inspector.getByText('reached review or later in this batch', { exact: false }).waitFor();
    assert.ok((await inspector.innerText()).includes('UNKNOWN'));
    await page.getByRole('button', { name: 'Close inspector' }).click();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    await page.getByRole('heading', { name: 'Review queue' }).waitFor();
    await page.getByText('synthetic-run-a', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Verify parser behavior', exact: true }).click();
    assert.ok((await page.getByRole('complementary').innerText()).includes('task-a'));
    await page.getByRole('button', { name: 'Close inspector' }).click();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.setViewportSize({ width: 768, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${output}/organization-narrow.png`, fullPage: true });
    gateway.closeStreams();
    gateway.server.close();
    await page.getByRole('alert').filter({ hasText: 'Scheduler connection unavailable' }).waitFor();
    assert.ok((await page.locator('.agent-table').innerText()).includes('UNKNOWN'));
    assert.deepEqual(errors, []);
    assert.deepEqual(mutations, []);
  },
);

test(
  'reported usage remains separated across replay, reconnect and completed task outcomes',
  { skip: !process.env.CHROME_EXECUTABLE },
  async (t) => {
    const f = fixture(Date.now());
    f.advance(Date.now() - f.reader.snapshot().observedAt);
    const claim = f.claim();
    f.store.heartbeat('task-a', claim.fence, 60000);
    f.store.recordRun('task-a', claim.fence, 'current');
    let completed = false;
    const usage = {
      inputTokens: 31,
      outputTokens: 7,
      cachedInputTokens: null,
      reasoningTokens: null,
      latencyMs: 50,
      actualCostUsd: null,
      estimatedCost: null,
      source: 'core.model-call',
      completeness: 'partial',
    };
    const current = {
      id: 'call-current',
      objectiveId: 'B1',
      taskId: 'task-a',
      runId: 'current',
      workerId: 'worker-1',
      provider: 'ollama',
      modelId: 'reported-model',
      attempt: 1,
      startedAt: 1,
      finishedAt: 2,
      status: 'COMPLETED',
      usage,
    };
    // Explicit test-only telemetry source. Production continues to show UNKNOWN until Core supplies it.
    const reader = {
      ...f.reader,
      snapshot: (id) => {
        const snapshot = f.reader.snapshot(id);
        if (id === 'B1') {
          snapshot.calls = [current, current, { ...current, id: 'call-old', runId: 'old', usage: { ...usage, inputTokens: 97 } }];
          const agent = snapshot.agents.find((a) => a.id === 'ollama');
          agent.activity = completed ? 'UNKNOWN' : 'RUNNING';
          agent.modelId = 'reported-model';
        }
        return snapshot;
      },
    };
    const gateway = createGateway({ reader, assetsDir: fileURLToPath(new URL('./dist/', import.meta.url)), pollMs: 100 });
    gateway.server.listen(0, '127.0.0.1');
    await once(gateway.server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
    t.after(async () => {
      await browser.close();
      gateway.closeStreams();
      gateway.server.closeAllConnections();
      await new Promise((resolve) => gateway.server.close(resolve));
      f.close();
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${gateway.server.address().port}`);
    await page.getByText('Scheduler connected', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    await page.getByLabel('Objective / scheduler batch', { exact: true }).selectOption('B1');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('button', { name: /^ollama/ }).click();
    await page.getByRole('tab', { name: 'Usage', exact: true }).click();
    const panel = page.getByRole('tabpanel');
    await panel.getByText('31', { exact: true }).waitFor();
    await panel.getByText('97', { exact: true }).waitFor();
    gateway.closeStreams();
    await page.getByRole('alert').waitFor();
    await page.getByText('Scheduler connected', { exact: true }).waitFor();
    assert.equal(await panel.getByText('31', { exact: true }).count(), 1);
    assert.equal(await panel.getByText('97', { exact: true }).count(), 1);
    completed = true;
    f.store.transition('task-a', 'CANCELLED', { actor: 'test' });
    await panel.getByText('128', { exact: true }).waitFor();
    assert.equal(await panel.getByText('31', { exact: true }).count(), 0);
    await page.getByRole('tab', { name: 'Runs', exact: true }).click();
    assert.ok((await panel.innerText()).includes('Final run outcome\nUNKNOWN'));
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    assert.ok((await panel.innerText()).includes('CANCELLED'));
    assert.equal(await panel.getByText('RUNNING', { exact: true }).count(), 0);
  },
);

test('discussion and meeting inspectors: unavailable production, attributed fixtures, polling replay, sources and disconnect',
  { skip: !process.env.CHROME_EXECUTABLE && 'Set CHROME_EXECUTABLE' }, async t => {
    const { collaborationFixture } = await import('./__testing__/collaboration-fixture.ts');
    const f = fixture(Date.now());
    const gateway = createGateway({ reader: f.reader, assetsDir: fileURLToPath(new URL('./dist/', import.meta.url)) });
    gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
    t.after(async () => { await browser.close(); gateway.closeStreams(); gateway.server.closeAllConnections(); await new Promise(r => gateway.server.close(r)); f.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(`http://127.0.0.1:${gateway.server.address().port}`);
    await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
    await page.getByRole('button', { name: 'Discussions', exact: true }).click();
    await page.getByText('NOT AVAILABLE', { exact: true }).waitFor();
    assert.equal(await page.getByText('SYNTHETIC TEST DATA', { exact: false }).count(), 0);
    let polls = 0;
    await page.route('**/api/v1/collaboration', route => {
      polls++;
      const payload = structuredClone(collaborationFixture);
      payload.threads[0].messages.push({ ...payload.threads[0].messages[0], chainOfThought: 'NEVER_RENDER_PRIVATE' });
      return route.fulfill({ json: payload });
    });
    await page.getByRole('region', { name: 'Discussion transcript' }).waitFor();
    assert.equal(await page.locator('.message').count(), 3);
    assert.ok((await page.locator('main').innerText()).includes('SYNTHETIC TEST DATA'));
    assert.equal(await page.getByText('NEVER_RENDER_PRIVATE', { exact: false }).count(), 0);
    await page.getByText('Objection: OPEN', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'm1', exact: true }).click();
    await page.getByRole('button', { name: 'Meetings', exact: true }).click();
    const inspector = page.getByRole('region', { name: 'Meeting inspector' });
    await inspector.waitFor();
    assert.ok((await inspector.innerText()).includes('Cancellation evidence remains unresolved.'));
    assert.ok((await inspector.innerText()).includes('Input: UNKNOWN · Output: UNKNOWN'));
    assert.ok((await inspector.innerText()).includes('Owner: Codex · Follow-up: PENDING'));
    await inspector.getByRole('button', { name: 'Source message m3', exact: true }).last().click();
    await page.locator('#message-m3.selected-message').waitFor();
    const previous = polls;
    await page.waitForTimeout(5500);
    assert.ok(polls > previous);
    assert.equal(await page.locator('.message').count(), 3);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 960 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.route('**/api/v1/collaboration', route => route.abort());
    await page.getByText('Collaboration connection unavailable.', { exact: false }).waitFor();
    assert.equal(await page.locator('.message').count(), 0);
  });

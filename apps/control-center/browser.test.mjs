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
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const mutations = [];
    page.on('request', (req) => {
      if (req.method() !== 'GET') mutations.push(req.method());
    });
    await page.goto(`http://127.0.0.1:${gateway.server.address().port}`);
    await page.getByText('Scheduler connected', { exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.getByText('No usage aggregated', { exact: true }).count(), 1);
    await page.getByLabel('Objective', { exact: true }).selectOption('B1');
    await page.getByRole('button', { name: 'Qwen' }).waitFor();
    const qwen = page.getByRole('button', { name: 'Qwen' });
    await qwen.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('complementary', { name: 'Details inspector' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Close inspector' }).evaluate((el) => el === document.activeElement), true);
    assert.ok((await page.getByRole('complementary').innerText()).includes('Core telemetry unavailable'));
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('complementary').count(), 0);
    assert.equal(await qwen.evaluate((el) => el === document.activeElement), true);
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    const output = fileURLToPath(new URL('../../.workdir/control-center/screenshots/', import.meta.url));
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: `${output}/organization-light.png`, fullPage: true });
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    const claim = f.claim();
    f.store.recordRun('task-a', claim.fence, 'synthetic-run-a');
    f.store.transition('task-a', 'CODING', { actor: 'worker-1', fence: claim.fence });
    f.store.transition('task-a', 'VERIFYING', { actor: 'worker-1', fence: claim.fence });
    await page.locator('.agent-table').getByText('VERIFYING', { exact: true }).waitFor();
    await qwen.click();
    const inspector = page.getByRole('complementary');
    await inspector.getByText('Implement scoped parser', { exact: true }).waitFor();
    assert.equal(
      await inspector.getByRole('link', { name: 'Mastra run' }).first().getAttribute('href'),
      'http://localhost:4111/workflows/coding-task-workflow/graph/synthetic-run-a',
    );
    await page.screenshot({ path: `${output}/organization-dark-inspector.png`, fullPage: true });
    f.store.transition('task-a', 'REVIEW_PENDING', { actor: 'worker-1', fence: claim.fence, review: {} });
    await inspector.getByText('Historically verified in this objective.', { exact: false }).waitFor();
    assert.ok((await inspector.innerText()).includes('UNKNOWN'));
    await page.getByRole('button', { name: 'Close inspector' }).click();
    await page.getByRole('button', { name: /^Reviews/ }).click();
    await page.getByRole('button', { name: 'task-a', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    await page.getByText('synthetic-run-a', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Objectives', exact: true }).click();
    await page.getByRole('button', { name: 'Verify parser behavior', exact: true }).click();
    assert.ok((await page.getByRole('complementary').innerText()).includes('task-a'));
    await page.getByRole('button', { name: 'Close inspector' }).click();
    await page.getByRole('button', { name: 'Organization', exact: true }).click();
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

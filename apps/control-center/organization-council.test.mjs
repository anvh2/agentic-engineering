import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Runs against an ACTUAL Studio runtime (studio-fork/start.mjs or the owner's 4111 server), never a fixture: the agents are the
// server's registration and the meetings are its real council records. Reads only; every non-GET request is aborted.
const origin = process.env.STUDIO_TEST_ORIGIN ?? 'http://127.0.0.1:4111';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Local Studio required');

test('actual Studio: Organization shows registered agents with model bindings and council meetings, LIVE vs SCRIPTED, with sources',
  { skip: !process.env.CHROME_EXECUTABLE && 'Set CHROME_EXECUTABLE', timeout: 120000 }, async t => {
    const api = async path => (await fetch(`${origin}/control-center/v1${path}`)).json();
    const [roster, council] = [await api('/agents'), await api('/council')];
    assert.equal(roster.source, 'mastra-registration', 'the runtime exposes its registration');
    assert.equal(council.availability, 'AVAILABLE', council.reason ?? '');
    const live = council.meetings.find(m => m.council?.mode === 'LIVE');
    const scripted = council.meetings.find(m => m.council?.mode === 'SCRIPTED');

    const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const req = route.request();
      if (new URL(req.url()).origin !== origin || !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.abort();
      return route.continue();
    });
    const out = fileURLToPath(new URL('../../.workdir/control-center/studio-screenshots/', import.meta.url));
    mkdirSync(out, { recursive: true });

    await page.goto(`${origin}/organization`);
    const org = page.frameLocator('iframe[title="Organization workspace"]');
    const tab = name => org.getByRole('navigation', { name: 'Organization views' }).getByRole('button', { name, exact: true });
    await tab('Overview').waitFor();

    // Agents: one row per registered/refused agent, model = binding.
    await org.getByText('Registered agent bindings', { exact: false }).click();
    await org.getByRole('heading', { name: 'Registered agents' }).waitFor();
    await org.getByText(`${roster.counts.registered} registered · ${roster.counts.refused} refused · ${roster.counts.unavailable} unavailable`).waitFor();
    const architect = roster.agents.find(a => a.agentId === 'specialist-architect');
    const row = org.getByRole('row', { name: new RegExp(`^${architect.name} ${architect.status}`) });
    assert.match(await row.innerText(), new RegExp(`specialist-architect[\\s\\S]*${architect.status.toUpperCase()}[\\s\\S]*${architect.model ?? 'none'}`));
    assert.equal(await org.getByRole('region', { name: 'Registered agents' }).getByRole('row').count(), roster.agents.length + 1);
    await page.screenshot({ path: `${out}/organization-agents.png`, fullPage: true });

    // Council: every meeting listed with its mode; the LIVE one opens with its model, record, workflow run and trace.
    await tab('Collaboration').click();
    await org.getByRole('navigation', { name: 'Collaboration views' }).getByRole('button', { name: 'Council', exact: true }).click();
    const list = org.getByRole('navigation', { name: 'Meetings' });
    for (const m of council.meetings) await list.getByRole('button', { name: `${m.council ? `[${m.council.mode}] ` : '[UNVERIFIED] '}${m.title}` }).waitFor();
    if (live) {
      await list.getByRole('button', { name: `[LIVE] ${live.title}` }).click();
      const inspector = org.getByRole('region', { name: 'Meeting inspector' });
      await inspector.getByText(`Replies were produced by the local model ${live.council.model}`).waitFor();
      for (const run of live.council.workflowRuns) assert.equal(await inspector.getByRole('link', { name: `Mastra workflow run ${run.runId}` }).getAttribute('href'), run.url);
      for (const trace of live.council.traceIds) await inspector.getByText(trace, { exact: false }).first().waitFor();
      await inspector.getByText(live.council.recordPath).waitFor();
      await inspector.getByText(/Council record intact and covering exactly the verified events/).waitFor();
      assert.ok(await inspector.getByText(/^PROPOSAL · /).count() >= 3, 'independent proposals are shown');
      assert.ok(await inspector.getByText(/^OBJECTION · /).count() >= 1, 'objections are shown');
      await inspector.getByText(/grants no authority/).first().waitFor();
      await page.screenshot({ path: `${out}/organization-council-live.png`, fullPage: true });
    }
    if (scripted) {
      await list.getByRole('button', { name: `[SCRIPTED] ${scripted.title}` }).click();
      await org.getByRole('region', { name: 'Meeting inspector' }).getByText(/Canned replies \(scripted\/scripted-council-1\): this proves wiring and rules, not model output/).waitFor();
      await page.screenshot({ path: `${out}/organization-council-scripted.png`, fullPage: true });
    }

    // Existing M8.4/M9 views are still there and still read the scheduler.
    await org.getByRole('navigation', { name: 'Collaboration views' }).getByRole('button', { name: 'Meetings', exact: true }).click();
    await org.getByRole('navigation', { name: 'Meetings' }).waitFor();
    await tab('Overview').click();
    await org.getByRole('heading', { name: 'Execution lanes by provider', exact: false }).waitFor();
    assert.deepEqual(errors, []);
  });

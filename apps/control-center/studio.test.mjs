import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const origin = process.env.STUDIO_TEST_ORIGIN ?? 'http://127.0.0.1:4111';
const parsed = new URL(origin);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Local Studio required');

test('actual Studio: Organization sidebar, refresh, same-origin Gateway/SSE and existing navigation',
  { skip: !process.env.CHROME_EXECUTABLE && 'Set CHROME_EXECUTABLE', timeout: 90000 }, async t => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => requests.push({ method: req.method(), url: req.url() }));
    // Verification never authorizes model execution, including from upstream UI.
    await page.route('**/*', route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== origin || !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.abort();
      return route.continue();
    });
    const out = fileURLToPath(new URL('../../.workdir/control-center/studio-screenshots/', import.meta.url));
    mkdirSync(out, { recursive: true });
    await page.goto(origin);
    await page.getByRole('link', { name: 'Organization', exact: true }).first().click();
    await page.waitForURL('**/organization');
    const workspace = page.frameLocator('iframe[title="Organization workspace"]');
    await workspace.getByRole('heading', { name: 'Execution lanes by provider', exact: false }).waitFor();
    // No batch in scope: no lanes and no assumed identities, rather than a static roster.
    await workspace.getByText('No persisted execution lanes in scope.', { exact: false }).waitFor();
    assert.equal(await workspace.getByText('Claude Engineering Lead', { exact: false }).count(), 0);
    await workspace.getByLabel('Verifier role').waitFor();
    assert.ok((await workspace.locator('main').innerText()).includes('UNKNOWN'));
    await page.screenshot({ path: `${out}/studio-organization.png`, fullPage: true });
    await page.reload();
    await workspace.getByRole('heading', { name: 'Execution lanes by provider', exact: false }).waitFor();
    // The UI must show exactly what the Gateway reads from Core B's store: records when present, NOT AVAILABLE otherwise.
    const collab = await (await fetch(`${origin}/control-center/v1/collaboration`)).json();
    await workspace.getByRole('button', { name: 'Collaboration', exact: true }).click();
    await workspace.getByRole('button', { name: 'Discussions', exact: true }).click();
    if (collab.availability === 'AVAILABLE' && collab.threads.length) {
      const thread = collab.threads[0];
      const transcript = workspace.getByRole('region', { name: 'Discussion transcript' });
      await transcript.waitFor();
      assert.equal(await transcript.locator('.message').count(), thread.messages.length);
      for (const m of thread.messages) assert.ok((await transcript.innerText()).includes(`Event #${m.seq}`), `message ${m.id} shows its persisted seq`);
      if (thread.synthetic) await workspace.getByText('DETERMINISTIC FAKE PARTICIPANTS', { exact: false }).waitFor();
      await page.screenshot({ path: `${out}/studio-discussions.png`, fullPage: true });
      await workspace.getByRole('button', { name: 'Meetings', exact: true }).click();
      const inspector = workspace.getByRole('region', { name: 'Meeting inspector' });
      await inspector.waitFor();
      const text = await inspector.innerText();
      const meeting = collab.meetings[0];
      for (const d of meeting.decisions) assert.ok(text.includes(d.text), 'decision record shown verbatim');
      for (const o of meeting.objections) assert.ok(text.includes(`${o.status} · ${o.text}`), 'objection shown with its recorded status');
      if (meeting.provenance) assert.ok(text.includes(`Record covers events through #${meeting.provenance.throughSeq}`) && text.includes(meeting.provenance.recordHash.slice(0, 16)));
      await page.screenshot({ path: `${out}/studio-meetings.png`, fullPage: true });
    } else if (collab.availability === 'AVAILABLE') {
      // An authoritative store with no persisted discussions: say so, never fill it.
      await workspace.getByText('No reported threads.', { exact: true }).waitFor();
      if (collab.reason) await workspace.getByText(collab.reason, { exact: true }).waitFor();
      assert.equal(await workspace.locator('.message').count(), 0);
      await page.screenshot({ path: `${out}/studio-discussions-empty.png`, fullPage: true });
      await workspace.getByRole('button', { name: 'Meetings', exact: true }).click();
      await workspace.getByText('No reported meetings.', { exact: true }).waitFor();
    } else {
      await workspace.getByText(collab.availability === 'CORRUPT' ? 'INTEGRITY FAILURE' : 'NOT AVAILABLE', { exact: true }).waitFor();
      await page.screenshot({ path: `${out}/studio-discussions-unavailable.png`, fullPage: true });
      await workspace.getByRole('button', { name: 'Meetings', exact: true }).click();
    }
    await workspace.getByRole('button', { name: 'Usage', exact: true }).click();
    await workspace.getByRole('heading', { name: 'Scope usage', exact: true }).waitFor();
    for (const path of ['/agents', '/workflows', '/traces']) {
      await page.goto(`${origin}${path}`);
      await page.getByRole('link', { name: 'Organization', exact: true }).first().waitFor();
      await page.waitForTimeout(500);
      assert.equal(await page.getByText('Failed to load studio', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Unexpected Application Error!', { exact: false }).count(), 0);
      await page.screenshot({ path: `${out}/studio-${path.slice(1)}.png`, fullPage: true });
    }
    const response = await fetch(`${origin}/control-center/v1/snapshot`);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.contractVersion ?? snapshot.version, 'agentic.control-center/1');
    assert.equal((await fetch(`${origin}/control-center/v1/collaboration`)).status, 200);
    const abort = new AbortController();
    const stream = await fetch(`${origin}/control-center/v1/events`, { signal: abort.signal });
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    let wire = '';
    while (!wire.includes('event: snapshot') && !wire.includes('event: connection')) {
      const chunk = await reader.read(); if (chunk.done) break;
      wire += new TextDecoder().decode(chunk.value);
    }
    abort.abort();
    assert.match(wire, /event: (snapshot|connection)/);
    assert.equal(requests.some(r => new URL(r.url).port === '4310'), false);
    assert.deepEqual(errors, []);
    writeFileSync(`${out}/verification.json`, JSON.stringify({ origin, verifiedAt: new Date().toISOString(), source: snapshot.source, errors, requests: requests.filter(r => new URL(r.url).origin === origin), requiredPortVerified: parsed.port === '4111' }, null, 2));
  });

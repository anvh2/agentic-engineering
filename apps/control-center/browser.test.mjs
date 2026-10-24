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
    await page.getByText('Records exist in this scope, but none match the current filters.', { exact: false }).waitFor();
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
    // Recorded worker invocations: run/worker/provider/model identity and reported counts; attempt 2 reported none.
    f.store.db.prepare("UPDATE tasks SET artifacts=json_set(artifacts, '$.modelCalls', json(?)) WHERE id='task-a'").run(JSON.stringify([
      { runId: 'synthetic-run-a', workerId: 'worker-1', attempt: 1, provider: 'ollama', model: 'qwen-test', startedAt: Date.now() - 5000, inferenceMs: 1200, inputTokens: 321, outputTokens: 45, usageSupport: 'tokens' },
      { runId: 'synthetic-run-a', workerId: 'worker-1', attempt: 2, provider: 'ollama', model: 'qwen-test', startedAt: Date.now() - 2000, inferenceMs: 800, inputTokens: null, outputTokens: null, usageSupport: 'tokens' },
    ]));
    f.store.audit('task-a', 'test', 'telemetry seeded');
    await page.getByText('PARTIAL', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Implement scoped parser', exact: true }).first().click();
    const invocations = page.getByRole('table', { name: 'Recorded worker invocations' });
    await invocations.waitFor();
    assert.equal(await invocations.locator('tbody tr').count(), 2);
    const recorded = await invocations.innerText();
    for (const value of ['synthetic-run-a', 'worker-1', 'ollama · qwen-test', '321', '45', 'NOT REPORTED']) assert.ok(recorded.includes(value), value);
    await page.getByText('Task total is PARTIAL', { exact: false }).waitFor();
    assert.ok((await page.getByRole('complementary').innerText()).includes('NO ACTIVE RUN · see recorded invocations'), 'current model is not claimed unrecorded when invocations record it');
    await page.screenshot({ path: `${output}/organization-invocations-fixture.png`, fullPage: true });
    await page.getByRole('button', { name: 'Close inspector' }).click();
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
        // The reader takes a scope ({ project, objectiveId }) or, from older callers, a bare objective id.
        if ((typeof id === 'string' ? id : id?.objectiveId) === 'B1') {
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

test('shared scope: URL-restored project and objective, all objectives of a project, unattributed records and exact aggregation',
  { skip: !process.env.CHROME_EXECUTABLE && 'Set CHROME_EXECUTABLE' }, async t => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { collabHarness, openMeeting } = await import('../../src/runtime/collaboration/__testing__/harness.ts');
    const { plan, workerTask } = await import('../../src/runtime/scheduler/test-helpers.ts');
    const { createReader } = await import('../../src/integrations/control-center/adapter.ts');
    const { createCollaborationReader } = await import('../../src/integrations/control-center/collaboration-adapter.ts');
    const directory = mkdtempSync(join(tmpdir(), 'cc-scope-'));
    const dbPath = join(directory, 'scheduler.db');
    const h = collabHarness({ path: dbPath });
    h.scheduler.createBatch(plan('/repo', [workerTask('a1-task', { title: 'Alpha one' })], { batchId: 'A1', project: 'alpha' }));
    h.scheduler.createBatch(plan('/repo', [workerTask('a2-task', { title: 'Alpha two' })], { batchId: 'A2', project: 'alpha' }));
    h.scheduler.createBatch(plan('/repo', [workerTask('b-task', { title: 'Beta task' })], { batchId: 'B1', project: 'beta' }));
    openMeeting(h.store, { threadId: 't-alpha', sessionId: 's-alpha', refs: { batchId: 'A1' } });
    openMeeting(h.store, { threadId: 't-label', sessionId: 's-label', refs: { objectiveId: 'ALPHA' } });
    const calls = (runId, input, output) => JSON.stringify([{ runId, workerId: 'worker-1', attempt: 1, provider: 'ollama', model: 'qwen-test', startedAt: Date.now() - 1000, inferenceMs: 10, inputTokens: input, outputTokens: output, usageSupport: 'tokens' }]);
    const seed = h.scheduler.db.prepare("UPDATE tasks SET run_ids=?, artifacts=json_set(artifacts, '$.modelCalls', json(?)) WHERE id=?");
    seed.run('["r-a1"]', calls('r-a1', 100, 10), 'a1-task');
    seed.run('["r-a2"]', calls('r-a2', 23, 3), 'a2-task');
    seed.run('["r-b"]', calls('r-b', 5000, 5000), 'b-task');
    h.scheduler.close();
    const gateway = createGateway({ reader: createReader({ dbPath }), collaboration: createCollaborationReader({ dbPath, schedulerOfRecord: true }), assetsDir: fileURLToPath(new URL('./dist/', import.meta.url)), pollMs: 100 });
    gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
    t.after(async () => { await browser.close(); gateway.closeStreams(); gateway.server.closeAllConnections(); await new Promise(r => gateway.server.close(r)); rmSync(directory, { recursive: true, force: true }); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const project = page.getByLabel('Project', { exact: true });
    const objective = page.getByLabel('Objective / scheduler batch', { exact: true });
    const task = name => page.getByRole('button', { name, exact: true });

    // A shared link opens the section, scope and filter it names; "all objectives" covers every batch of the project.
    await page.goto(`http://127.0.0.1:${gateway.server.address().port}/?section=runs&project=alpha&status=BACKLOG`);
    await task('Alpha one').waitFor();
    await task('Alpha two').waitFor();
    assert.equal(await task('Beta task').count(), 0, 'another project is never included');
    assert.deepEqual([await project.inputValue(), await objective.inputValue(), await page.getByLabel('Task status', { exact: true }).inputValue()], ['alpha', '', 'BACKLOG']);
    // Narrowing to one objective is a history entry: Back restores all objectives.
    await objective.selectOption('A1');
    await task('Alpha two').waitFor({ state: 'detached' });
    assert.match(page.url(), /objective=A1/);
    await page.reload();
    await task('Alpha one').waitFor();
    assert.equal(await objective.inputValue(), 'A1', 'reload restores the scope from the URL');
    await page.goBack();
    await task('Alpha two').waitFor();
    assert.equal(await objective.inputValue(), '');

    // Usage over all objectives of the project is the exact sum of its batches, never another project's.
    await page.getByRole('button', { name: 'Usage', exact: true }).click();
    const usage = page.locator('.usage-panel');
    await usage.getByText('123', { exact: true }).waitFor();
    await usage.getByText('13', { exact: true }).waitFor();
    assert.equal(await usage.getByText('5,123', { exact: true }).count(), 0);
    assert.match(page.url(), /section=usage/);

    // Collaboration: only the record whose persisted reference resolves to the project; the label-only one is not assigned.
    await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
    const threads = page.getByRole('navigation', { name: 'Discussion threads' });
    await page.getByText('project alpha · batch A1 (persisted reference)', { exact: false }).waitFor();
    assert.equal(await threads.getByRole('button').count(), 1);
    await page.getByText('2 unattributed records in this source are not assigned to the selected scope', { exact: false }).waitFor();
    await project.selectOption('__unattributed');
    assert.match(page.url(), /scope=unattributed/);
    await page.getByText('Only an unverified objective label (ALPHA)', { exact: false }).waitFor();
    assert.equal(await threads.getByRole('button').count(), 1);
    assert.equal(await objective.isDisabled(), true, 'the Unattributed scope has no objective');
    await page.goBack();
    await page.getByText('project alpha · batch A1 (persisted reference)', { exact: false }).waitFor();
    assert.equal(await project.inputValue(), 'alpha');
    assert.deepEqual(errors, []);
  });

test('suggested meetings: runtime records labelled NOT MEETINGS, scoped, decided, polled, read-only, integrity failure and disconnect',
  { skip: !process.env.CHROME_EXECUTABLE && 'Set CHROME_EXECUTABLE', timeout: 120000 }, async t => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { DatabaseSync } = await import('node:sqlite');
    const { collabHarness, openMeeting } = await import('../../src/runtime/collaboration/__testing__/harness.ts');
    const { plan, workerTask } = await import('../../src/runtime/scheduler/test-helpers.ts');
    const { LifecycleStore } = await import('../../src/lead/lifecycle/store.ts');
    const { suggestForDeadTasks, decideSuggestion } = await import('../../src/lead/collaboration/suggestions.ts');
    const { ENGINEERING_LEAD_ID } = await import('../../src/lead/collaboration/roster.ts');
    const { createReader } = await import('../../src/integrations/control-center/adapter.ts');
    const { createCollaborationReader } = await import('../../src/integrations/control-center/collaboration-adapter.ts');
    const { createSuggestionReader } = await import('../../src/integrations/control-center/suggestions-adapter.ts');
    const directory = mkdtempSync(join(tmpdir(), 'cc-suggest-'));
    const dbPath = join(directory, 'scheduler.db');
    const oracle = { dir: '/o', files: {}, commands: [['true']], negativeControl: { mode: 'required' }, specHash: 'h', pinnedAt: 1, pinnedBy: 'lead' };
    const escalate = (db, id, category, reason) => db.prepare("UPDATE tasks SET state = 'ESCALATED', failure_category = ?, state_reason = ? WHERE id = ?").run(category, reason, id);
    // The records are produced by the runtime's own code: a pinned objective in alpha, an unpinned objective label in beta.
    const h = collabHarness({ path: dbPath });
    h.scheduler.createBatch(plan('/repo', ['a1-pad', 'a1-code', 'a1-sec', 'a1-merge'].map(id => workerTask(id)), { batchId: 'A1', project: 'alpha' }));
    h.scheduler.createBatch(plan('/repo', [workerTask('b-int')], { batchId: 'B1', project: 'beta' }));
    new LifecycleStore(h.scheduler).create({ objectiveId: 'OBJ-A', batchId: 'A1', baseCommit: 'b', actor: 'lead', oracle });
    escalate(h.scheduler.db, 'a1-pad', 'review_rejected', 'finding:comment_removed');
    escalate(h.scheduler.db, 'a1-code', 'coding_attempts_exhausted', 'three attempts failed verification');
    escalate(h.scheduler.db, 'a1-sec', 'forbidden_mutation', 'edited go.mod outside scope');
    escalate(h.scheduler.db, 'b-int', 'integration_conflict', 'conflict in parser.go');
    const tasks = ids => ids.map(id => h.scheduler.requireTask(id));
    const a = suggestForDeadTasks(h.scheduler, { objectiveId: 'OBJ-A', batchId: 'A1', tasks: tasks(['a1-pad', 'a1-code', 'a1-sec']), actor: 'lifecycle-driver' });
    assert.deepEqual(a.created.map(s => s.refs.taskId), ['a1-pad', 'a1-code'], 'a security stop is never suggested');
    const [b] = suggestForDeadTasks(h.scheduler, { objectiveId: 'OBJ-B', batchId: 'B1', tasks: tasks(['b-int']), actor: 'lifecycle-driver' }).created;
    decideSuggestion(h.scheduler, a.created[1].id, { status: 'accepted', by: ENGINEERING_LEAD_ID, sessionId: 'm-accepted' });
    decideSuggestion(h.scheduler, b.id, { status: 'dismissed', by: 'anvh2', reason: 'already re-planned' });
    openMeeting(h.store, { threadId: 't-alpha', sessionId: 's-alpha', refs: { batchId: 'A1' } });
    h.scheduler.close();

    const gateway = createGateway({ reader: createReader({ dbPath }), collaboration: createCollaborationReader({ dbPath, schedulerOfRecord: true }), suggestions: createSuggestionReader({ dbPath }), assetsDir: fileURLToPath(new URL('./dist/', import.meta.url)), pollMs: 100 });
    gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
    t.after(async () => { await browser.close(); gateway.closeStreams(); gateway.server.closeAllConnections(); await new Promise(r => gateway.server.close(r)); rmSync(directory, { recursive: true, force: true }); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const mutations = [];
    page.on('request', req => { if (req.method() !== 'GET') mutations.push(`${req.method()} ${req.url()}`); });
    const panel = page.getByRole('region', { name: 'Suggested meetings' });
    const rows = panel.locator('.suggestion-list > li');

    await page.goto(`http://127.0.0.1:${gateway.server.address().port}/?section=collaboration&collab=meetings`);
    await panel.getByText('NOT MEETINGS', { exact: true }).waitFor();
    await panel.getByText('1 PENDING IN THIS SCOPE', { exact: true }).waitFor();
    assert.equal(await rows.count(), 3, 'pending + accepted + dismissed; the security stop is absent');
    // Pending first, with the runtime's own reason, verified references, proposed (not invited) participants and evidence.
    const pending = await rows.nth(0).innerText();
    assert.match(pending, /PENDING · NOT A MEETING/);
    assert.match(pending, new RegExp(`Review escalation · ${a.created[0].id}`));
    assert.match(pending, /a1-pad is ESCALATED \[review_rejected\]: finding:comment_removed/);
    assert.match(pending, /Scope: project alpha · batch A1 · task a1-pad · objective OBJ-A/);
    assert.match(pending, new RegExp(`Proposed participants: ${ENGINEERING_LEAD_ID} \\(engineering_lead\\).*reviewer \\(reviewer\\)`));
    assert.match(pending, /Evidence: task a1-pad: ESCALATED \[review_rejected\]/);
    const decided = (await rows.nth(1).innerText()) + (await rows.nth(2).innerText());
    assert.match(decided, new RegExp(`Accepted by ${ENGINEERING_LEAD_ID} · meeting m-accepted`));
    assert.match(decided, /Dismissed by anvh2: already re-planned/);
    assert.doesNotMatch(decided, /objective OBJ-B/, 'an objective label without a pinned lifecycle is not shown as verified');
    assert.equal(await panel.getByText('a1-sec', { exact: false }).count(), 0);
    // Suggestions are never meetings: the meetings list holds the one real meeting and no suggestion id.
    const meetingList = await page.getByRole('navigation', { name: 'Meetings' }).innerText();
    assert.doesNotMatch(meetingList, /sg-/);
    // The panel wraps its ids, reasons and evidence at tablet and phone widths (unscoped: the M13 scope bar is checked elsewhere).
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 960 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 960 });

    // Shared scope: another project shows only its own (decided) suggestion; the pending count is per scope.
    await page.getByLabel('Project', { exact: true }).selectOption('beta');
    await panel.getByText('0 PENDING IN THIS SCOPE', { exact: true }).waitFor();
    assert.equal(await rows.count(), 1);
    assert.match(await rows.nth(0).innerText(), /DISMISSED/);
    await page.getByLabel('Project', { exact: true }).selectOption('alpha');
    await panel.getByText('1 PENDING IN THIS SCOPE', { exact: true }).waitFor();
    assert.equal(await rows.count(), 2);

    // A suggestion the lifecycle records while the page is open appears on the next poll.
    const live = collabHarness({ path: dbPath });
    escalate(live.scheduler.db, 'a1-merge', 'integration_verification_failed', 'tests fail after merge');
    suggestForDeadTasks(live.scheduler, { objectiveId: 'OBJ-A', batchId: 'A1', tasks: [live.scheduler.requireTask('a1-merge')], actor: 'lifecycle-driver' });
    live.scheduler.close();
    await panel.getByText('2 PENDING IN THIS SCOPE', { exact: true }).waitFor({ timeout: 15000 });
    assert.match(await panel.innerText(), /Integration failure/);

    assert.deepEqual(mutations, [], 'the console only reads');

    // The rows are not shown as fixed runtime records once the table's guard is gone.
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TRIGGER meeting_suggestions_no_delete');
    raw.close();
    await page.reload();
    await panel.getByText('INTEGRITY FAILURE', { exact: true }).waitFor();
    assert.match(await panel.innerText(), /meeting_suggestions guard missing/);
    assert.equal(await rows.count(), 0);
    // An unreachable endpoint is reported, never shown as "no suggestions".
    await page.route('**/meeting-suggestions', route => route.abort());
    await page.reload();
    await page.getByText('Meeting suggestions unavailable. Retrying automatically.', { exact: true }).waitFor();
    assert.equal(await panel.count(), 0);
    assert.deepEqual(errors, []);
  });

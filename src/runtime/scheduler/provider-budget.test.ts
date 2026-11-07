import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Scheduler } from './scheduler.ts';
import { SchedulerStore } from './store.ts';
import { fakeExecutor, makeRepo, plan, tempDir, workerTask } from './test-helpers.ts';
import { WorktreeManager } from '../worktree/worktree.ts';
import type { ProviderDescriptor } from '../execution/worker-provider.ts';
import type { ProviderBudgetEntry, RoutingDecision } from '../execution/provider-routing.ts';

/** A registered provider that bills by quota (like a cloud coding CLI). */
const PAID: ProviderDescriptor = {
  identity: { id: 'paidcli', kind: 'cloud', model: 'paid-model' },
  capabilities: { taskTypes: ['go', 'js'], editsFiles: 'directly', fileScope: 'os-sandbox', cancellation: 'process-group', usage: 'tokens', billing: 'subscription-quota' },
  capacity: { resource: 'paidcli', defaultPermits: 1 },
  limits: { maxRuntimeRetries: 0, maxCodingAttempts: 2 },
};
/** The free local default, as a production registry describes it. */
const LOCAL: ProviderDescriptor = {
  identity: { id: 'ollama', kind: 'local', model: 'qwen3:8b' },
  capabilities: { taskTypes: ['go', 'js'], editsFiles: 'via-runtime-tools', fileScope: 'tool-enforced', cancellation: 'abort-signal', usage: 'tokens', billing: 'local-free' },
  capacity: { resource: 'ollama', defaultPermits: 1 },
};
const describeProvider = (id: string) => ({ paidcli: PAID, ollama: LOCAL })[id];

const paidTask = (id: string) => {
  const spec = workerTask(id);
  (spec.request as { provider?: string }).provider = 'paidcli';
  return spec;
};

function setup(tasks: ReturnType<typeof workerTask>[], deps: { allow?: string[]; budgets?: ProviderBudgetEntry[]; dbPath?: string } = {}) {
  const dbPath = deps.dbPath ?? join(tempDir('sched-budget-'), 'sched.db');
  const store = new SchedulerStore(dbPath);
  if (tasks.length) {
    store.createBatch(plan(makeRepo(), tasks));
    store.promote();
  }
  const executor = fakeExecutor();
  const scheduler = new Scheduler({
    store,
    executor,
    workspace: new WorktreeManager(join(tempDir('sched-budget-wt-'), 'worktrees')),
    config: { pollMs: 20 },
    allowProviders: deps.allow ?? ['paidcli'],
    providerBudgets: deps.budgets ?? [],
    describeProvider,
  });
  return { dbPath, store, executor, scheduler };
}

const routingOf = (store: SchedulerStore, id: string) => store.requireTask(id).artifacts.routing as RoutingDecision;

describe('M12 provider routing at claim time', () => {
  it('an allow-listed paid provider without an operator budget is refused before any worktree or executor, and nothing falls back', async () => {
    const { store, executor, scheduler } = setup([paidTask('a')], { budgets: [] });
    await scheduler.run();
    const task = store.requireTask('a');
    assert.equal(task.state, 'RUNTIME_FAILURE');
    assert.equal(task.failureCategory, 'provider_not_authorized');
    assert.match(task.stateReason ?? '', /^budget_not_approved: .*no fallback provider is tried$/);
    assert.deepEqual(executor.calls, [], 'the executor (and so any model) was never called');
    assert.equal(task.worktreePath, null, 'no worktree was prepared');
    assert.deepEqual(store.routingDecisions('a').map((r) => [r.decision.outcome, r.decision.code, r.decision.charged]), [['refused', 'budget_not_approved', false]]);
    assert.ok(!store.events('a').some((e) => e.reason?.startsWith('provider_')), 'routing never enters the event trajectory');
    assert.equal(routingOf(store, 'a').provider, 'paidcli');
  });

  it('a provider-wide budget of 1 runs exactly one task; the next is refused as exhausted and charged nothing', async () => {
    const { store, executor, scheduler } = setup([paidTask('a'), paidTask('b')], { budgets: [{ provider: 'paidcli', claims: 1 }] });
    await scheduler.run();
    assert.equal(executor.calls.length, 1);
    const ran = executor.calls[0];
    const other = ran === 'a' ? 'b' : 'a';
    assert.equal(store.requireTask(ran).state, 'REVIEW_PENDING');
    assert.deepEqual([routingOf(store, ran).code, routingOf(store, ran).charged], ['authorized_within_budget', true]);
    assert.equal(store.requireTask(other).state, 'RUNTIME_FAILURE');
    assert.deepEqual([routingOf(store, other).code, routingOf(store, other).charged], ['budget_exhausted', false]);
    assert.deepEqual(store.chargedProviderClaims('paidcli', ran), { provider: 1, task: 1 });
  });

  it('the spend is durable: a restarted scheduler on the same database sees the claim already charged', async () => {
    const first = setup([paidTask('a')], { budgets: [{ provider: 'paidcli', claims: 1 }] });
    await first.scheduler.run();
    assert.equal(first.store.requireTask('a').state, 'REVIEW_PENDING');
    first.store.createBatch(plan(makeRepo(), [paidTask('b')], { batchId: 'B2' }));
    first.store.promote();
    first.store.close();

    const restarted = setup([], { budgets: [{ provider: 'paidcli', claims: 1 }], dbPath: first.dbPath });
    await restarted.scheduler.run();
    assert.deepEqual(restarted.executor.calls, []);
    assert.equal(routingOf(restarted.store, 'b').code, 'budget_exhausted');
  });

  it('two schedulers on separate connections to one database never both take the last claim', async () => {
    const a = setup([paidTask('a'), paidTask('b'), paidTask('c')], { budgets: [{ provider: 'paidcli', claims: 1 }] });
    const b = setup([], { budgets: [{ provider: 'paidcli', claims: 1 }], dbPath: a.dbPath });
    await Promise.all([a.scheduler.run(), b.scheduler.run()]);
    assert.equal(a.executor.calls.length + b.executor.calls.length, 1);
    const charged = ['a', 'b', 'c'].filter((id) => routingOf(a.store, id).charged);
    assert.equal(charged.length, 1);
    assert.equal(a.store.chargedProviderClaims('paidcli', charged[0]).provider, 1);
  });

  it('every claim on the default local provider records its selection and spends nothing', async () => {
    const { store, scheduler } = setup([workerTask('local')], { allow: [] });
    await scheduler.run();
    const r = routingOf(store, 'local');
    assert.deepEqual([r.outcome, r.provider, r.code, r.charged, r.billing], ['selected', 'ollama', 'local_default', false, 'local-free']);
    assert.deepEqual(store.chargedProviderClaims('ollama', 'local'), { provider: 0, task: 0 });
  });

  it('a provider the scheduler cannot describe is refused as unknown, even when allow-listed and budgeted', async () => {
    const spec = workerTask('x');
    (spec.request as { provider?: string }).provider = 'mystery';
    const { store, executor, scheduler } = setup([spec], { allow: ['mystery'], budgets: [{ provider: 'mystery', claims: 5 }] });
    await scheduler.run();
    assert.deepEqual(executor.calls, []);
    assert.equal(store.requireTask('x').failureCategory, 'provider_unavailable');
    assert.equal(routingOf(store, 'x').code, 'unknown_provider');
  });
});

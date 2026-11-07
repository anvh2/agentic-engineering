import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideRoute, MAX_BUDGET_CLAIMS, parseProviderBudgets, ProviderBudgetError, PROVIDER_BUDGETS_ENV, providerBudgetsFromEnv, type RoutingInput } from './provider-routing.ts';
import type { ProviderDescriptor } from './worker-provider.ts';

const descriptor = (id: string, billing: ProviderDescriptor['capabilities']['billing'], taskTypes: ('go' | 'js')[] = ['go', 'js'], kind: 'local' | 'cloud' = 'cloud'): ProviderDescriptor => ({
  identity: { id, kind, model: `${id}-model` },
  capabilities: { taskTypes, editsFiles: 'directly', fileScope: 'os-sandbox', cancellation: 'process-group', usage: 'tokens', billing },
  capacity: { resource: id, defaultPermits: 1 },
});

const input = (overrides: Partial<RoutingInput> = {}): RoutingInput => ({
  taskId: 'T',
  language: 'go',
  requested: 'codex',
  descriptor: descriptor('codex', 'unknown'),
  allow: ['codex:T'],
  budgets: [{ provider: 'codex', taskId: 'T', claims: 1 }],
  spent: { provider: 0, task: 0 },
  ...overrides,
});

describe('parseProviderBudgets', () => {
  it('parses provider-wide and task-scoped entries, with surrounding whitespace', () => {
    assert.deepEqual(parseProviderBudgets(' codex=2 , gemini:m12.t1=1 '), [{ provider: 'codex', claims: 2 }, { provider: 'gemini', taskId: 'm12.t1', claims: 1 }]);
    assert.deepEqual(parseProviderBudgets(''), []);
    assert.deepEqual(parseProviderBudgets(undefined), []);
    assert.deepEqual(providerBudgetsFromEnv({ [PROVIDER_BUDGETS_ENV]: 'codex=0' }), [{ provider: 'codex', claims: 0 }]);
  });

  it('refuses malformed, duplicate and oversized entries instead of half-applying them', () => {
    for (const bad of ['codex', 'codex=', 'codex=-1', 'codex=+1', 'codex=1.5', 'Codex=1', 'codex:=1', 'codex:a b=1', 'codex=1,,gemini=1', 'codex=1,codex=2', 'codex:T=1,codex:T=1', `codex=${MAX_BUDGET_CLAIMS + 1}`]) {
      assert.throws(() => parseProviderBudgets(bad), ProviderBudgetError, bad);
    }
  });
});

describe('decideRoute', () => {
  it('the default local provider is selected without any operator entry and charges nothing', () => {
    const d = decideRoute(input({ requested: undefined, descriptor: descriptor('ollama', 'local-free', ['go', 'js'], 'local'), allow: [], budgets: [] }));
    assert.equal(d.outcome, 'selected');
    assert.equal(d.provider, 'ollama');
    assert.equal(d.code, 'local_default');
    assert.equal(d.charged, false);
    assert.deepEqual(d.checks.map((c) => [c.check, c.ok]), [['provider_known', true], ['language_supported', true], ['operator_authorized', true], ['budget', true]]);
  });

  it('a paid provider needs the allow-list AND a budget; the allow-list alone is refused', () => {
    const d = decideRoute(input({ budgets: [] }));
    assert.equal(d.outcome, 'refused');
    assert.equal(d.code, 'budget_not_approved');
    assert.equal(d.charged, false);
    assert.match(d.reason, /AGENTIC_PROVIDER_BUDGETS=codex:T=1/);
    assert.match(d.reason, /no fallback provider is tried/);
  });

  it('a budget without the allow-list is refused: a budget never authorizes by itself', () => {
    const d = decideRoute(input({ allow: [] }));
    assert.equal(d.code, 'provider_not_authorized');
    assert.equal(d.charged, false);
  });

  it('unknown billing counts as paid', () => {
    assert.equal(decideRoute(input({ descriptor: descriptor('codex', 'unknown'), budgets: [] })).code, 'budget_not_approved');
    assert.equal(decideRoute(input({ descriptor: descriptor('codex', 'subscription-quota'), budgets: [] })).code, 'budget_not_approved');
    assert.equal(decideRoute(input({ descriptor: descriptor('codex', 'metered'), budgets: [] })).code, 'budget_not_approved');
  });

  it('selects within budget and charges one claim; refuses once the budget is spent', () => {
    const ok = decideRoute(input());
    assert.deepEqual([ok.outcome, ok.code, ok.charged], ['selected', 'authorized_within_budget', true]);
    assert.deepEqual(ok.budget, [{ scope: 'task', limit: 1, spentBefore: 0 }]);
    const spent = decideRoute(input({ spent: { provider: 1, task: 1 } }));
    assert.deepEqual([spent.outcome, spent.code, spent.charged], ['refused', 'budget_exhausted', false]);
  });

  it('a task-scoped budget does not cover another task, and every applicable budget must have room', () => {
    assert.equal(decideRoute(input({ taskId: 'T-fix1', allow: ['codex'] })).code, 'budget_not_approved');
    const both = input({ allow: ['codex'], budgets: [{ provider: 'codex', claims: 3 }, { provider: 'codex', taskId: 'T', claims: 1 }] });
    assert.equal(decideRoute(both).outcome, 'selected');
    assert.equal(decideRoute({ ...both, spent: { provider: 3, task: 0 } }).code, 'budget_exhausted');
    assert.equal(decideRoute({ ...both, spent: { provider: 1, task: 1 } }).code, 'budget_exhausted');
  });

  it('a zero budget is an explicit refusal, not a default', () => {
    assert.equal(decideRoute(input({ budgets: [{ provider: 'codex', claims: 0 }], allow: ['codex'] })).code, 'budget_exhausted');
  });

  it('an unregistered provider and an unsupported language are refused before authorization is considered', () => {
    const unknown = decideRoute(input({ requested: 'claude', descriptor: undefined, allow: ['claude'] }));
    assert.deepEqual([unknown.outcome, unknown.code, unknown.model], ['refused', 'unknown_provider', 'UNKNOWN']);
    const lang = decideRoute(input({ descriptor: descriptor('codex', 'unknown', ['go']), language: 'js' }));
    assert.equal(lang.code, 'language_unsupported');
    assert.deepEqual(lang.checks.map((c) => c.check), ['provider_known', 'language_supported']);
  });

  it('never selects anything but the requested provider', () => {
    for (const i of [input(), input({ budgets: [] }), input({ allow: [] }), input({ descriptor: undefined })]) {
      const d = decideRoute(i);
      assert.equal(d.provider, i.requested);
      assert.equal(d.fallback, 'none');
    }
  });
});

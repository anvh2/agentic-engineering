import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_ADAPTERS, detectLanguage, delegatableLanguage } from './language-adapters.ts';
import { languageOf, policyFor, workerAgentIdFor, DEFAULT_POLICY, JS_POLICY } from './delegation.ts';

describe('language adapter registry: fail closed and backwards compatible', () => {
  it('resolves existing Go and JavaScript routes without changing their policy', () => {
    assert.equal(languageOf(['x.go']), 'go');
    assert.equal(languageOf(['x.js']), 'js');
    assert.equal(languageOf(['x.mjs']), 'js');
    assert.equal(languageOf(['x.cjs']), 'js');
    assert.equal(workerAgentIdFor('go'), 'codingWorkerGo');
    assert.equal(workerAgentIdFor('js'), 'codingWorkerJs');
    assert.deepEqual(policyFor('go'), DEFAULT_POLICY);
    assert.deepEqual(policyFor('js'), JS_POLICY);
  });

  it('registers TS conventions without authorizing TS code execution or delegation', () => {
    assert.equal(detectLanguage(['.ts']), 'ts');
    assert.equal(detectLanguage(['.mts']), 'ts');
    assert.equal(LANGUAGE_ADAPTERS.ts.enabled, false);
    assert.deepEqual(LANGUAGE_ADAPTERS.ts.policy.allowedVerificationBinaries, []);
    assert.equal(delegatableLanguage(['.ts']), undefined);
    assert.equal(languageOf(['src/module.ts']), undefined);
  });

  it('keeps language conventions separated from the shared engineering execution contract', () => {
    for (const [id, adapter] of Object.entries(LANGUAGE_ADAPTERS)) {
      assert.equal(adapter.id, id, 'registry key must match adapter identity');
      assert.match(adapter.conventionPath, new RegExp(`^docs/engineering/languages/`));
      assert.ok(adapter.extensions.length > 0);
      assert.equal(new Set(adapter.extensions).size, adapter.extensions.length, 'extensions are unique');
      assert.ok(adapter.policy.maxAllowedFiles > 0);
      assert.ok(adapter.policy.maxAttempts > 0);
      assert.deepEqual(adapter.policy.allowedExtensions, adapter.extensions);
      if (adapter.enabled) {
        assert.ok('workerAgentId' in adapter && adapter.workerAgentId, 'enabled adapters need a real worker');
        assert.ok(adapter.policy.allowedVerificationBinaries.length > 0, 'enabled adapters need a verifier allow-list');
      } else {
        assert.equal(adapter.policy.allowedVerificationBinaries.length, 0, 'experimental adapters cannot execute verifiers');
      }
    }
    const claimedExtensions = Object.values(LANGUAGE_ADAPTERS).flatMap((a) => [...a.extensions]);
    assert.equal(new Set(claimedExtensions).size, claimedExtensions.length, 'different adapters cannot claim the same extension');
  });

  it('recognizes supported single-language variants but never authorizes disabled TypeScript', () => {
    assert.equal(detectLanguage(['.js', '.mjs', '.cjs']), 'js');
    assert.equal(delegatableLanguage(['.js', '.mjs', '.cjs']), 'js');
    assert.equal(detectLanguage(['.ts', '.mts', '.cts']), 'ts');
    assert.equal(detectLanguage(['.cts']), 'ts');
    assert.equal(delegatableLanguage(['.ts', '.mts', '.cts']), undefined);
    assert.equal(languageOf(['src/a.mts']), undefined);
    assert.equal(languageOf(['src/a.cts']), undefined);
    assert.equal(languageOf([]), undefined);
    assert.equal(languageOf(['src/a.rb']), undefined);
    assert.equal(languageOf(['src/a.ts', 'src/b.js']), undefined);
  });

  it('rejects unknown, empty and mixed ecosystems', () => {
    assert.equal(detectLanguage([]), undefined);
    assert.equal(delegatableLanguage(['.rb']), undefined);
    assert.equal(delegatableLanguage(['.go', '.ts']), undefined);
    assert.equal(delegatableLanguage(['.js', '.go']), undefined);
    assert.equal(languageOf(['src/a.go', 'src/b.js']), undefined);
  });
});

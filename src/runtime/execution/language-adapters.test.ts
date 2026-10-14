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

  it('rejects unknown, empty and mixed ecosystems', () => {
    assert.equal(detectLanguage([]), undefined);
    assert.equal(delegatableLanguage(['.rb']), undefined);
    assert.equal(delegatableLanguage(['.go', '.ts']), undefined);
    assert.equal(delegatableLanguage(['.js', '.go']), undefined);
    assert.equal(languageOf(['src/a.go', 'src/b.js']), undefined);
  });
});

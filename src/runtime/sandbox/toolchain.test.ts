import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nvmNodeVersionRoot } from './toolchain.ts';

describe('NVM toolchain scoping', () => {
  const env = { HOME: '/Users/fixture', NVM_DIR: '/Users/fixture/.nvm' };

  it('recognizes one exact Node 22 or Node 25 installation, including npm package entrypoints', () => {
    assert.equal(nvmNodeVersionRoot('/Users/fixture/.nvm/versions/node/v22.13.1/bin/node', env), '/Users/fixture/.nvm/versions/node/v22.13.1');
    assert.equal(nvmNodeVersionRoot('/Users/fixture/.nvm/versions/node/v25.2.1/lib/node_modules/npm/bin/npx-cli.js', env), '/Users/fixture/.nvm/versions/node/v25.2.1');
  });

  it('never widens to NVM_DIR, HOME, a sibling tree, or a similarly prefixed path', () => {
    for (const path of ['/Users/fixture/.nvm', '/Users/fixture', '/Users/fixture/.ssh/id_ed25519', '/Users/fixture/.nvm-other/versions/node/v25/bin/node']) {
      assert.equal(nvmNodeVersionRoot(path, env), undefined, path);
    }
  });
});

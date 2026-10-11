import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { nvmNodeVersionRoot } from './toolchain.ts';

describe('NVM toolchain scoping — string-fixture rejections (no disk access needed)', () => {
  // These must be rejected before the existsSync check, so string fixtures are fine.
  const env = { HOME: '/Users/fixture', NVM_DIR: '/Users/fixture/.nvm' };

  it('rejects paths that do not look like a valid vMAJOR.MINOR.PATCH version', () => {
    for (const path of [
      '/Users/fixture/.nvm/versions/node/evil-name/bin/node',       // no 'v' prefix, no dots
      '/Users/fixture/.nvm/versions/node/v25/bin/node',             // missing minor/patch
      '/Users/fixture/.nvm/versions/node/v25.2/bin/node',           // missing patch
      '/Users/fixture/.nvm/versions/node/v25.2.1-attacker/bin/node', // suffix after patch
      '/Users/fixture/.nvm/versions/node/../../../etc/passwd',       // dot-dot escape
      '/Users/fixture/.nvm/versions/node/./bin/node',               // dot component
    ]) {
      assert.equal(nvmNodeVersionRoot(path, env), undefined, `must reject: ${path}`);
    }
  });

  it('never widens to NVM_DIR, HOME, a sibling tree, or a similarly prefixed path', () => {
    for (const path of [
      '/Users/fixture/.nvm',
      '/Users/fixture',
      '/Users/fixture/.ssh/id_ed25519',
      '/Users/fixture/.nvm-other/versions/node/v25.2.1/bin/node',  // not under NVM_DIR
    ]) {
      assert.equal(nvmNodeVersionRoot(path, env), undefined, `must reject: ${path}`);
    }
  });
});

describe('NVM toolchain scoping — real filesystem tests', () => {
  let base: string;
  let nvmDir: string;
  let versionsNode: string;
  let realVersion: string;      // the legitimately installed version
  let siblingVersion: string;   // a second version that must not be granted when different node is used
  let escapeTarget: string;     // a directory OUTSIDE nvmDir that a symlink could point to

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'nvm-tc-test-')));
    nvmDir = join(base, '.nvm');
    versionsNode = join(nvmDir, 'versions', 'node');
    realVersion = join(versionsNode, 'v22.13.1');
    siblingVersion = join(versionsNode, 'v25.2.1');
    escapeTarget = join(base, 'escape-target');

    // Create minimal NVM layout for two versions.
    mkdirSync(join(realVersion, 'bin'), { recursive: true });
    writeFileSync(join(realVersion, 'bin', 'node'), '#!/bin/sh\necho node\n', { mode: 0o755 });
    mkdirSync(join(siblingVersion, 'bin'), { recursive: true });
    writeFileSync(join(siblingVersion, 'bin', 'node'), '#!/bin/sh\necho node\n', { mode: 0o755 });

    // A directory outside NVM that a symlink could try to escape to.
    mkdirSync(escapeTarget, { recursive: true });
    writeFileSync(join(escapeTarget, 'secret.txt'), 'escaped-content\n');
  });

  after(() => rmSync(base, { recursive: true, force: true }));

  it('recognizes the one exact installed version containing the path', () => {
    const env = { HOME: base, NVM_DIR: nvmDir };
    const result = nvmNodeVersionRoot(join(realVersion, 'bin', 'node'), env);
    assert.equal(result, realVersion, 'should return the canonical version root');
  });

  it('also handles npm package entrypoints inside a version (lib/node_modules/...)', () => {
    const env = { HOME: base, NVM_DIR: nvmDir };
    const deepPath = join(realVersion, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
    // The deep path doesn't need to exist for the string-parsing portion;
    // but existsSync(canonicalRoot) checks the version root which does exist.
    const result = nvmNodeVersionRoot(deepPath, env);
    assert.equal(result, realVersion);
  });

  it('denies a sibling version root when a different version is used', () => {
    const env = { HOME: base, NVM_DIR: nvmDir };
    // realVersion node binary → should return realVersion, not siblingVersion
    const result = nvmNodeVersionRoot(join(realVersion, 'bin', 'node'), env);
    assert.equal(result, realVersion);
    assert.notEqual(result, siblingVersion, 'sibling version must not be returned');
  });

  it('rejects a symlink inside versions/node that escapes to outside the NVM directory', () => {
    const env = { HOME: base, NVM_DIR: nvmDir };
    // Create a symlink named like a valid version but pointing outside NVM.
    const symlinkVersion = join(versionsNode, 'v99.0.0');
    symlinkSync(escapeTarget, symlinkVersion);
    try {
      const result = nvmNodeVersionRoot(join(symlinkVersion, 'bin', 'node'), env);
      // The canonical path of escapeTarget does NOT start with versions/, so it must be rejected.
      assert.equal(result, undefined, 'symlink escape outside NVM must be rejected');
    } finally {
      // Remove the symlink only (not the target); rmSync fails with EISDIR on dir-pointing symlinks.
      try { unlinkSync(symlinkVersion); } catch { /* already gone */ }
    }
  });

  it('rejects a non-existent version directory (no grants for absent paths)', () => {
    const env = { HOME: base, NVM_DIR: nvmDir };
    const absent = join(versionsNode, 'v18.0.0', 'bin', 'node');
    const result = nvmNodeVersionRoot(absent, env);
    assert.equal(result, undefined, 'absent version root must not be granted');
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { findProjectRoot } from './paths.ts';

describe('findProjectRoot', () => {
  it('finds the root by package name from a nested directory, whatever the directory is called', () => {
    const dir = mkdtempSync(join(tmpdir(), 'root-'));
    try {
      const root = join(dir, 'any-checkout-name');
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agentic-engineering' }));
      writeFileSync(join(root, 'a', 'package.json'), JSON.stringify({ name: 'something-else' }));
      assert.equal(findProjectRoot(join(root, 'a', 'b')), root);
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'harness-engineering' }));
      assert.equal(findProjectRoot(join(root, 'a', 'b')), root);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no ancestor is this project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noroot-'));
    try {
      assert.equal(findProjectRoot(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

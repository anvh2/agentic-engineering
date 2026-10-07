import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectEcosystem } from './detect-ecosystem.ts';

describe('detectEcosystem', () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'detect-ecosystem-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns undefined for a directory with neither manifest', async () => {
    assert.equal(await detectEcosystem(root), undefined);
  });

  it('returns "js" when package.json is present', async () => {
    await writeFile(join(root, 'package.json'), '{}');
    assert.equal(await detectEcosystem(root), 'js');
  });

  it('returns "go" when go.mod is present, even alongside package.json', async () => {
    await writeFile(join(root, 'go.mod'), 'module example.com/x\n\ngo 1.22\n');
    assert.equal(await detectEcosystem(root), 'go');
  });
});

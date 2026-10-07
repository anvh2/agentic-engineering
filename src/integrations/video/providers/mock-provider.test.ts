import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockVideoTransformationProvider } from './mock-provider.ts';

describe('MockVideoTransformationProvider', () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'mock-provider-'));
    await mkdir(join(root, 'frames'), { recursive: true });
    await writeFile(join(root, 'frames', 'frame-000001.png'), 'fake frame 1');
    await writeFile(join(root, 'frames', 'frame-000002.png'), 'fake frame 2');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('satisfies the VideoTransformationProvider interface and reports its name', () => {
    const provider = new MockVideoTransformationProvider();
    assert.equal(provider.name, 'mock');
    assert.equal(typeof provider.transform, 'function');
  });

  it('copies the source frames through unchanged and reports a frames-kind output', async () => {
    const provider = new MockVideoTransformationProvider();
    const workDir = join(root, 'work');
    const output = await provider.transform({
      framesDir: join(root, 'frames'),
      framePattern: 'frame-%06d.png',
      fps: 24,
      width: 512,
      height: 512,
      characterReference: join(root, 'character.jpg'),
      appearanceVariation: 'subtle',
      workDir,
    });

    assert.equal(output.kind, 'frames');
    if (output.kind !== 'frames') return;
    assert.equal(output.fps, 24);
    assert.equal(output.pattern, 'frame-%06d.png');
    const copied = await readdir(output.dir);
    assert.deepEqual(copied.sort(), ['frame-000001.png', 'frame-000002.png']);
  });
});

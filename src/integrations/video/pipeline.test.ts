import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runVideoTransformationPipeline, type PipelineDeps } from './pipeline.ts';
import { MockVideoTransformationProvider } from './providers/mock-provider.ts';
import { VideoTransformError, type VideoTransformationInput, type VideoTransformationProvider } from './types.ts';
import type { VideoProbe } from './ffmpeg.ts';

const SILENT_PROBE: VideoProbe = { durationSeconds: 5, fps: 24, width: 100, height: 100, hasAudio: false, codec: 'h264' };
const AUDIBLE_PROBE: VideoProbe = { ...SILENT_PROBE, hasAudio: true };

function fakeExtractFrames(frameCount = 2) {
  return async ({ framesDir }: { framesDir: string }) => {
    for (let i = 1; i <= frameCount; i++) {
      await writeFile(join(framesDir, `frame-${String(i).padStart(6, '0')}.png`), `frame ${i}`);
    }
  };
}

function fakeAssembleVideo() {
  return async ({ outputPath }: { outputPath: string }) => {
    await writeFile(outputPath, 'assembled video bytes');
  };
}

function baseInput(root: string, overrides: Partial<VideoTransformationInput> = {}): VideoTransformationInput {
  return {
    sourceVideo: join(root, 'source.mp4'),
    characterReference: join(root, 'character.jpg'),
    outputPath: join(root, 'out', 'result.mp4'),
    ...overrides,
  };
}

describe('runVideoTransformationPipeline', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('runs the full happy path with the mock provider and a silent source', async () => {
    root = await mkdtemp(join(tmpdir(), 'video-pipeline-'));
    const calls: string[] = [];
    const deps: Partial<PipelineDeps> = {
      validateInput: async () => {
        calls.push('validateInput');
      },
      probeVideo: async () => {
        calls.push('probeVideo');
        return SILENT_PROBE;
      },
      extractFrames: async (opts) => {
        calls.push('extractFrames');
        await fakeExtractFrames(3)(opts);
      },
      assembleVideo: async (opts) => {
        calls.push('assembleVideo');
        await fakeAssembleVideo()(opts);
      },
      muxAudio: async () => {
        calls.push('muxAudio');
        throw new Error('muxAudio should not be called for a silent source');
      },
      provider: new MockVideoTransformationProvider(),
    };

    const result = await runVideoTransformationPipeline(baseInput(root), deps);

    assert.deepEqual(calls, ['validateInput', 'probeVideo', 'extractFrames', 'assembleVideo', 'probeVideo']);
    assert.equal(result.outputPath, join(root, 'out', 'result.mp4'));
    assert.equal(await readFile(result.outputPath, 'utf8'), 'assembled video bytes');
    assert.equal(result.metadata.backend, 'mock');
    assert.equal(result.metadata.frameCount, 3);
    assert.equal(result.metadata.appearanceVariation, 'subtle');

    // Working directory is cleaned up after a successful run.
    await assert.rejects(() => stat(result.metadata.workDir));
  });

  it('defaults appearanceVariation to "subtle" and passes explicit "none" through', async () => {
    root = await mkdtemp(join(tmpdir(), 'video-pipeline-'));
    const deps: Partial<PipelineDeps> = {
      validateInput: async () => {},
      probeVideo: async () => SILENT_PROBE,
      extractFrames: fakeExtractFrames(1),
      assembleVideo: fakeAssembleVideo(),
      provider: new MockVideoTransformationProvider(),
    };

    const result = await runVideoTransformationPipeline(baseInput(root, { appearanceVariation: 'none' }), deps);
    assert.equal(result.metadata.appearanceVariation, 'none');
  });

  it('muxes the original audio back in when the source has an audio track', async () => {
    root = await mkdtemp(join(tmpdir(), 'video-pipeline-'));
    let muxCalled = false;
    const deps: Partial<PipelineDeps> = {
      validateInput: async () => {},
      probeVideo: async () => AUDIBLE_PROBE,
      extractFrames: fakeExtractFrames(1),
      assembleVideo: fakeAssembleVideo(),
      muxAudio: async ({ outputPath }) => {
        muxCalled = true;
        await writeFile(outputPath, 'muxed video bytes');
      },
      provider: new MockVideoTransformationProvider(),
    };

    const result = await runVideoTransformationPipeline(baseInput(root), deps);
    assert.ok(muxCalled);
    assert.equal(await readFile(result.outputPath, 'utf8'), 'muxed video bytes');
  });

  it('propagates a validation failure without calling later stages', async () => {
    root = await mkdtemp(join(tmpdir(), 'video-pipeline-'));
    let extractCalled = false;
    const deps: Partial<PipelineDeps> = {
      validateInput: async () => {
        throw new VideoTransformError('SOURCE_VIDEO_MISSING', 'no such video');
      },
      extractFrames: async () => {
        extractCalled = true;
      },
    };

    await assert.rejects(
      () => runVideoTransformationPipeline(baseInput(root), deps),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'SOURCE_VIDEO_MISSING',
    );
    assert.equal(extractCalled, false);
  });

  it('fails with FFMPEG_COMMAND_FAILED when frame extraction produces no frames', async () => {
    root = await mkdtemp(join(tmpdir(), 'video-pipeline-'));
    const deps: Partial<PipelineDeps> = {
      validateInput: async () => {},
      probeVideo: async () => SILENT_PROBE,
      extractFrames: async () => {
        // ffmpeg "succeeded" but wrote nothing - simulates a bad filter graph.
      },
    };

    await assert.rejects(
      () => runVideoTransformationPipeline(baseInput(root), deps),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'FFMPEG_COMMAND_FAILED',
    );
  });

  it('propagates a backend/provider failure and leaves the working directory in place for debugging', async () => {
    root = await mkdtemp(join(tmpdir(), 'video-pipeline-'));
    let capturedFramesDir = '';
    const failingProvider: VideoTransformationProvider = {
      name: 'mock',
      transform: async () => {
        throw new VideoTransformError('BACKEND_FAILED', 'backend exploded');
      },
    };
    const deps: Partial<PipelineDeps> = {
      validateInput: async () => {},
      probeVideo: async () => SILENT_PROBE,
      extractFrames: async (opts) => {
        capturedFramesDir = opts.framesDir;
        await fakeExtractFrames(1)(opts);
      },
      provider: failingProvider,
    };

    await assert.rejects(
      () => runVideoTransformationPipeline(baseInput(root), deps),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'BACKEND_FAILED',
    );

    const workDir = dirname(capturedFramesDir);
    const info = await stat(workDir);
    assert.ok(info.isDirectory(), 'workDir should still exist after a failed run');
  });

  it('creates the output directory if it does not already exist', async () => {
    root = await mkdtemp(join(tmpdir(), 'video-pipeline-'));
    const deps: Partial<PipelineDeps> = {
      validateInput: async () => {},
      probeVideo: async () => SILENT_PROBE,
      extractFrames: fakeExtractFrames(1),
      assembleVideo: fakeAssembleVideo(),
      provider: new MockVideoTransformationProvider(),
    };

    const nestedOutput = join(root, 'deep', 'nested', 'dir', 'result.mp4');
    const result = await runVideoTransformationPipeline(baseInput(root, { outputPath: nestedOutput }), deps);
    assert.equal(result.outputPath, nestedOutput);
    assert.ok((await stat(nestedOutput)).isFile());
  });
});

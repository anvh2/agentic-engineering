import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { videoTransformationWorkflow } from './video-transformation-workflow.ts';
import { pipelineRuntime, type PipelineDeps } from '../video/pipeline.ts';
import { MockVideoTransformationProvider } from '../video/providers/mock-provider.ts';
import { VideoTransformError } from '../video/types.ts';
import type { VideoProbe } from '../video/ffmpeg.ts';

/**
 * Exercises the real workflow (videoTransformationWorkflow.createRun().start(...)),
 * with pipelineRuntime.createDeps() swapped for fakes - the same "stub the
 * boundary, run the real workflow engine" approach coding-task-workflow.test.ts
 * uses for codingWorker.generate. This machine has no ffmpeg installed and
 * no ComfyUI running, so those calls must be faked for the suite to be
 * hermetic; the real ffmpeg/ComfyUI paths are covered by ffmpeg.itest.ts
 * and manual `npm run video:transform` runs (see VIDEO_TRANSFORMATION.md).
 */
describe('videoTransformationWorkflow', () => {
  let root: string;
  const originalCreateDeps = pipelineRuntime.createDeps;
  const SILENT_PROBE: VideoProbe = { durationSeconds: 4, fps: 24, width: 200, height: 100, hasAudio: false, codec: 'h264' };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'video-workflow-'));
    await writeFile(join(root, 'source.mp4'), 'fake source video');
    await writeFile(join(root, 'character.jpg'), 'fake character image');
  });

  after(async () => {
    pipelineRuntime.createDeps = originalCreateDeps;
    await rm(root, { recursive: true, force: true });
  });

  afterEach(() => {
    pipelineRuntime.createDeps = originalCreateDeps;
  });

  function fakeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
    return {
      validateInput: async () => {},
      probeVideo: async () => SILENT_PROBE,
      extractFrames: async ({ framesDir }) => {
        await writeFile(join(framesDir, 'frame-000001.png'), 'frame 1');
        await writeFile(join(framesDir, 'frame-000002.png'), 'frame 2');
      },
      assembleVideo: async ({ outputPath }) => {
        await writeFile(outputPath, 'assembled bytes');
      },
      muxAudio: async ({ outputPath }) => {
        await writeFile(outputPath, 'muxed bytes');
      },
      provider: new MockVideoTransformationProvider(),
      ...overrides,
    };
  }

  it('runs validate-input -> prepare-video -> run-video-transformation -> assemble-output end to end', async () => {
    pipelineRuntime.createDeps = () => fakeDeps();

    const run = await videoTransformationWorkflow.createRun();
    const result = await run.start({
      inputData: {
        sourceVideo: join(root, 'source.mp4'),
        characterReference: join(root, 'character.jpg'),
        outputPath: join(root, 'result.mp4'),
      },
    });

    assert.equal(result.status, 'success');
    if (result.status !== 'success') return;
    assert.equal(result.result.outputPath, join(root, 'result.mp4'));
    assert.equal(result.result.metadata.backend, 'mock');
    assert.equal(result.result.metadata.frameCount, 2);
    assert.equal(result.result.metadata.appearanceVariation, 'subtle');
    assert.ok((await stat(result.result.outputPath)).isFile());
  });

  it('fails the run when validation rejects, before any ffmpeg/provider work happens', async () => {
    let extractCalled = false;
    pipelineRuntime.createDeps = () =>
      fakeDeps({
        validateInput: async () => {
          throw new VideoTransformError('CHARACTER_IMAGE_MISSING', 'character reference not found');
        },
        extractFrames: async (opts) => {
          extractCalled = true;
          await fakeDeps().extractFrames(opts);
        },
      });

    const run = await videoTransformationWorkflow.createRun();
    const result = await run.start({
      inputData: {
        sourceVideo: join(root, 'source.mp4'),
        characterReference: join(root, 'missing.jpg'),
        outputPath: join(root, 'result2.mp4'),
      },
    });

    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.match(result.error.message, /character reference not found/);
    assert.equal(extractCalled, false);
  });

  it('propagates a backend failure as a failed run', async () => {
    pipelineRuntime.createDeps = () =>
      fakeDeps({
        provider: {
          name: 'mock',
          transform: async () => {
            throw new VideoTransformError('BACKEND_FAILED', 'mock backend refused the job');
          },
        },
      });

    const run = await videoTransformationWorkflow.createRun();
    const result = await run.start({
      inputData: {
        sourceVideo: join(root, 'source.mp4'),
        characterReference: join(root, 'character.jpg'),
        outputPath: join(root, 'result3.mp4'),
      },
    });

    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.match(result.error.message, /mock backend refused the job/);
  });

  it('respects an explicit appearanceVariation of "none"', async () => {
    pipelineRuntime.createDeps = () => fakeDeps();

    const run = await videoTransformationWorkflow.createRun();
    const result = await run.start({
      inputData: {
        sourceVideo: join(root, 'source.mp4'),
        characterReference: join(root, 'character.jpg'),
        outputPath: join(root, 'result4.mp4'),
        appearanceVariation: 'none',
      },
    });

    assert.equal(result.status, 'success');
    if (result.status !== 'success') return;
    assert.equal(result.result.metadata.appearanceVariation, 'none');
  });
});

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateInput } from './validate.ts';
import { VideoTransformError, type VideoTransformationInput } from './types.ts';

describe('validateInput', () => {
  let root: string;
  let videoPath: string;
  let characterPath: string;
  let outfitPath: string;
  const originalFfmpegBin = process.env.FFMPEG_BIN;
  const originalFfprobeBin = process.env.FFPROBE_BIN;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'video-validate-'));
    videoPath = join(root, 'source.mp4');
    characterPath = join(root, 'character.jpg');
    outfitPath = join(root, 'outfit.png');
    await writeFile(videoPath, 'not a real video, presence is all validateInput checks itself');
    await writeFile(characterPath, 'not a real image');
    await writeFile(outfitPath, 'not a real image');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Point at a binary that always succeeds so tests focus on this
    // module's own checks, not real ffmpeg presence on the test machine.
    process.env.FFMPEG_BIN = process.platform === 'win32' ? 'cmd' : 'true';
    process.env.FFPROBE_BIN = process.platform === 'win32' ? 'cmd' : 'true';
  });

  after(() => {
    if (originalFfmpegBin === undefined) delete process.env.FFMPEG_BIN;
    else process.env.FFMPEG_BIN = originalFfmpegBin;
    if (originalFfprobeBin === undefined) delete process.env.FFPROBE_BIN;
    else process.env.FFPROBE_BIN = originalFfprobeBin;
  });

  function baseInput(overrides: Partial<VideoTransformationInput> = {}): VideoTransformationInput {
    return {
      sourceVideo: videoPath,
      characterReference: characterPath,
      outfitReference: outfitPath,
      outputPath: join(root, 'out.mp4'),
      ...overrides,
    };
  }

  it('accepts a well-formed input', async () => {
    await assert.doesNotReject(() => validateInput(baseInput()));
  });

  it('accepts input with no outfit reference (optional)', async () => {
    await assert.doesNotReject(() => validateInput(baseInput({ outfitReference: undefined })));
  });

  it('rejects a missing source video', async () => {
    await assert.rejects(
      () => validateInput(baseInput({ sourceVideo: join(root, 'does-not-exist.mp4') })),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'SOURCE_VIDEO_MISSING',
    );
  });

  it('rejects a missing character reference', async () => {
    await assert.rejects(
      () => validateInput(baseInput({ characterReference: join(root, 'nope.jpg') })),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'CHARACTER_IMAGE_MISSING',
    );
  });

  it('rejects a missing outfit reference when one is specified', async () => {
    await assert.rejects(
      () => validateInput(baseInput({ outfitReference: join(root, 'nope.png') })),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'OUTFIT_IMAGE_MISSING',
    );
  });

  it('rejects an unsupported source video extension', async () => {
    const badPath = join(root, 'source.txt');
    await writeFile(badPath, 'x');
    await assert.rejects(
      () => validateInput(baseInput({ sourceVideo: badPath })),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'INVALID_VIDEO_FORMAT',
    );
  });

  it('rejects an unsupported character image extension', async () => {
    const badPath = join(root, 'character.gif');
    await writeFile(badPath, 'x');
    await assert.rejects(
      () => validateInput(baseInput({ characterReference: badPath })),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'INVALID_IMAGE_FORMAT',
    );
  });

  it('rejects an output path that does not end in .mp4', async () => {
    await assert.rejects(
      () => validateInput(baseInput({ outputPath: join(root, 'out.mov') })),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'INVALID_CONFIG',
    );
  });

  it('rejects when ffmpeg is unavailable', async () => {
    process.env.FFMPEG_BIN = '/definitely/not/a/real/binary-xyz';
    await assert.rejects(
      () => validateInput(baseInput()),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'FFMPEG_UNAVAILABLE',
    );
  });
});

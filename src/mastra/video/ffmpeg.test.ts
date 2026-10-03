import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssembleVideoArgs, buildExtractFramesArgs, buildFfprobeArgs, buildMuxAudioArgs, checkFfmpegAvailable } from './ffmpeg.ts';
import { VideoTransformError } from './types.ts';

describe('ffmpeg argv builders', () => {
  it('builds ffprobe args requesting JSON format+stream info, never a shell string', () => {
    const args = buildFfprobeArgs('/tmp/in put with spaces.mp4');
    assert.deepEqual(args, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '/tmp/in put with spaces.mp4']);
  });

  it('builds frame-extraction args with fps + aspect-preserving scale filter and a fresh output dir', () => {
    const args = buildExtractFramesArgs({ videoPath: '/in.mp4', framesDir: '/work/frames', fps: 12, maxDimension: 512 });
    assert.equal(args[0], '-y');
    assert.equal(args[1], '-i');
    assert.equal(args[2], '/in.mp4');
    assert.equal(args[3], '-vf');
    assert.match(args[4], /^fps=12,scale=/);
    assert.equal(args.at(-1), '/work/frames/frame-%06d.png');
  });

  it('builds frame-reassembly args with the requested fps and output path', () => {
    const args = buildAssembleVideoArgs({ framesDir: '/work/gen', framePattern: 'frame-%06d.png', fps: 24, outputPath: '/out/silent.mp4' });
    assert.deepEqual(args, ['-y', '-framerate', '24', '-i', '/work/gen/frame-%06d.png', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '/out/silent.mp4']);
  });

  it('builds audio-mux args that copy video and take audio only from the source, tolerating no audio track', () => {
    const args = buildMuxAudioArgs({ videoPath: '/work/silent.mp4', audioSourcePath: '/in.mp4', outputPath: '/out/final.mp4' });
    assert.deepEqual(args, [
      '-y',
      '-i',
      '/work/silent.mp4',
      '-i',
      '/in.mp4',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0?',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-shortest',
      '/out/final.mp4',
    ]);
  });
});

describe('checkFfmpegAvailable', () => {
  const originalFfmpegBin = process.env.FFMPEG_BIN;
  const originalFfprobeBin = process.env.FFPROBE_BIN;

  afterEach(() => {
    if (originalFfmpegBin === undefined) delete process.env.FFMPEG_BIN;
    else process.env.FFMPEG_BIN = originalFfmpegBin;
    if (originalFfprobeBin === undefined) delete process.env.FFPROBE_BIN;
    else process.env.FFPROBE_BIN = originalFfprobeBin;
  });

  it('throws FFMPEG_UNAVAILABLE with a helpful message when the binary does not exist', async () => {
    process.env.FFMPEG_BIN = '/definitely/not/a/real/binary-xyz';
    process.env.FFPROBE_BIN = '/definitely/not/a/real/binary-xyz';
    await assert.rejects(
      () => checkFfmpegAvailable(),
      (err: unknown) => {
        assert.ok(err instanceof VideoTransformError);
        assert.equal(err.code, 'FFMPEG_UNAVAILABLE');
        assert.match(err.message, /brew install ffmpeg/);
        return true;
      },
    );
  });

  it('succeeds when both configured binaries run and exit 0', async () => {
    const stub = process.platform === 'win32' ? 'cmd' : 'true';
    process.env.FFMPEG_BIN = stub;
    process.env.FFPROBE_BIN = stub;
    await assert.doesNotReject(() => checkFfmpegAvailable());
  });
});

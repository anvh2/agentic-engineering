import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleVideo, checkFfmpegAvailable, extractFrames, probeVideo } from './ffmpeg.ts';
import { runCommand } from './process-runner.ts';
import { resolveFfmpegBin } from './config.ts';

/**
 * Integration coverage against a REAL ffmpeg/ffprobe binary - deliberately
 * kept out of the default `npm test` glob (src/**\/*.test.ts) via the
 * `.itest.ts` suffix; run explicitly with `npm run test:integration`.
 * Every test skips itself (rather than failing the suite) when ffmpeg
 * isn't on PATH, since that's expected on machines that haven't installed
 * it yet (see VIDEO_TRANSFORMATION.md for the "brew install ffmpeg" step).
 */
describe('ffmpeg integration (real binary)', () => {
  let root: string;
  let ffmpegAvailable = true;
  let sourceVideo: string;

  before(async () => {
    try {
      await checkFfmpegAvailable();
    } catch {
      ffmpegAvailable = false;
      return;
    }

    root = await mkdtemp(join(tmpdir(), 'ffmpeg-itest-'));
    sourceVideo = join(root, 'source.mp4');
    // A synthetic 2-second, 10fps, 64x64 test pattern - no checked-in binary
    // fixture needed, and small enough to be fast in CI-style runs.
    const result = await runCommand(
      resolveFfmpegBin(),
      ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=10', '-pix_fmt', 'yuv420p', sourceVideo],
      { timeoutMs: 30_000 },
    );
    assert.ok(result.success, `failed to generate synthetic test video: ${result.stderr}`);
  });

  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('probes a real video for duration/fps/resolution/audio', async (t) => {
    if (!ffmpegAvailable) return t.skip('ffmpeg not installed on this machine');

    const probe = await probeVideo(sourceVideo);
    assert.equal(probe.width, 64);
    assert.equal(probe.height, 64);
    assert.ok(probe.durationSeconds >= 1.5 && probe.durationSeconds <= 2.5);
    assert.equal(probe.hasAudio, false);
  });

  it('extracts frames at the requested fps, capped to the requested max dimension', async (t) => {
    if (!ffmpegAvailable) return t.skip('ffmpeg not installed on this machine');

    const framesDir = join(root, 'frames');
    await mkdir(framesDir, { recursive: true });
    await extractFrames({ videoPath: sourceVideo, framesDir, fps: 5, maxDimension: 32 });

    const frames = (await readdir(framesDir)).filter((f) => f.endsWith('.png'));
    // ~2s at 5fps - allow a frame of slop either way for encoder rounding.
    assert.ok(frames.length >= 8 && frames.length <= 12, `expected ~10 frames, got ${frames.length}`);
  });

  it('reassembles extracted frames back into a playable mp4', async (t) => {
    if (!ffmpegAvailable) return t.skip('ffmpeg not installed on this machine');

    const framesDir = join(root, 'frames');
    const outputPath = join(root, 'reassembled.mp4');
    await assembleVideo({ framesDir, framePattern: 'frame-%06d.png', fps: 5, outputPath });

    const probe = await probeVideo(outputPath);
    assert.ok(probe.durationSeconds > 0);
    assert.equal(probe.width, 32);
  });
});

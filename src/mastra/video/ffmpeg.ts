import { join } from 'node:path';
import { resolveFfmpegBin, resolveFfmpegTimeoutMs, resolveFfprobeBin } from './config.ts';
import { runCommand, type CommandResult } from './process-runner.ts';
import { VideoTransformError } from './types.ts';

export interface VideoProbe {
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  codec: string;
}

export const FRAME_PATTERN = 'frame-%06d.png';

/** Pure argv builders, kept separate from execution so command construction is unit-testable without a real ffmpeg binary. */

export function buildFfprobeArgs(videoPath: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    videoPath,
  ];
}

export function buildExtractFramesArgs(opts: {
  videoPath: string;
  framesDir: string;
  fps: number;
  maxDimension: number;
}): string[] {
  const { videoPath, framesDir, fps, maxDimension } = opts;
  // scale preserves aspect ratio: longest side capped at maxDimension, both
  // dimensions forced even (required by most video codecs/diffusion nodes).
  const scaleExpr = `scale='if(gt(iw,ih),min(iw,${maxDimension}),-2)':'if(gt(iw,ih),-2,min(ih,${maxDimension}))':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  // No explicit vsync/fps_mode flag: the `fps=` filter above already
  // produces exactly one frame per output tick, and the vsync flag's name
  // and availability has shifted across ffmpeg versions (global `-vsync`
  // was removed in favor of per-output `-fps_mode` in newer builds) -
  // omitting it keeps this command portable across versions.
  return ['-y', '-i', videoPath, '-vf', `fps=${fps},${scaleExpr}`, join(framesDir, FRAME_PATTERN)];
}

export function buildAssembleVideoArgs(opts: {
  framesDir: string;
  framePattern: string;
  fps: number;
  outputPath: string;
}): string[] {
  const { framesDir, framePattern, fps, outputPath } = opts;
  return [
    '-y',
    '-framerate',
    String(fps),
    '-i',
    join(framesDir, framePattern),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    outputPath,
  ];
}

export function buildMuxAudioArgs(opts: { videoPath: string; audioSourcePath: string; outputPath: string }): string[] {
  const { videoPath, audioSourcePath, outputPath } = opts;
  return [
    '-y',
    '-i',
    videoPath,
    '-i',
    audioSourcePath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0?',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-shortest',
    outputPath,
  ];
}

export async function checkFfmpegAvailable(): Promise<void> {
  const [ffmpeg, ffprobe] = await Promise.all([
    runCommand(resolveFfmpegBin(), ['-version'], { timeoutMs: 10_000 }),
    runCommand(resolveFfprobeBin(), ['-version'], { timeoutMs: 10_000 }),
  ]);
  if (!ffmpeg.success || !ffprobe.success) {
    throw new VideoTransformError(
      'FFMPEG_UNAVAILABLE',
      `ffmpeg/ffprobe not available on PATH (looked for "${resolveFfmpegBin()}" / "${resolveFfprobeBin()}"). Install ffmpeg (e.g. "brew install ffmpeg") or set FFMPEG_BIN/FFPROBE_BIN.`,
    );
  }
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

function parseFrameRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split('/').map(Number);
  if (!den) return num || 0;
  return num / den;
}

export async function probeVideo(videoPath: string): Promise<VideoProbe> {
  const result = await runCommand(resolveFfprobeBin(), buildFfprobeArgs(videoPath), {
    timeoutMs: 30_000,
  });
  if (!result.success) {
    throw new VideoTransformError('FFPROBE_FAILED', `ffprobe failed to inspect "${videoPath}": ${result.stderr || result.stdout}`);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new VideoTransformError('FFPROBE_FAILED', `ffprobe returned non-JSON output for "${videoPath}"`, { cause: err });
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  if (!videoStream) {
    throw new VideoTransformError('INVALID_VIDEO_FORMAT', `"${videoPath}" has no video stream ffprobe could detect.`);
  }

  return {
    durationSeconds: Number(parsed.format?.duration) || 0,
    fps: parseFrameRate(videoStream.avg_frame_rate) || parseFrameRate(videoStream.r_frame_rate),
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    hasAudio: Boolean(audioStream),
    codec: videoStream.codec_name ?? 'unknown',
  };
}

async function runFfmpeg(args: string[], failureContext: string): Promise<CommandResult> {
  const result = await runCommand(resolveFfmpegBin(), args, { timeoutMs: resolveFfmpegTimeoutMs() });
  if (!result.success) {
    throw new VideoTransformError('FFMPEG_COMMAND_FAILED', `${failureContext}: ${result.stderr || result.stdout}`);
  }
  return result;
}

export async function extractFrames(opts: {
  videoPath: string;
  framesDir: string;
  fps: number;
  maxDimension: number;
}): Promise<void> {
  await runFfmpeg(buildExtractFramesArgs(opts), `ffmpeg failed to extract frames from "${opts.videoPath}"`);
}

export async function assembleVideo(opts: {
  framesDir: string;
  framePattern: string;
  fps: number;
  outputPath: string;
}): Promise<void> {
  await runFfmpeg(buildAssembleVideoArgs(opts), `ffmpeg failed to assemble frames into "${opts.outputPath}"`);
}

export async function muxAudio(opts: { videoPath: string; audioSourcePath: string; outputPath: string }): Promise<void> {
  await runFfmpeg(buildMuxAudioArgs(opts), `ffmpeg failed to mux audio into "${opts.outputPath}"`);
}

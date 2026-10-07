import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveMaxDimension, resolveMaxFps, resolveVideoWorkDirBase } from './config.ts';
import { assembleVideo, extractFrames, FRAME_PATTERN, muxAudio, probeVideo, type VideoProbe } from './ffmpeg.ts';
import { logStage } from './logger.ts';
import { createProviderFromConfig } from './provider-factory.ts';
import { validateInput } from './validate.ts';
import {
  VideoTransformError,
  type AppearanceVariation,
  type ProviderOutput,
  type VideoTransformationInput,
  type VideoTransformationMetadata,
  type VideoTransformationProvider,
  type VideoTransformationResult,
} from './types.ts';

export interface PipelineDeps {
  validateInput: typeof validateInput;
  probeVideo: typeof probeVideo;
  extractFrames: typeof extractFrames;
  assembleVideo: typeof assembleVideo;
  muxAudio: typeof muxAudio;
  provider: VideoTransformationProvider;
}

export function defaultDeps(): PipelineDeps {
  return {
    validateInput,
    probeVideo,
    extractFrames,
    assembleVideo,
    muxAudio,
    provider: createProviderFromConfig(),
  };
}

/**
 * Indirection the Mastra workflow steps call through instead of
 * `defaultDeps` directly, so tests can substitute fakes for ffmpeg/the AI
 * backend without needing real ffmpeg or a running ComfyUI instance - same
 * "monkeypatch a mutable property on an exported object" approach this
 * repo's coding-task-workflow.test.ts already uses for codingWorker.generate.
 */
export const pipelineRuntime: { createDeps: () => PipelineDeps } = { createDeps: defaultDeps };

async function countFrames(framesDir: string): Promise<number> {
  try {
    const entries = await readdir(framesDir);
    return entries.filter((f) => f.endsWith('.png')).length;
  } catch {
    return 0;
  }
}

/**
 * Stage 1: validate + probe the source video, then extract/normalize
 * frames into a fresh working directory. Mirrors "video preprocessing" +
 * "frame extraction" in the pipeline diagram. Exported standalone so the
 * Mastra workflow's `prepareVideo` step and the plain-function CLI path
 * both call the exact same logic.
 */
export interface PreparedVideo {
  workDir: string;
  framesDir: string;
  framePattern: string;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  sourceProbe: VideoProbe;
  appearanceVariation: AppearanceVariation;
}

export async function prepareVideo(
  input: VideoTransformationInput,
  deps: Pick<PipelineDeps, 'validateInput' | 'probeVideo' | 'extractFrames'> = defaultDeps(),
): Promise<PreparedVideo> {
  logStage('validating input');
  await deps.validateInput(input);

  logStage('inspecting video', { source: input.sourceVideo });
  const sourceProbe = await deps.probeVideo(input.sourceVideo);
  if (sourceProbe.durationSeconds <= 0) {
    throw new VideoTransformError('INVALID_VIDEO_FORMAT', `Source video "${input.sourceVideo}" has no detectable duration.`);
  }

  const workDir = resolve(join(resolveVideoWorkDirBase(), randomUUID()));
  const framesDir = join(workDir, 'source-frames');
  await mkdir(framesDir, { recursive: true });
  await mkdir(dirname(resolve(input.outputPath)), { recursive: true });

  const fps = Math.min(input.targetFps ?? (sourceProbe.fps || resolveMaxFps()), resolveMaxFps()) || resolveMaxFps();
  const maxDimension = input.maxDimension ?? resolveMaxDimension();

  logStage('preparing frames', { fps, maxDimension });
  await deps.extractFrames({ videoPath: input.sourceVideo, framesDir, fps, maxDimension });
  const frameCount = await countFrames(framesDir);
  if (frameCount === 0) {
    throw new VideoTransformError('FFMPEG_COMMAND_FAILED', `No frames were extracted from "${input.sourceVideo}".`);
  }

  return {
    workDir,
    framesDir,
    framePattern: FRAME_PATTERN,
    frameCount,
    fps,
    width: sourceProbe.width,
    height: sourceProbe.height,
    sourceProbe,
    appearanceVariation: input.appearanceVariation ?? 'subtle',
  };
}

/**
 * Stage 2: hand the prepared frames + reference images to the configured
 * AI backend. Corresponds to "character reference conditioning" ->
 * "outfit/reference conditioning" -> "video generation/transformation" ->
 * "temporal consistency" in the pipeline diagram - all delegated to the
 * provider, since that's exactly the seam VideoTransformationProvider
 * exists to abstract.
 */
export async function runVideoTransformation(
  input: VideoTransformationInput,
  prepared: PreparedVideo,
  provider: VideoTransformationProvider = defaultDeps().provider,
): Promise<ProviderOutput> {
  logStage('submitting inference', { backend: provider.name, frames: prepared.frameCount });
  const output = await provider.transform({
    framesDir: prepared.framesDir,
    framePattern: prepared.framePattern,
    fps: prepared.fps,
    width: prepared.width,
    height: prepared.height,
    characterReference: resolve(input.characterReference),
    outfitReference: input.outfitReference ? resolve(input.outfitReference) : undefined,
    prompt: input.prompt,
    appearanceVariation: prepared.appearanceVariation,
    workDir: prepared.workDir,
  });
  logStage('inference completed', { backend: provider.name });
  return output;
}

/**
 * Stage 3: "frame reconstruction" -> "MP4 output" - reassemble the
 * provider's output into a single MP4, mux the original audio back in
 * (providers only ever see/return video frames, never audio), verify the
 * result exists, and clean up the working directory on success.
 */
export async function assembleOutput(
  input: VideoTransformationInput,
  prepared: PreparedVideo,
  providerOutput: ProviderOutput,
  backend: VideoTransformationMetadata['backend'],
  deps: Pick<PipelineDeps, 'assembleVideo' | 'muxAudio' | 'probeVideo'> = defaultDeps(),
  startedAt: number = Date.now(),
): Promise<VideoTransformationResult> {
  logStage('assembling output');
  const silentVideoPath = join(prepared.workDir, 'assembled-silent.mp4');
  if (providerOutput.kind === 'video') {
    await copyFile(providerOutput.path, silentVideoPath);
  } else {
    await deps.assembleVideo({
      framesDir: providerOutput.dir,
      framePattern: providerOutput.pattern,
      fps: providerOutput.fps || prepared.fps,
      outputPath: silentVideoPath,
    });
  }

  const finalOutputPath = resolve(input.outputPath);
  if (prepared.sourceProbe.hasAudio) {
    await deps.muxAudio({ videoPath: silentVideoPath, audioSourcePath: input.sourceVideo, outputPath: finalOutputPath });
  } else {
    await copyFile(silentVideoPath, finalOutputPath);
  }

  let outputInfo;
  try {
    outputInfo = await stat(finalOutputPath);
  } catch {
    outputInfo = null;
  }
  if (!outputInfo || !outputInfo.isFile() || outputInfo.size === 0) {
    throw new VideoTransformError('OUTPUT_MISSING', `Expected output video at "${finalOutputPath}" was not produced.`);
  }

  const outputProbe = await deps.probeVideo(finalOutputPath).catch(() => null);

  const metadata: VideoTransformationMetadata = {
    backend,
    durationMs: Date.now() - startedAt,
    sourceDurationSeconds: prepared.sourceProbe.durationSeconds,
    sourceFps: prepared.sourceProbe.fps,
    sourceWidth: prepared.sourceProbe.width,
    sourceHeight: prepared.sourceProbe.height,
    outputFps: outputProbe?.fps ?? prepared.fps,
    outputWidth: outputProbe?.width ?? prepared.sourceProbe.width,
    outputHeight: outputProbe?.height ?? prepared.sourceProbe.height,
    frameCount: prepared.frameCount,
    appearanceVariation: prepared.appearanceVariation,
    workDir: prepared.workDir,
  };

  logStage('completed', { output: finalOutputPath, durationMs: metadata.durationMs });
  await rm(prepared.workDir, { recursive: true, force: true });

  return { outputPath: finalOutputPath, metadata };
}

/**
 * Runs the full source-video -> character/outfit-conditioned video pipeline
 * in one call. Shared by the CLI (scripts/video-transform.ts); the Mastra
 * workflow (workflows/video-transformation-workflow.ts) calls prepareVideo/
 * runVideoTransformation/assembleOutput directly instead, as separate
 * steps, using this same module's functions.
 */
export async function runVideoTransformationPipeline(
  input: VideoTransformationInput,
  depsOverride?: Partial<PipelineDeps>,
): Promise<VideoTransformationResult> {
  const deps = { ...defaultDeps(), ...depsOverride };
  const startedAt = Date.now();

  let prepared: PreparedVideo | undefined;
  try {
    prepared = await prepareVideo(input, deps);
    const providerOutput = await runVideoTransformation(input, prepared, deps.provider);
    return await assembleOutput(input, prepared, providerOutput, deps.provider.name, deps, startedAt);
  } catch (err) {
    // Temp frames/intermediate files are left in place on failure to aid
    // debugging, rather than cleaned up like the success path.
    logStage('failed', { workDir: prepared?.workDir, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

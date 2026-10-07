/**
 * Core types for the local video transformation pipeline (source video +
 * character reference [+ outfit reference] -> transformed video). See
 * VIDEO_TRANSFORMATION.md for the full architecture writeup.
 */

export type AppearanceVariation = 'none' | 'subtle';

export type VideoAiBackend = 'comfyui' | 'mock';

export interface VideoTransformationInput {
  /** Absolute or relative path to the source video containing a person. */
  sourceVideo: string;
  /** Absolute or relative path to the reference character image. */
  characterReference: string;
  /** Optional absolute or relative path to a clothing/outfit reference image. */
  outfitReference?: string;
  /** Where the final MP4 should be written. */
  outputPath: string;
  /** Optional free-text steering prompt passed through to the backend. */
  prompt?: string;
  /** How much the generated face should diverge from the character reference's exact likeness. Defaults to 'subtle'. */
  appearanceVariation?: AppearanceVariation;
  /** Target FPS for preprocessing/generation. Defaults to the source video's own FPS (capped by MAX_FPS). */
  targetFps?: number;
  /** Target max width/height for preprocessing/generation, aspect ratio preserved. Defaults to the source resolution (capped by MAX_DIMENSION). */
  maxDimension?: number;
}

export interface VideoTransformationMetadata {
  backend: VideoAiBackend;
  durationMs: number;
  sourceDurationSeconds: number;
  sourceFps: number;
  sourceWidth: number;
  sourceHeight: number;
  outputFps: number;
  outputWidth: number;
  outputHeight: number;
  frameCount: number;
  appearanceVariation: AppearanceVariation;
  workDir: string;
}

export interface VideoTransformationResult {
  outputPath: string;
  metadata: VideoTransformationMetadata;
}

/**
 * A provider yields either a finished video file (backends with their own
 * frame-combine step, e.g. a ComfyUI graph ending in VHS_VideoCombine) or a
 * directory of ordered frames the pipeline itself will reassemble into an
 * MP4. Keeping both shapes lets a future per-frame backend (e.g. img2img
 * with no built-in video muxer) plug in without changing the interface.
 */
export type ProviderOutput =
  | { kind: 'video'; path: string }
  | { kind: 'frames'; dir: string; fps: number; pattern: string };

export interface ProviderTransformInput {
  /** Directory of extracted, preprocessed source frames, in order. */
  framesDir: string;
  /** Frame filename pattern relative to framesDir, e.g. "frame-%06d.png". */
  framePattern: string;
  fps: number;
  width: number;
  height: number;
  characterReference: string;
  outfitReference?: string;
  prompt?: string;
  appearanceVariation: AppearanceVariation;
  /** Scratch directory the provider may use for its own intermediate output. */
  workDir: string;
}

/**
 * Abstraction over the AI backend that actually performs the character/
 * outfit transformation. Swappable so the concrete model (ComfyUI graph,
 * a future native video diffusion model, a virtual try-on model, ...) can
 * change without touching the pipeline, CLI, or Mastra workflow.
 */
export interface VideoTransformationProvider {
  readonly name: VideoAiBackend;
  transform(input: ProviderTransformInput): Promise<ProviderOutput>;
}

export type VideoTransformErrorCode =
  | 'SOURCE_VIDEO_MISSING'
  | 'CHARACTER_IMAGE_MISSING'
  | 'OUTFIT_IMAGE_MISSING'
  | 'INVALID_VIDEO_FORMAT'
  | 'INVALID_IMAGE_FORMAT'
  | 'FFMPEG_UNAVAILABLE'
  | 'FFPROBE_FAILED'
  | 'FFMPEG_COMMAND_FAILED'
  | 'BACKEND_UNAVAILABLE'
  | 'BACKEND_TIMEOUT'
  | 'BACKEND_FAILED'
  | 'MALFORMED_BACKEND_RESPONSE'
  | 'OUTPUT_MISSING'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'INVALID_CONFIG';

export class VideoTransformError extends Error {
  readonly code: VideoTransformErrorCode;

  constructor(code: VideoTransformErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VideoTransformError';
    this.code = code;
  }
}

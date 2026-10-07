import type { VideoAiBackend } from './types.ts';
import { VideoTransformError } from './types.ts';

/**
 * All backend/tooling configuration is read from the environment, never
 * hardcoded - lets the AI backend and its endpoint be swapped per
 * environment (local ComfyUI today, a different local backend later)
 * without touching source. Read lazily (function calls, not module-level
 * constants) so tests can set env vars per-case without process isolation.
 */

const VALID_BACKENDS: VideoAiBackend[] = ['comfyui', 'mock'];

export function resolveBackend(): VideoAiBackend {
  const raw = (process.env.VIDEO_AI_BACKEND ?? 'comfyui').trim().toLowerCase();
  if (!VALID_BACKENDS.includes(raw as VideoAiBackend)) {
    throw new VideoTransformError(
      'INVALID_CONFIG',
      `VIDEO_AI_BACKEND="${raw}" is not supported. Use one of: ${VALID_BACKENDS.join(', ')}.`,
    );
  }
  return raw as VideoAiBackend;
}

export function resolveComfyUiBaseUrl(): string {
  const raw = process.env.COMFYUI_BASE_URL ?? 'http://127.0.0.1:8188';
  return raw.replace(/\/$/, '');
}

export function resolveComfyUiWorkflowPath(): string {
  return (
    process.env.COMFYUI_WORKFLOW_PATH ??
    new URL('./providers/comfyui-workflow.sample.json', import.meta.url).pathname
  );
}

export function resolveComfyUiTimeoutMs(): number {
  return Number(process.env.COMFYUI_TIMEOUT_MS) || 20 * 60 * 1000;
}

export function resolveComfyUiPollIntervalMs(): number {
  return Number(process.env.COMFYUI_POLL_INTERVAL_MS) || 2_000;
}

export function resolveFfmpegBin(): string {
  return process.env.FFMPEG_BIN ?? 'ffmpeg';
}

export function resolveFfprobeBin(): string {
  return process.env.FFPROBE_BIN ?? 'ffprobe';
}

export function resolveVideoWorkDirBase(): string {
  return process.env.VIDEO_WORKDIR ?? '.workdir/video-transform';
}

export function resolveMaxFps(): number {
  return Number(process.env.VIDEO_MAX_FPS) || 24;
}

export function resolveMaxDimension(): number {
  return Number(process.env.VIDEO_MAX_DIMENSION) || 768;
}

export function resolveMinFreeDiskBytes(): number {
  return Number(process.env.VIDEO_MIN_FREE_DISK_BYTES) || 500 * 1024 * 1024;
}

export function resolveFfmpegTimeoutMs(): number {
  return Number(process.env.FFMPEG_TIMEOUT_MS) || 5 * 60 * 1000;
}

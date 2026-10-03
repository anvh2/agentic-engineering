import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBackend,
  resolveComfyUiBaseUrl,
  resolveComfyUiPollIntervalMs,
  resolveComfyUiTimeoutMs,
  resolveFfmpegBin,
  resolveFfprobeBin,
  resolveMaxDimension,
  resolveMaxFps,
} from './config.ts';
import { VideoTransformError } from './types.ts';

const ENV_KEYS = [
  'VIDEO_AI_BACKEND',
  'COMFYUI_BASE_URL',
  'COMFYUI_TIMEOUT_MS',
  'COMFYUI_POLL_INTERVAL_MS',
  'FFMPEG_BIN',
  'FFPROBE_BIN',
  'VIDEO_MAX_FPS',
  'VIDEO_MAX_DIMENSION',
];

describe('video/config', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('defaults the backend to comfyui', () => {
    assert.equal(resolveBackend(), 'comfyui');
  });

  it('reads VIDEO_AI_BACKEND when set', () => {
    process.env.VIDEO_AI_BACKEND = 'mock';
    assert.equal(resolveBackend(), 'mock');
  });

  it('is case-insensitive for VIDEO_AI_BACKEND', () => {
    process.env.VIDEO_AI_BACKEND = 'MOCK';
    assert.equal(resolveBackend(), 'mock');
  });

  it('rejects an unsupported backend name', () => {
    process.env.VIDEO_AI_BACKEND = 'stable-video-diffusion-cloud';
    assert.throws(
      () => resolveBackend(),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'INVALID_CONFIG',
    );
  });

  it('defaults the ComfyUI base URL and strips a trailing slash', () => {
    assert.equal(resolveComfyUiBaseUrl(), 'http://127.0.0.1:8188');
    process.env.COMFYUI_BASE_URL = 'http://localhost:9000/';
    assert.equal(resolveComfyUiBaseUrl(), 'http://localhost:9000');
  });

  it('defaults timeouts and poll interval, overridable via env', () => {
    assert.equal(resolveComfyUiTimeoutMs(), 20 * 60 * 1000);
    assert.equal(resolveComfyUiPollIntervalMs(), 2_000);
    process.env.COMFYUI_TIMEOUT_MS = '5000';
    process.env.COMFYUI_POLL_INTERVAL_MS = '500';
    assert.equal(resolveComfyUiTimeoutMs(), 5000);
    assert.equal(resolveComfyUiPollIntervalMs(), 500);
  });

  it('defaults ffmpeg/ffprobe binaries to PATH lookups, overridable via env', () => {
    assert.equal(resolveFfmpegBin(), 'ffmpeg');
    assert.equal(resolveFfprobeBin(), 'ffprobe');
    process.env.FFMPEG_BIN = '/opt/homebrew/bin/ffmpeg';
    assert.equal(resolveFfmpegBin(), '/opt/homebrew/bin/ffmpeg');
  });

  it('defaults max fps and max dimension, overridable via env', () => {
    assert.equal(resolveMaxFps(), 24);
    assert.equal(resolveMaxDimension(), 768);
    process.env.VIDEO_MAX_FPS = '12';
    process.env.VIDEO_MAX_DIMENSION = '512';
    assert.equal(resolveMaxFps(), 12);
    assert.equal(resolveMaxDimension(), 512);
  });
});

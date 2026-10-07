/**
 * Environment-driven configuration for the cloud generation layer.
 *
 * Read lazily (function calls, not module-level constants) so tests can set
 * env vars per-case without process isolation — same pattern as video/config.ts.
 *
 * FAL_KEY is server-side only; never exposed to browser/client code.
 */

import { GenerationError } from './types.ts';
import type { MarketingShotType } from './product-spec.ts';

/** The fal.ai API key. Throws if absent — callers must check before any real API call. */
export function resolveFalKey(): string {
  const key = process.env.FAL_KEY ?? '';
  if (!key) {
    throw new GenerationError(
      'INVALID_CONFIG',
      'FAL_KEY environment variable is not set. ' +
        'Add it to .env (server-side only — never commit the real key).',
    );
  }
  return key;
}

/** fal.ai queue base URL. */
export function resolveFalBaseUrl(): string {
  return (process.env.FAL_BASE_URL ?? 'https://queue.fal.run').replace(/\/$/, '');
}

/**
 * Maximum time in milliseconds to wait when polling fal for a queued job.
 * Defaults to 10 minutes (cloud inference is slow for the first cold start).
 */
export function resolveFalTimeoutMs(): number {
  return Number(process.env.FAL_TIMEOUT_MS) || 10 * 60 * 1_000;
}

/** How long to wait between status polls. */
export function resolveFalPollIntervalMs(): number {
  return Number(process.env.FAL_POLL_INTERVAL_MS) || 3_000;
}

/**
 * Local directory for downloaded generation artifacts.
 * Defaults to .workdir/generation relative to the project root.
 */
export function resolveGenerationWorkDir(): string {
  return process.env.GENERATION_WORKDIR ?? '.workdir/generation';
}

/**
 * Default provider for capability routing when IMAGE_PROVIDER is not set.
 * Must match a GenerationProvider.providerName.
 */
export function resolveImageProvider(): string {
  return (process.env.IMAGE_PROVIDER ?? 'fal').trim().toLowerCase();
}

/**
 * Override the default IMAGE_MODEL instead of relying on the registry's
 * first matching entry for the configured provider.
 */
export function resolveImageModel(): string | undefined {
  return process.env.IMAGE_MODEL?.trim() || undefined;
}

/** Default provider for video generation. */
export function resolveVideoProvider(): string {
  return (process.env.VIDEO_PROVIDER ?? 'fal').trim().toLowerCase();
}

/** Override the default video model. */
export function resolveVideoModel(): string | undefined {
  return process.env.VIDEO_MODEL?.trim() || undefined;
}

/**
 * Per-shot type provider resolution.
 * Allows independent routing per shot type:
 *   MODEL_HERO_PROVIDER / PRODUCT_HERO_PROVIDER / PRODUCT_DETAIL_PROVIDER
 * Falls back to IMAGE_PROVIDER.
 */
export function resolveShotProvider(shotType: MarketingShotType): string {
  const envKey = `${shotType}_PROVIDER`;
  const envVal = process.env[envKey]?.trim().toLowerCase();
  return envVal || resolveImageProvider();
}

/**
 * Per-shot type model resolution.
 * Allows independent model override per shot type:
 *   MODEL_HERO_MODEL / PRODUCT_HERO_MODEL / PRODUCT_DETAIL_MODEL
 * Falls back to IMAGE_MODEL or registry default.
 */
export function resolveShotModel(shotType: MarketingShotType): string | undefined {
  const envKey = `${shotType}_MODEL`;
  const envVal = process.env[envKey]?.trim();
  return envVal || resolveImageModel();
}

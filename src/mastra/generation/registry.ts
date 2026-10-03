/**
 * Model registry: the single source of truth for which provider hosts which
 * model and what capabilities each model supports.
 *
 * Application code picks a capability; the registry resolves to (provider,
 * modelId). Model IDs and provider-specific slugs live here only — never
 * scattered through workflow code.
 */

import type { GenerationCapability } from './types.ts';

export interface ModelEntry {
  /** Provider adapter name (matches GenerationProvider.providerName). */
  provider: string;
  /** Provider-specific model identifier sent in API requests. */
  modelId: string;
  /** Which capabilities this model supports. */
  capabilities: GenerationCapability[];
  /** Human-readable description for logs/debugging. */
  description?: string;
}

/**
 * Registry of all known provider/model combinations.
 *
 * fal.ai models:
 *   flux-vto      — FLUX Virtual Try-On    → virtual_try_on (MODEL_HERO)
 *   qwen-ie       — Qwen Image Edit        → image_edit (PRODUCT_HERO/DETAIL)
 *   flux-kontext  — FLUX Kontext           → image_edit (PRODUCT_HERO/DETAIL)
 *   wan-v2.2      — Wan 2.2 Turbo i2v     → image_to_video
 */
export const MODEL_REGISTRY: ModelEntry[] = [
  {
    provider: 'fal',
    modelId: 'fal-ai/flux-pro/v1/fill',
    capabilities: ['virtual_try_on'],
    description: 'FLUX Virtual Try-On (fal.ai)',
  },
  {
    provider: 'fal',
    modelId: 'fal-ai/qwen2-vl-instruct',
    capabilities: ['image_edit'],
    description: 'Qwen Image Edit (fal.ai)',
  },
  {
    provider: 'fal',
    modelId: 'fal-ai/flux-pro/kontext',
    capabilities: ['image_edit'],
    description: 'FLUX Kontext image editing (fal.ai)',
  },
  {
    provider: 'fal',
    modelId: 'fal-ai/wan-i2v/turbo',
    capabilities: ['image_to_video'],
    description: 'Wan 2.2 Turbo image-to-video (fal.ai)',
  },
  {
    provider: 'mock',
    modelId: 'mock-vto',
    capabilities: ['virtual_try_on'],
    description: 'Mock Virtual Try-On',
  },
  {
    provider: 'mock',
    modelId: 'mock-edit',
    capabilities: ['image_edit'],
    description: 'Mock Image Edit',
  },
  {
    provider: 'mock',
    modelId: 'mock-video',
    capabilities: ['image_to_video'],
    description: 'Mock Video Generation',
  },
];

/**
 * Find all entries that support the requested capability, optionally filtered
 * by a specific provider. Returns entries in registry order (first = default).
 */
export function findByCapability(
  capability: GenerationCapability,
  provider?: string,
): ModelEntry[] {
  return MODEL_REGISTRY.filter(
    (e) =>
      e.capabilities.includes(capability) &&
      (provider === undefined || e.provider === provider),
  );
}

/**
 * Find a specific entry by provider + modelId pair. Returns undefined if not
 * registered.
 */
export function findByProviderModel(provider: string, modelId: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find((e) => e.provider === provider && e.modelId === modelId);
}

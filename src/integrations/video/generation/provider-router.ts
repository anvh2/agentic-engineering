/**
 * Provider Router: maps application capabilities and marketing shot types
 * to configured providers and models.
 *
 * Does NOT hardcode provider-specific call shapes. The application asks for
 * a capability (e.g. 'virtual_try_on' or 'image_to_video') or a marketing
 * shot type ('MODEL_HERO', 'PRODUCT_HERO', 'PRODUCT_DETAIL'), and the router
 * inspects configuration (or environment overrides) and the MODEL_REGISTRY
 * to select the appropriate GenerationProvider and model ID.
 */

import {
  resolveImageModel,
  resolveImageProvider,
  resolveShotModel,
  resolveShotProvider,
  resolveVideoModel,
  resolveVideoProvider,
} from './config.ts';
import { findByCapability, findByProviderModel, MODEL_REGISTRY } from './registry.ts';
import { FalProvider } from './providers/fal-provider.ts';
import { MockGenerationProvider } from './providers/mock-provider.ts';
import type { MarketingShotType } from './product-spec.ts';
import {
  GenerationError,
  type GenerationCapability,
  type GenerationProvider,
} from './types.ts';

export interface RouteResolution {
  provider: GenerationProvider;
  modelId: string;
}

export class ProviderRouter {
  private providers = new Map<string, GenerationProvider>();

  constructor(customProviders?: GenerationProvider[]) {
    // Register default providers
    const defaultProviders: GenerationProvider[] = [
      new FalProvider(),
      new MockGenerationProvider(),
    ];
    for (const p of customProviders || defaultProviders) {
      this.providers.set(p.providerName, p);
    }
  }

  registerProvider(provider: GenerationProvider): void {
    this.providers.set(provider.providerName, provider);
  }

  getProvider(providerName: string): GenerationProvider | undefined {
    return this.providers.get(providerName);
  }

  /**
   * Resolves a capability to a concrete (provider, modelId) pair.
   *
   * Priority:
   * 1. Explicit override passed in arguments
   * 2. Environment variables (IMAGE_PROVIDER/IMAGE_MODEL or VIDEO_PROVIDER/VIDEO_MODEL)
   * 3. Registry lookup by capability using the active provider
   * 4. First matching capability in MODEL_REGISTRY
   */
  resolveRoute(
    capability: GenerationCapability,
    overrides?: { provider?: string; model?: string },
  ): RouteResolution {
    const isVideo = capability === 'image_to_video';
    const targetProviderName = (
      overrides?.provider ||
      (isVideo ? resolveVideoProvider() : resolveImageProvider())
    ).toLowerCase();

    const provider = this.providers.get(targetProviderName);
    if (!provider) {
      throw new GenerationError(
        'INVALID_CONFIG',
        `No provider registered with name "${targetProviderName}". Available: ${Array.from(this.providers.keys()).join(', ')}`,
      );
    }

    // 1. If explicit model override was requested:
    const explicitModel = overrides?.model || (isVideo ? resolveVideoModel() : resolveImageModel());
    if (explicitModel) {
      const entry = findByProviderModel(targetProviderName, explicitModel);
      if (entry && !entry.capabilities.includes(capability)) {
        throw new GenerationError(
          'UNSUPPORTED_CAPABILITY',
          `Model "${explicitModel}" on provider "${targetProviderName}" does not support capability "${capability}". Supported: ${entry.capabilities.join(', ')}`,
        );
      }
      if (!provider.supportedModels.includes(explicitModel)) {
        throw new GenerationError(
          'UNSUPPORTED_MODEL',
          `Provider "${targetProviderName}" does not support model "${explicitModel}".`,
        );
      }
      return { provider, modelId: explicitModel };
    }

    // 2. Query registry by capability for this provider
    const matchingEntries = findByCapability(capability, targetProviderName);
    if (matchingEntries.length > 0) {
      return { provider, modelId: matchingEntries[0].modelId };
    }

    // 3. Check if any provider has this capability to give an informative error
    const anyMatches = findByCapability(capability);
    if (anyMatches.length > 0) {
      throw new GenerationError(
        'UNSUPPORTED_CAPABILITY',
        `Provider "${targetProviderName}" has no model supporting "${capability}". Available on: ${anyMatches.map((m) => m.provider).join(', ')}`,
      );
    }

    throw new GenerationError(
      'UNSUPPORTED_CAPABILITY',
      `No registered model supports capability "${capability}". Known models: ${MODEL_REGISTRY.map((m) => `${m.provider}:${m.modelId}`).join(', ')}`,
    );
  }

  /**
   * Resolves a marketing shot type (MODEL_HERO, PRODUCT_HERO, PRODUCT_DETAIL)
   * to a concrete provider and model.
   *
   * Maps:
   * - MODEL_HERO    -> capability: 'virtual_try_on'
   * - PRODUCT_HERO  -> capability: 'image_edit'
   * - PRODUCT_DETAIL -> capability: 'image_edit'
   *
   * Honors per-shot environment configurations:
   * - ${SHOT_TYPE}_PROVIDER
   * - ${SHOT_TYPE}_MODEL
   */
  resolveShotRoute(
    shotType: MarketingShotType,
    overrides?: { provider?: string; model?: string },
  ): RouteResolution {
    const capability: GenerationCapability =
      shotType === 'MODEL_HERO' ? 'virtual_try_on' : 'image_edit';

    const providerOverride = overrides?.provider || resolveShotProvider(shotType);
    const modelOverride = overrides?.model || resolveShotModel(shotType);

    return this.resolveRoute(capability, {
      provider: providerOverride,
      model: modelOverride,
    });
  }
}

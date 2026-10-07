/**
 * GenerationService: high-level application entrypoint for cloud generation.
 *
 * Coordinates capability routing, async submission, polling, artifact
 * downloads, canonical product specifications, marketing asset generation,
 * and fidelity gate recording.
 */

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveGenerationWorkDir } from './config.ts';
import { ProviderRouter } from './provider-router.ts';
import { renderShotPrompt, type MarketingShotType, type ProductSpec } from './product-spec.ts';
import {
  GenerationError,
  type GenerateImageRequest,
  type GenerateVideoRequest,
  type GenerationCapability,
  type GenerationJob,
  type GenerationRecord,
  type GenerationStatus,
} from './types.ts';

export interface GenerationServiceOptions {
  router?: ProviderRouter;
}

export class GenerationService {
  readonly router: ProviderRouter;

  constructor(options?: GenerationServiceOptions) {
    this.router = options?.router || new ProviderRouter();
  }

  /**
   * Submit an image generation request for a given capability
   * ('virtual_try_on' | 'image_edit').
   */
  async submitImage(
    request: GenerateImageRequest,
    options?: {
      capability?: 'virtual_try_on' | 'image_edit';
      provider?: string;
      model?: string;
    },
  ): Promise<GenerationJob> {
    const capability: GenerationCapability =
      options?.capability || (request.personImage ? 'virtual_try_on' : 'image_edit');
    const { provider, modelId } = this.router.resolveRoute(capability, {
      provider: options?.provider,
      model: options?.model,
    });

    return provider.submit(request, modelId);
  }

  /**
   * Submit a marketing shot (MODEL_HERO, PRODUCT_HERO, PRODUCT_DETAIL)
   * conditioned on a canonical ProductSpec.
   */
  async submitMarketingShot(
    spec: ProductSpec,
    shotType: MarketingShotType,
    options?: {
      personImage?: string;
      customSteering?: string;
      provider?: string;
      model?: string;
      width?: number;
      height?: number;
    },
  ): Promise<GenerationJob> {
    const { provider, modelId } = this.router.resolveShotRoute(shotType, {
      provider: options?.provider,
      model: options?.model,
    });

    const prompt = renderShotPrompt(spec, shotType, options?.customSteering);
    const productImages = spec.rawReferenceImages && spec.rawReferenceImages.length > 0
      ? spec.rawReferenceImages
      : [];

    const request: GenerateImageRequest = {
      productImages,
      personImage: shotType === 'MODEL_HERO' ? options?.personImage : undefined,
      prompt,
      width: options?.width || 768,
      height: options?.height || 1024,
      label: shotType,
    };

    return provider.submit(request, modelId);
  }

  /**
   * Submit a video generation request from an approved keyframe.
   */
  async submitVideo(
    request: GenerateVideoRequest,
    options?: {
      provider?: string;
      model?: string;
    },
  ): Promise<GenerationJob> {
    const { provider, modelId } = this.router.resolveRoute('image_to_video', {
      provider: options?.provider,
      model: options?.model,
    });

    return provider.submit(request, modelId);
  }

  /**
   * Poll an external job until completion or timeout.
   */
  async awaitJob(
    externalJobId: string,
    options?: {
      destPath?: string;
      timeoutMs?: number;
      pollIntervalMs?: number;
    },
  ): Promise<GenerationRecord> {
    const [modelId] = externalJobId.split('::');
    // Determine provider for this job
    let provider = this.router.getProvider('fal');
    if (!provider || !provider.supportedModels.includes(modelId)) {
      provider = this.router.getProvider('mock');
    }
    if (!provider) {
      throw new GenerationError('INVALID_REQUEST', `Cannot identify provider for job "${externalJobId}".`);
    }

    const timeoutMs = options?.timeoutMs || 10 * 60 * 1000;
    const pollIntervalMs = options?.pollIntervalMs || 3000;
    const deadline = Date.now() + timeoutMs;

    const startedAt = Date.now();

    while (Date.now() < deadline) {
      const status: GenerationStatus = await provider.getStatus(externalJobId);
      if (status === 'failed') {
        throw new GenerationError('SUBMISSION_FAILED', `Job "${externalJobId}" failed on provider "${provider.providerName}".`);
      }
      if (status === 'completed') {
        const destPath =
          options?.destPath ||
          join(resolveGenerationWorkDir(), `${randomUUID()}.png`);
        const record = await provider.getResult(externalJobId, destPath);
        record.latencyMs = Date.now() - startedAt;
        return record;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new GenerationError('RESULT_NOT_READY', `Job "${externalJobId}" timed out after ${timeoutMs}ms.`);
  }

  /**
   * High-level synchronous helper: submits and awaits result.
   */
  async generateImage(
    request: GenerateImageRequest,
    options?: {
      capability?: 'virtual_try_on' | 'image_edit';
      provider?: string;
      model?: string;
      destPath?: string;
      timeoutMs?: number;
      pollIntervalMs?: number;
    },
  ): Promise<GenerationRecord> {
    const job = await this.submitImage(request, options);
    return this.awaitJob(job.externalJobId, options);
  }

  /**
   * Synchronous helper to generate a marketing shot from ProductSpec and await result.
   */
  async generateMarketingShot(
    spec: ProductSpec,
    shotType: MarketingShotType,
    options?: {
      personImage?: string;
      customSteering?: string;
      provider?: string;
      model?: string;
      destPath?: string;
      timeoutMs?: number;
      pollIntervalMs?: number;
      width?: number;
      height?: number;
    },
  ): Promise<GenerationRecord> {
    const job = await this.submitMarketingShot(spec, shotType, options);
    return this.awaitJob(job.externalJobId, options);
  }

  /**
   * Fidelity gate review helper: attaches review decision to the generation record.
   */
  recordFidelityReview(
    record: GenerationRecord,
    approved: boolean,
    rejectionReason?: string,
  ): GenerationRecord {
    return {
      ...record,
      approved,
      rejectionReason: approved ? undefined : rejectionReason || 'Failed fidelity inspection',
    };
  }
}

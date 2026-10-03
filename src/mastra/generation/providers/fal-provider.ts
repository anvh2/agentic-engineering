/**
 * Fal.ai provider adapter.
 *
 * Implements the normalized GenerationProvider interface against fal.ai's
 * asynchronous Queue API (https://queue.fal.run).
 *
 * External Job ID format: `${modelId}::${requestId}`
 * This allows getStatus / getResult to know both the model endpoint and
 * request ID without external state.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveFalBaseUrl, resolveFalKey } from '../config.ts';
import {
  GenerationError,
  type GenerateImageRequest,
  type GenerateVideoRequest,
  type GenerationJob,
  type GenerationProvider,
  type GenerationRecord,
  type GenerationStatus,
} from '../types.ts';

export class FalProvider implements GenerationProvider {
  readonly providerName = 'fal';
  readonly supportedModels = [
    'fal-ai/flux-pro/v1/fill',
    'fal-ai/qwen2-vl-instruct',
    'fal-ai/flux-pro/kontext',
    'fal-ai/wan-i2v/turbo',
  ];

  async submit(
    request: GenerateImageRequest | GenerateVideoRequest,
    modelId: string,
  ): Promise<GenerationJob> {
    if (!this.supportedModels.includes(modelId)) {
      throw new GenerationError(
        'UNSUPPORTED_MODEL',
        `Model "${modelId}" is not supported by FalProvider. Supported: ${this.supportedModels.join(', ')}`,
      );
    }

    const apiKey = resolveFalKey();
    const baseUrl = resolveFalBaseUrl();
    const payload = await this.mapRequestToPayload(request, modelId);

    const endpointUrl = `${baseUrl}/${modelId}`;
    let response: Response;
    try {
      response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new GenerationError(
        'PROVIDER_UNAVAILABLE',
        `Failed to connect to fal.ai at "${endpointUrl}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new GenerationError(
        'SUBMISSION_FAILED',
        `fal.ai submission rejected (HTTP ${response.status}): ${errText.slice(0, 500)}`,
      );
    }

    let resultJson: { request_id?: string; status?: string };
    try {
      resultJson = await response.json();
    } catch (err) {
      throw new GenerationError(
        'SUBMISSION_FAILED',
        'fal.ai submission response was not valid JSON.',
        { cause: err },
      );
    }

    const requestId = resultJson.request_id;
    if (!requestId) {
      throw new GenerationError(
        'SUBMISSION_FAILED',
        'fal.ai response did not contain a request_id.',
      );
    }

    const capability = this.inferCapability(request);
    const externalJobId = `${modelId}::${requestId}`;

    return {
      externalJobId,
      provider: this.providerName,
      model: modelId,
      capability,
      status: this.mapFalStatus(resultJson.status ?? 'IN_QUEUE'),
      submittedAt: new Date().toISOString(),
    };
  }

  async getStatus(externalJobId: string): Promise<GenerationStatus> {
    const { modelId, requestId } = this.parseJobId(externalJobId);
    const apiKey = resolveFalKey();
    const baseUrl = resolveFalBaseUrl();
    const statusUrl = `${baseUrl}/${modelId}/requests/${requestId}/status`;

    let response: Response;
    try {
      response = await fetch(statusUrl, {
        headers: {
          Authorization: `Key ${apiKey}`,
        },
      });
    } catch (err) {
      throw new GenerationError(
        'PROVIDER_UNAVAILABLE',
        `Failed to check status from fal.ai: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new GenerationError(
        'PROVIDER_UNAVAILABLE',
        `fal.ai status check failed (HTTP ${response.status}): ${errText.slice(0, 500)}`,
      );
    }

    const data = await response.json().catch(() => ({}));
    return this.mapFalStatus(data.status);
  }

  async getResult(externalJobId: string, destPath?: string): Promise<GenerationRecord> {
    const { modelId, requestId } = this.parseJobId(externalJobId);
    const apiKey = resolveFalKey();
    const baseUrl = resolveFalBaseUrl();
    const responseUrl = `${baseUrl}/${modelId}/requests/${requestId}`;

    let response: Response;
    try {
      response = await fetch(responseUrl, {
        headers: {
          Authorization: `Key ${apiKey}`,
        },
      });
    } catch (err) {
      throw new GenerationError(
        'PROVIDER_UNAVAILABLE',
        `Failed to fetch result from fal.ai: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (response.status === 202) {
      throw new GenerationError('RESULT_NOT_READY', `Job "${externalJobId}" is still in progress.`);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new GenerationError(
        'RESULT_FETCH_FAILED',
        `fal.ai result fetch failed (HTTP ${response.status}): ${errText.slice(0, 500)}`,
      );
    }

    let data: Record<string, any>;
    try {
      data = await response.json();
    } catch (err) {
      throw new GenerationError('RESULT_FETCH_FAILED', 'fal.ai result response was not valid JSON.', { cause: err });
    }

    // Extract artifact URL (image or video)
    const mediaUrl =
      data.images?.[0]?.url ||
      data.image?.url ||
      data.video?.url ||
      data.output?.url;

    let savedPath = destPath;
    if (destPath && mediaUrl) {
      await this.downloadArtifact(mediaUrl, destPath);
    }

    return {
      externalJobId,
      provider: this.providerName,
      model: modelId,
      capability: modelId.includes('wan') || modelId.includes('video') ? 'image_to_video' : 'virtual_try_on',
      status: 'completed',
      submittedAt: data.created_at || new Date().toISOString(),
      completedAt: new Date().toISOString(),
      resultPath: savedPath || mediaUrl,
      providerMeta: {
        raw: data,
        mediaUrl,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private parseJobId(externalJobId: string): { modelId: string; requestId: string } {
    const parts = externalJobId.split('::');
    if (parts.length !== 2) {
      throw new GenerationError('INVALID_REQUEST', `Invalid externalJobId format: "${externalJobId}". Expected "modelId::requestId".`);
    }
    return { modelId: parts[0], requestId: parts[1] };
  }

  private mapFalStatus(falStatus?: string): GenerationStatus {
    switch (falStatus?.toUpperCase()) {
      case 'IN_QUEUE':
        return 'queued';
      case 'IN_PROGRESS':
        return 'running';
      case 'COMPLETED':
      case 'OK':
        return 'completed';
      case 'FAILED':
      case 'ERROR':
        return 'failed';
      default:
        return 'queued';
    }
  }

  private inferCapability(request: GenerateImageRequest | GenerateVideoRequest) {
    if ('keyframePath' in request) {
      return 'image_to_video' as const;
    }
    return request.personImage ? ('virtual_try_on' as const) : ('image_edit' as const);
  }

  async mapRequestToPayload(
    request: GenerateImageRequest | GenerateVideoRequest,
    modelId: string,
  ): Promise<Record<string, unknown>> {
    if ('keyframePath' in request) {
      // Video request
      const imageUrl = await this.toMediaReference(request.keyframePath);
      return {
        image_url: imageUrl,
        prompt: request.prompt || 'subtle natural motion, cinematic fashion commercial',
        num_frames: Math.min(Math.round((request.durationSeconds || 4) * 16), 81),
      };
    }

    // Image request
    const productUrl = request.productImages[0]
      ? await this.toMediaReference(request.productImages[0])
      : undefined;

    if (modelId === 'fal-ai/flux-pro/v1/fill') {
      const personUrl = request.personImage ? await this.toMediaReference(request.personImage) : undefined;
      return {
        prompt: request.prompt || 'high fashion commercial marketing shot, perfectly fitted clothing',
        image_url: personUrl || productUrl,
        reference_image_url: productUrl,
        image_size: {
          width: request.width || 768,
          height: request.height || 1024,
        },
      };
    }

    if (modelId === 'fal-ai/flux-pro/kontext') {
      return {
        prompt: request.prompt || 'professional fashion editorial, wearing target product',
        image_url: productUrl,
        target_image_url: request.personImage ? await this.toMediaReference(request.personImage) : undefined,
      };
    }

    // Default image edit / general image mapping
    return {
      prompt: request.prompt || 'editorial product photo',
      image_urls: await Promise.all(request.productImages.map((p) => this.toMediaReference(p))),
      image_size: {
        width: request.width || 768,
        height: request.height || 1024,
      },
    };
  }

  private async toMediaReference(pathOrUrl: string): Promise<string> {
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://') || pathOrUrl.startsWith('data:')) {
      return pathOrUrl;
    }
    try {
      const buffer = await readFile(pathOrUrl);
      const ext = pathOrUrl.split('.').pop()?.toLowerCase() || 'png';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (err) {
      throw new GenerationError(
        'INVALID_REQUEST',
        `Could not read local file at "${pathOrUrl}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async downloadArtifact(url: string, destPath: string): Promise<void> {
    await mkdir(dirname(destPath), { recursive: true });
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new GenerationError('RESULT_FETCH_FAILED', `Failed to download artifact from "${url}"`, { cause: err });
    }
    if (!res.ok) {
      throw new GenerationError('RESULT_FETCH_FAILED', `Failed to download artifact: HTTP ${res.status}`);
    }
    const arrayBuf = await res.arrayBuffer();
    await writeFile(destPath, Buffer.from(arrayBuf));
  }
}

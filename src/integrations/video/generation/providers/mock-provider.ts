/**
 * Mock provider for unit tests and local dry-runs.
 *
 * Simulates async job submission, status polling, and mock artifact generation
 * without external network calls or paid API consumption.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  GenerateImageRequest,
  GenerateVideoRequest,
  GenerationJob,
  GenerationProvider,
  GenerationRecord,
  GenerationStatus,
} from '../types.ts';
import { GenerationError } from '../types.ts';

export class MockGenerationProvider implements GenerationProvider {
  readonly providerName = 'mock';
  readonly supportedModels = ['mock-vto', 'mock-edit', 'mock-video'];

  private jobs = new Map<
    string,
    {
      job: GenerationJob;
      request: GenerateImageRequest | GenerateVideoRequest;
      polls: number;
    }
  >();

  async submit(
    request: GenerateImageRequest | GenerateVideoRequest,
    modelId: string,
  ): Promise<GenerationJob> {
    if (!this.supportedModels.includes(modelId)) {
      throw new GenerationError('UNSUPPORTED_MODEL', `Model "${modelId}" not supported by MockProvider.`);
    }

    const requestId = `mock-req-${Math.random().toString(36).slice(2, 10)}`;
    const externalJobId = `${modelId}::${requestId}`;
    const capability =
      'keyframePath' in request
        ? 'image_to_video'
        : request.personImage
          ? 'virtual_try_on'
          : 'image_edit';

    const job: GenerationJob = {
      externalJobId,
      provider: this.providerName,
      model: modelId,
      capability,
      status: 'queued',
      submittedAt: new Date().toISOString(),
    };

    this.jobs.set(externalJobId, { job, request, polls: 0 });
    return job;
  }

  async getStatus(externalJobId: string): Promise<GenerationStatus> {
    const entry = this.jobs.get(externalJobId);
    if (!entry) {
      throw new GenerationError('INVALID_REQUEST', `Job "${externalJobId}" not found in mock store.`);
    }
    entry.polls++;
    if (entry.polls === 1) {
      entry.job.status = 'running';
    } else {
      entry.job.status = 'completed';
    }
    return entry.job.status;
  }

  async getResult(externalJobId: string, destPath?: string): Promise<GenerationRecord> {
    const entry = this.jobs.get(externalJobId);
    if (!entry) {
      throw new GenerationError('INVALID_REQUEST', `Job "${externalJobId}" not found in mock store.`);
    }

    if (entry.job.status !== 'completed' && entry.polls < 2) {
      throw new GenerationError('RESULT_NOT_READY', `Job "${externalJobId}" is still running.`);
    }

    if (destPath) {
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, Buffer.from('MOCK_GENERATION_ARTIFACT'));
    }

    return {
      ...entry.job,
      status: 'completed',
      completedAt: new Date().toISOString(),
      resultPath: destPath || '/tmp/mock-result.png',
      costUsd: 0.0,
      providerMeta: { mock: true },
    };
  }
}

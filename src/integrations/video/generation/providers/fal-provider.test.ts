import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FalProvider } from './fal-provider.ts';
import { GenerationError, type GenerateImageRequest, type GenerateVideoRequest } from '../types.ts';

describe('FalProvider', () => {
  let provider: FalProvider;
  let restoreFetch: (() => void) | undefined;
  let tempDir: string;

  beforeEach(async () => {
    provider = new FalProvider();
    process.env.FAL_KEY = 'test-fake-fal-key';
    tempDir = await mkdtemp(join(tmpdir(), 'fal-test-'));
  });

  afterEach(async () => {
    delete process.env.FAL_KEY;
    restoreFetch?.();
    restoreFetch = undefined;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(handler(url, init));
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
  }

  it('rejects unsupported models immediately', async () => {
    const req: GenerateImageRequest = {
      productImages: ['https://example.com/product.jpg'],
    };
    await assert.rejects(
      () => provider.submit(req, 'unsupported-model-id'),
      (err: unknown) => err instanceof GenerationError && err.code === 'UNSUPPORTED_MODEL',
    );
  });

  it('throws INVALID_CONFIG if FAL_KEY is missing', async () => {
    delete process.env.FAL_KEY;
    const req: GenerateImageRequest = {
      productImages: ['https://example.com/product.jpg'],
    };
    await assert.rejects(
      () => provider.submit(req, 'fal-ai/flux-pro/v1/fill'),
      (err: unknown) => err instanceof GenerationError && err.code === 'INVALID_CONFIG',
    );
  });

  it('correctly maps normalized VTO image request to fal.ai queue payload', async () => {
    let capturedBody: any;
    let capturedHeaders: any;
    let capturedUrl: string = '';

    mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ request_id: 'req-12345', status: 'IN_QUEUE' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const req: GenerateImageRequest = {
      productImages: ['https://example.com/blue-blouse.jpg'],
      personImage: 'https://example.com/model.jpg',
      prompt: 'commercial marketing shot',
      width: 768,
      height: 1024,
    };

    const job = await provider.submit(req, 'fal-ai/flux-pro/v1/fill');

    assert.equal(capturedUrl, 'https://queue.fal.run/fal-ai/flux-pro/v1/fill');
    assert.equal(capturedHeaders['Authorization'], 'Key test-fake-fal-key');
    assert.equal(capturedBody.prompt, 'commercial marketing shot');
    assert.equal(capturedBody.reference_image_url, 'https://example.com/blue-blouse.jpg');
    assert.equal(capturedBody.image_url, 'https://example.com/model.jpg');
    assert.deepEqual(capturedBody.image_size, { width: 768, height: 1024 });

    // Job format test
    assert.equal(job.externalJobId, 'fal-ai/flux-pro/v1/fill::req-12345');
    assert.equal(job.provider, 'fal');
    assert.equal(job.model, 'fal-ai/flux-pro/v1/fill');
    assert.equal(job.capability, 'virtual_try_on');
    assert.equal(job.status, 'queued');
  });

  it('correctly maps normalized video request to Wan 2.2 payload', async () => {
    let capturedBody: any;

    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ request_id: 'req-video-999', status: 'IN_QUEUE' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const req: GenerateVideoRequest = {
      keyframePath: 'https://example.com/approved-keyframe.png',
      prompt: 'subtle body turn, natural fabric movement',
      durationSeconds: 4,
    };

    const job = await provider.submit(req, 'fal-ai/wan-i2v/turbo');

    assert.equal(capturedBody.image_url, 'https://example.com/approved-keyframe.png');
    assert.equal(capturedBody.prompt, 'subtle body turn, natural fabric movement');
    assert.equal(capturedBody.num_frames, 64);
    assert.equal(job.capability, 'image_to_video');
    assert.equal(job.externalJobId, 'fal-ai/wan-i2v/turbo::req-video-999');
  });

  it('maps fal status endpoints correctly', async () => {
    mockFetch(async (url) => {
      if (url.includes('status')) {
        return new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    const status = await provider.getStatus('fal-ai/flux-pro/v1/fill::req-12345');
    assert.equal(status, 'running');
  });

  it('handles getResult when job is completed and downloads primary artifact', async () => {
    const destFile = join(tempDir, 'output-keyframe.png');

    mockFetch(async (url) => {
      if (url.includes('requests/req-12345')) {
        return new Response(
          JSON.stringify({
            images: [{ url: 'https://cdn.fal.run/mock-generated-image.png' }],
            created_at: '2026-09-29T00:00:00Z',
          }),
          { status: 200 },
        );
      }
      if (url === 'https://cdn.fal.run/mock-generated-image.png') {
        return new Response(Buffer.from('PNG_FAKE_IMAGE_DATA'), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    const record = await provider.getResult('fal-ai/flux-pro/v1/fill::req-12345', destFile);

    assert.equal(record.status, 'completed');
    assert.equal(record.resultPath, destFile);
    assert.equal(record.model, 'fal-ai/flux-pro/v1/fill');
    assert.equal(record.externalJobId, 'fal-ai/flux-pro/v1/fill::req-12345');
  });

  it('throws RESULT_NOT_READY when getResult encounters HTTP 202', async () => {
    mockFetch(async () => new Response('In progress', { status: 202 }));

    await assert.rejects(
      () => provider.getResult('fal-ai/flux-pro/v1/fill::req-12345'),
      (err: unknown) => err instanceof GenerationError && err.code === 'RESULT_NOT_READY',
    );
  });
});

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRouter } from './provider-router.ts';
import { MockGenerationProvider } from './providers/mock-provider.ts';
import { FalProvider } from './providers/fal-provider.ts';
import { GenerationError } from './types.ts';

describe('ProviderRouter', () => {
  let router: ProviderRouter;

  beforeEach(() => {
    delete process.env.IMAGE_PROVIDER;
    delete process.env.IMAGE_MODEL;
    delete process.env.VIDEO_PROVIDER;
    delete process.env.VIDEO_MODEL;
    router = new ProviderRouter();
  });

  it('routes virtual_try_on capability to default fal provider flux-vto', () => {
    const route = router.resolveRoute('virtual_try_on');
    assert.equal(route.provider.providerName, 'fal');
    assert.equal(route.modelId, 'fal-ai/flux-pro/v1/fill');
  });

  it('routes image_to_video capability to default fal provider wan-v2.2-turbo', () => {
    const route = router.resolveRoute('image_to_video');
    assert.equal(route.provider.providerName, 'fal');
    assert.equal(route.modelId, 'fal-ai/wan-i2v/turbo');
  });

  it('routes image_edit capability to default fal qwen or kontext model', () => {
    const route = router.resolveRoute('image_edit');
    assert.equal(route.provider.providerName, 'fal');
    assert.ok(route.modelId.includes('qwen') || route.modelId.includes('kontext'));
  });

  it('respects provider override argument', () => {
    const route = router.resolveRoute('virtual_try_on', { provider: 'mock', model: 'mock-vto' });
    assert.equal(route.provider.providerName, 'mock');
    assert.equal(route.modelId, 'mock-vto');
  });

  it('respects environment variable overrides (IMAGE_PROVIDER / IMAGE_MODEL)', () => {
    process.env.IMAGE_PROVIDER = 'fal';
    process.env.IMAGE_MODEL = 'fal-ai/flux-pro/kontext';
    const route = router.resolveRoute('image_edit');
    assert.equal(route.provider.providerName, 'fal');
    assert.equal(route.modelId, 'fal-ai/flux-pro/kontext');
  });

  it('throws UNSUPPORTED_CAPABILITY when model does not support requested capability', () => {
    assert.throws(
      () =>
        router.resolveRoute('virtual_try_on', {
          provider: 'fal',
          model: 'fal-ai/wan-i2v/turbo',
        }),
      (err: unknown) =>
        err instanceof GenerationError &&
        err.code === 'UNSUPPORTED_CAPABILITY' &&
        err.message.includes('does not support capability "virtual_try_on"'),
    );
  });

  it('throws UNSUPPORTED_MODEL when model is not recognized by provider', () => {
    assert.throws(
      () =>
        router.resolveRoute('virtual_try_on', {
          provider: 'fal',
          model: 'fal-ai/non-existent-model',
        }),
      (err: unknown) =>
        err instanceof GenerationError &&
        err.code === 'UNSUPPORTED_MODEL' &&
        err.message.includes('does not support model "fal-ai/non-existent-model"'),
    );
  });

  it('throws INVALID_CONFIG when unknown provider is requested', () => {
    assert.throws(
      () =>
        router.resolveRoute('virtual_try_on', {
          provider: 'unregistered-provider',
        }),
      (err: unknown) =>
        err instanceof GenerationError &&
        err.code === 'INVALID_CONFIG' &&
        err.message.includes('No provider registered with name "unregistered-provider"'),
    );
  });
});

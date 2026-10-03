import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GenerationService } from './service.ts';
import { ProviderRouter } from './provider-router.ts';
import { MockGenerationProvider } from './providers/mock-provider.ts';

describe('GenerationService', () => {
  it('submits, polls, and returns completed record using mock provider', async () => {
    const mockProvider = new MockGenerationProvider();
    const router = new ProviderRouter([mockProvider]);
    const service = new GenerationService({ router });

    const record = await service.generateImage(
      {
        productImages: ['/fake/blouse.png'],
        personImage: '/fake/person.png',
        prompt: 'test prompt',
      },
      {
        provider: 'mock',
        model: 'mock-vto',
        pollIntervalMs: 10,
        timeoutMs: 1000,
      },
    );

    assert.equal(record.status, 'completed');
    assert.equal(record.provider, 'mock');
    assert.equal(record.model, 'mock-vto');
    assert.ok(record.resultPath);
    assert.ok(typeof record.latencyMs === 'number');
  });

  it('records human fidelity gate review decisions', () => {
    const service = new GenerationService();
    const baseRecord = {
      externalJobId: 'mock::123',
      provider: 'mock',
      model: 'mock-vto',
      capability: 'virtual_try_on' as const,
      status: 'completed' as const,
      submittedAt: new Date().toISOString(),
    };

    const approved = service.recordFidelityReview(baseRecord, true);
    assert.equal(approved.approved, true);
    assert.equal(approved.rejectionReason, undefined);

    const rejected = service.recordFidelityReview(baseRecord, false, 'Missing Peter Pan collar');
    assert.equal(rejected.approved, false);
    assert.equal(rejected.rejectionReason, 'Missing Peter Pan collar');
  });
});

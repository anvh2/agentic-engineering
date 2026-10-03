import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCHMARK_BLOUSE_SPEC,
  createProductSpec,
  renderShotPrompt,
} from './product-spec.ts';
import { evaluateFidelity } from './fidelity-gate.ts';
import { ProviderRouter } from './provider-router.ts';

describe('ProductSpec & Shot Prompt Rendering', () => {
  it('contains all identity-critical features in benchmark blouse spec', () => {
    assert.equal(BENCHMARK_BLOUSE_SPEC.color, 'light powder blue');
    assert.ok(BENCHMARK_BLOUSE_SPEC.collar.includes('Peter Pan'));
    assert.ok(BENCHMARK_BLOUSE_SPEC.closure.includes('3 visible flower-shaped'));
    assert.ok(BENCHMARK_BLOUSE_SPEC.chest.includes('pintuck'));
    assert.ok(BENCHMARK_BLOUSE_SPEC.chest.includes('yoke'));
    assert.ok(BENCHMARK_BLOUSE_SPEC.chest.includes('ruffle'));
    assert.ok(BENCHMARK_BLOUSE_SPEC.sleeves.includes('puff'));
  });

  it('embeds identical canonical spec identity in all three marketing shot prompts', () => {
    const modelPrompt = renderShotPrompt(BENCHMARK_BLOUSE_SPEC, 'MODEL_HERO');
    const heroPrompt = renderShotPrompt(BENCHMARK_BLOUSE_SPEC, 'PRODUCT_HERO');
    const detailPrompt = renderShotPrompt(BENCHMARK_BLOUSE_SPEC, 'PRODUCT_DETAIL');

    // All three MUST include the canonical identity block
    for (const p of [modelPrompt, heroPrompt, detailPrompt]) {
      assert.ok(p.includes('light powder blue'));
      assert.ok(p.includes('Peter Pan'));
      assert.ok(p.includes('3 visible flower-shaped'));
    }

    // But each is tailored to the shot type
    assert.ok(modelPrompt.includes('model wearing'));
    assert.ok(heroPrompt.includes('commercial studio catalog'));
    assert.ok(detailPrompt.includes('Macro close-up'));
  });

  it('creates custom product specs cleanly', () => {
    const custom = createProductSpec({
      color: 'emerald green',
      garment: 'silk midi dress',
    });
    assert.equal(custom.color, 'emerald green');
    assert.equal(custom.garment, 'silk midi dress');
  });
});

describe('FidelityGate', () => {
  it('APPROVES an asset only when all identity-critical features pass', () => {
    const review = evaluateFidelity(
      'MODEL_HERO',
      '/test/model-hero.png',
      {
        color: 'PASS',
        collar: 'PASS',
        button_count: 'PASS',
        button_style: 'PASS',
        pintucks: 'PASS',
        yoke: 'PASS',
        ruffle: 'PASS',
        sleeve_shape: 'PASS',
        silhouette: 'PASS',
        material: 'PASS',
      },
      BENCHMARK_BLOUSE_SPEC,
    );

    assert.equal(review.decision, 'APPROVED');
    assert.equal(review.rejectionReasons.length, 0);
  });

  it('REJECTS an asset if button_count or collar fails and records specific reasons', () => {
    const review = evaluateFidelity(
      'MODEL_HERO',
      '/test/model-hero.png',
      {
        color: 'PASS',
        collar: 'FAIL',
        button_count: 'FAIL',
        button_style: 'PASS',
        pintucks: 'PASS',
        yoke: 'PASS',
        ruffle: 'PASS',
        sleeve_shape: 'PASS',
        silhouette: 'PASS',
        material: 'PASS',
      },
      BENCHMARK_BLOUSE_SPEC,
    );

    assert.equal(review.decision, 'REJECTED');
    assert.equal(review.rejectionReasons.length, 2);
    assert.ok(review.rejectionReasons.some((r) => r.includes('collar')));
    assert.ok(review.rejectionReasons.some((r) => r.includes('button_count')));
  });
});

describe('ProviderRouter Shot-Type Routing', () => {
  it('routes MODEL_HERO, PRODUCT_HERO, and PRODUCT_DETAIL to appropriate capabilities and models', () => {
    const router = new ProviderRouter();

    const modelHeroRoute = router.resolveShotRoute('MODEL_HERO');
    assert.equal(modelHeroRoute.provider.providerName, 'fal');
    assert.equal(modelHeroRoute.modelId, 'fal-ai/flux-pro/v1/fill');

    const productHeroRoute = router.resolveShotRoute('PRODUCT_HERO');
    assert.equal(productHeroRoute.provider.providerName, 'fal');
    assert.ok(productHeroRoute.modelId.includes('qwen') || productHeroRoute.modelId.includes('kontext'));

    const detailRoute = router.resolveShotRoute('PRODUCT_DETAIL');
    assert.equal(detailRoute.provider.providerName, 'fal');
    assert.ok(detailRoute.modelId.includes('qwen') || detailRoute.modelId.includes('kontext'));
  });

  it('allows independent per-shot provider and model overrides via env', () => {
    process.env.MODEL_HERO_PROVIDER = 'mock';
    process.env.MODEL_HERO_MODEL = 'mock-vto';
    process.env.PRODUCT_HERO_PROVIDER = 'mock';
    process.env.PRODUCT_HERO_MODEL = 'mock-edit';

    const router = new ProviderRouter();
    const heroRoute = router.resolveShotRoute('MODEL_HERO');
    assert.equal(heroRoute.provider.providerName, 'mock');
    assert.equal(heroRoute.modelId, 'mock-vto');

    const prodRoute = router.resolveShotRoute('PRODUCT_HERO');
    assert.equal(prodRoute.provider.providerName, 'mock');
    assert.equal(prodRoute.modelId, 'mock-edit');

    delete process.env.MODEL_HERO_PROVIDER;
    delete process.env.MODEL_HERO_MODEL;
    delete process.env.PRODUCT_HERO_PROVIDER;
    delete process.env.PRODUCT_HERO_MODEL;
  });
});

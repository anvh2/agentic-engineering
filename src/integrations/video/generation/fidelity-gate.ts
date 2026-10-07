/**
 * Product Fidelity Gate.
 *
 * "BEAUTY IS NOT ENOUGH. A photorealistic image is still a failure if the product changes."
 *
 * Each generated asset is reviewable against the canonical ProductSpec.
 * Every identity-critical feature must pass; any failure rejects the asset
 * from proceeding to the image-to-video stage.
 */

import type { MarketingShotType, ProductSpec } from './product-spec.ts';

export type FeatureEvaluationStatus = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';

export interface FidelityFeatureScores {
  color: FeatureEvaluationStatus;
  collar: FeatureEvaluationStatus;
  button_count: FeatureEvaluationStatus;
  button_style: FeatureEvaluationStatus;
  pintucks: FeatureEvaluationStatus;
  yoke: FeatureEvaluationStatus;
  ruffle: FeatureEvaluationStatus;
  sleeve_shape: FeatureEvaluationStatus;
  silhouette: FeatureEvaluationStatus;
  material: FeatureEvaluationStatus;
  [customFeature: string]: FeatureEvaluationStatus;
}

export type FidelityGateDecision = 'APPROVED' | 'REJECTED';

export interface FidelityReview {
  reviewId: string;
  shotType: MarketingShotType;
  assetPathOrUrl: string;
  externalJobId?: string;
  decision: FidelityGateDecision;
  featureScores: FidelityFeatureScores;
  rejectionReasons: string[];
  reviewedBy: 'manual_human' | 'automated_multimodal_evaluator';
  timestamp: string;
  reviewerNotes?: string;
}

/**
 * Validates a set of feature scores and derives the final gate decision.
 * An asset is APPROVED only if zero features failed.
 */
export function evaluateFidelity(
  shotType: MarketingShotType,
  assetPathOrUrl: string,
  scores: Partial<FidelityFeatureScores>,
  spec?: ProductSpec,
  options?: {
    reviewer?: 'manual_human' | 'automated_multimodal_evaluator';
    notes?: string;
    externalJobId?: string;
  },
): FidelityReview {
  const fullScores: FidelityFeatureScores = {
    color: scores.color ?? 'FAIL',
    collar: scores.collar ?? 'FAIL',
    button_count: scores.button_count ?? 'FAIL',
    button_style: scores.button_style ?? 'FAIL',
    pintucks: scores.pintucks ?? 'FAIL',
    yoke: scores.yoke ?? 'FAIL',
    ruffle: scores.ruffle ?? 'FAIL',
    sleeve_shape: scores.sleeve_shape ?? 'FAIL',
    silhouette: scores.silhouette ?? 'FAIL',
    material: scores.material ?? 'FAIL',
    ...scores,
  };

  const rejectionReasons: string[] = [];

  for (const [feature, status] of Object.entries(fullScores)) {
    if (status === 'FAIL') {
      const specExpected = spec ? (spec as any)[feature] : undefined;
      const detail = specExpected ? ` (expected: ${specExpected})` : '';
      rejectionReasons.push(`Feature "${feature}" failed fidelity check${detail}`);
    }
  }

  const decision: FidelityGateDecision = rejectionReasons.length === 0 ? 'APPROVED' : 'REJECTED';

  return {
    reviewId: `review-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    shotType,
    assetPathOrUrl,
    externalJobId: options?.externalJobId,
    decision,
    featureScores: fullScores,
    rejectionReasons,
    reviewedBy: options?.reviewer || 'manual_human',
    timestamp: new Date().toISOString(),
    reviewerNotes: options?.notes,
  };
}

/**
 * Convenience helper to create a default template for human review.
 */
export function createEmptyReviewTemplate(
  shotType: MarketingShotType,
  assetPathOrUrl: string,
): FidelityFeatureScores {
  // In a macro detail shot, full silhouette might not be applicable
  const isDetail = shotType === 'PRODUCT_DETAIL';
  return {
    color: 'PASS',
    collar: 'PASS',
    button_count: 'PASS',
    button_style: 'PASS',
    pintucks: 'PASS',
    yoke: 'PASS',
    ruffle: 'PASS',
    sleeve_shape: isDetail ? 'NOT_APPLICABLE' : 'PASS',
    silhouette: isDetail ? 'NOT_APPLICABLE' : 'PASS',
    material: 'PASS',
  };
}

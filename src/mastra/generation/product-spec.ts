/**
 * Canonical ProductSpec / ProductIdentity definition and prompt rendering.
 *
 * Product identity is the primary quality gate:
 * - color
 * - garment silhouette
 * - collar
 * - closure / buttons
 * - chest construction / pintucks / yoke / ruffles
 * - sleeves
 * - material / texture
 *
 * Every generated shot (MODEL_HERO, PRODUCT_HERO, PRODUCT_DETAIL) receives
 * the SAME canonical ProductSpec to ensure garment consistency across shots.
 */

export type MarketingShotType = 'MODEL_HERO' | 'PRODUCT_HERO' | 'PRODUCT_DETAIL';

export interface ProductSpec {
  /** Garment category and silhouette (e.g. "loose short-sleeve blouse, A-line / babydoll-like silhouette") */
  garment: string;
  /** Primary and secondary colors (e.g. "light powder blue") */
  color: string;
  /** Collar construction (e.g. "rounded Peter Pan style") */
  collar: string;
  /** Closure and button count/style (e.g. "exactly 3 visible flower-shaped decorative buttons") */
  closure: string;
  /** Chest and bodice construction (e.g. "vertical pintuck detailing around center placket, curved yoke/chest panel, ruffle trim following the yoke") */
  chest: string;
  /** Sleeve shape and finish (e.g. "short puff/gathered sleeves, visible gathered/ruffled construction") */
  sleeves: string;
  /** Fabric weave and surface texture (e.g. "lightweight woven fabric, slightly crinkled appearance") */
  material: string;
  /** Additional identity-critical features or notes */
  additionalDetails?: Record<string, string>;
  /** Raw seller reference image paths or URLs used to derive this spec */
  rawReferenceImages?: string[];
}

/**
 * Benchmark blouse canonical spec (derived directly from Image 4 raw seller image).
 * Used as standard test fixture and reference.
 */
export const BENCHMARK_BLOUSE_SPEC: ProductSpec = {
  garment: 'loose short-sleeve blouse with an A-line babydoll silhouette and delicate lower hem drape',
  color: 'light powder blue',
  collar: 'rounded Peter Pan collar with subtle edge stitching',
  closure: 'front center placket with exactly 3 visible flower-shaped decorative pearlescent buttons',
  chest: 'vertical pintuck detailing along the center placket, curved yoke chest panel with gathered ruffle trim following the yoke seam',
  sleeves: 'short puff gathered sleeves with ruffled elasticated cuff hems',
  material: 'lightweight airy woven cotton blend fabric with a soft slightly crinkled texture',
};

/**
 * Builds or normalizes a ProductSpec from input parameters.
 * When inference is wired to a VLM in future iterations, this is the seam.
 */
export function createProductSpec(input: Partial<ProductSpec>): ProductSpec {
  return {
    garment: input.garment || 'clothing garment',
    color: input.color || 'as shown in reference',
    collar: input.collar || 'as shown in reference',
    closure: input.closure || 'as shown in reference',
    chest: input.chest || 'as shown in reference',
    sleeves: input.sleeves || 'as shown in reference',
    material: input.material || 'as shown in reference',
    additionalDetails: input.additionalDetails || {},
    rawReferenceImages: input.rawReferenceImages || [],
  };
}

/**
 * Renders a canonical prompt for a specific marketing shot type, embedding
 * all identity-critical construction details to prevent model hallucinations.
 */
export function renderShotPrompt(
  spec: ProductSpec,
  shotType: MarketingShotType,
  customSteering?: string,
): string {
  const identityBlock = [
    `Product Color: ${spec.color}`,
    `Garment Type: ${spec.garment}`,
    `Collar: ${spec.collar}`,
    `Front Closure: ${spec.closure}`,
    `Chest Detailing: ${spec.chest}`,
    `Sleeves: ${spec.sleeves}`,
    `Fabric Texture: ${spec.material}`,
  ].join('. ');

  switch (shotType) {
    case 'MODEL_HERO':
      return [
        'Commercial fashion editorial lifestyle photograph of an East Asian female model wearing the exact referenced garment in a chic, softly lit boutique store with natural sunlight.',
        `The garment worn by the model must match these exact specifications: ${identityBlock}.`,
        'The model is standing gracefully, natural friendly expression, upper body to three-quarter view.',
        'High-end e-commerce commercial quality, photorealistic, 8k resolution, cinematic soft shadows.',
        customSteering || '',
      ]
        .filter(Boolean)
        .join(' ');

    case 'PRODUCT_HERO':
      return [
        'Clean commercial studio catalog photograph of the garment displayed on a minimalist wooden block pedestal or clean mannequin.',
        'Full front view of the garment displaying its complete silhouette clearly against an elegant neutral beige studio backdrop with soft ambient lighting.',
        `Garment must feature exact construction: ${identityBlock}.`,
        'Crisp focus, professional product photography, no human model, wrinkle-free commercial presentation.',
        customSteering || '',
      ]
        .filter(Boolean)
        .join(' ');

    case 'PRODUCT_DETAIL':
      return [
        'Macro close-up commercial product photograph emphasizing the fine craftsmanship and construction of the upper chest, collar, and neckline.',
        `Garment details: ${identityBlock}.`,
        `Sharp focus on the ${spec.collar}, the ${spec.closure}, the ${spec.chest}, and the ${spec.material}.`,
        'Shallow depth of field, warm editorial studio lighting, ultra-sharp textile texture and button detail.',
        'No face, no person, macro catalog detail shot.',
        customSteering || '',
      ]
        .filter(Boolean)
        .join(' ');
  }
}

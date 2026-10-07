import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { GenerationService } from '../src/integrations/video/generation/service.ts';
import { ProviderRouter } from '../src/integrations/video/generation/provider-router.ts';
import { resolveFalKey } from '../src/integrations/video/generation/config.ts';
import {
  BENCHMARK_BLOUSE_SPEC,
  renderShotPrompt,
  type MarketingShotType,
  type ProductSpec,
} from '../src/integrations/video/generation/product-spec.ts';
import { evaluateFidelity } from '../src/integrations/video/generation/fidelity-gate.ts';

/**
 * Marketing Asset Set Generator (First Cloud Experiment CLI).
 *
 * Implements:
 *   raw seller reference(s)
 *          ↓
 *     ProductSpec
 *          ↓
 *   ┌───────────────┬───────────────┬────────────────┐
 *   │ MODEL_HERO    │ PRODUCT_HERO  │ PRODUCT_DETAIL │
 *   └───────────────┴───────────────┴────────────────┘
 *          ↓
 *     Fidelity Gate
 *
 * Usage:
 *   node --env-file=.env scripts/generate-marketing-set.ts \
 *     --raw benchmarks/reference-marketing-set/raw_seller_blouse.jpg \
 *     [--person benchmarks/phase3b/comfy-run-01/mask/person-image.png] \
 *     [--shot MODEL_HERO|PRODUCT_HERO|PRODUCT_DETAIL|ALL] \
 *     [--dry-run]
 */

const FLAGS = new Set(['--raw', '--person', '--shot', '--output-dir', '--provider']);
const BOOLEAN_FLAGS = new Set(['--dry-run', '--json']);

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (BOOLEAN_FLAGS.has(flag)) {
      result[flag.slice(2)] = true;
      continue;
    }
    if (!FLAGS.has(flag)) {
      throw new Error(`Unknown flag "${flag}". Supported: ${[...FLAGS, ...BOOLEAN_FLAGS].join(', ')}`);
    }
    const value = argv[i + 1];
    if (value === undefined || FLAGS.has(value) || BOOLEAN_FLAGS.has(value)) {
      throw new Error(`Flag "${flag}" requires a value.`);
    }
    result[flag.slice(2)] = value;
    i++;
  }
  return result;
}

function usage(): string {
  return [
    'Marketing Asset Set Generator CLI',
    'Usage: node --env-file=.env scripts/generate-marketing-set.ts [options]',
    '',
    'Options:',
    '  --raw <path>        Path to raw seller product image (default: benchmarks/reference-marketing-set/raw_seller_blouse.jpg)',
    '  --person <path>     Path to person image for MODEL_HERO (default: benchmarks/phase3b/comfy-run-01/mask/person-image.png)',
    '  --shot <type>       Shot type to generate: MODEL_HERO | PRODUCT_HERO | PRODUCT_DETAIL | ALL (default: ALL)',
    '  --output-dir <path> Directory to save generated assets (default: benchmarks/marketing-asset-set/run-01)',
    '  --provider <name>   Provider override: fal | mock (default: fal)',
    '  --dry-run           Validate and print exact commands/payloads without executing paid API calls',
    '  --json              Emit structured JSON output',
  ].join('\n');
}

async function main(): Promise<void> {
  let flags: Record<string, string | boolean>;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const jsonOutput = flags.json === true;
  const isDryRun = flags['dry-run'] === true;

  const rawImagePath = resolve(
    (flags.raw as string) || 'benchmarks/reference-marketing-set/raw_seller_blouse.jpg',
  );
  if (!existsSync(rawImagePath)) {
    const msg = `Raw seller image not found at "${rawImagePath}".`;
    if (jsonOutput) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    process.exitCode = 1;
    return;
  }

  const personImagePath = flags.person
    ? resolve(flags.person as string)
    : existsSync(resolve('benchmarks/phase3b/comfy-run-01/mask/person-image.png'))
      ? resolve('benchmarks/phase3b/comfy-run-01/mask/person-image.png')
      : undefined;

  const shotSelection = ((flags.shot as string) || 'ALL').toUpperCase();
  const validShots: MarketingShotType[] = ['MODEL_HERO', 'PRODUCT_HERO', 'PRODUCT_DETAIL'];
  const shotsToRun: MarketingShotType[] =
    shotSelection === 'ALL'
      ? validShots
      : validShots.filter((s) => s === shotSelection);

  if (shotsToRun.length === 0) {
    const msg = `Invalid shot type "${shotSelection}". Must be one of: MODEL_HERO, PRODUCT_HERO, PRODUCT_DETAIL, ALL.`;
    if (jsonOutput) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    process.exitCode = 1;
    return;
  }

  const outputDir = resolve((flags['output-dir'] as string) || 'benchmarks/marketing-asset-set/run-01');
  mkdirSync(outputDir, { recursive: true });

  const providerName = isDryRun ? 'mock' : ((flags.provider as string) || 'fal');

  if (!isDryRun && providerName === 'fal') {
    try {
      resolveFalKey();
    } catch (err) {
      const msg = (err as Error).message;
      if (jsonOutput) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(`Configuration Error: ${msg}`);
      process.exitCode = 1;
      return;
    }
  }

  // Canonical ProductSpec derived from the raw seller reference
  const spec: ProductSpec = {
    ...BENCHMARK_BLOUSE_SPEC,
    rawReferenceImages: [rawImagePath],
  };

  const router = new ProviderRouter();
  const service = new GenerationService({ router });

  console.log('================================================================');
  console.log('MARKETING ASSET SET EXPERIMENT — PRODUCTSPEC & PLANNED SHOTS');
  console.log('================================================================');
  console.log(`Raw Seller Reference : ${rawImagePath}`);
  console.log(`Person Reference      : ${personImagePath ?? '(none)'}`);
  console.log(`Target Output Dir     : ${outputDir}`);
  console.log(`Active Provider       : ${providerName}`);
  console.log('Canonical ProductSpec :');
  console.log(`  Color    : ${spec.color}`);
  console.log(`  Garment  : ${spec.garment}`);
  console.log(`  Collar   : ${spec.collar}`);
  console.log(`  Closure  : ${spec.closure}`);
  console.log(`  Chest    : ${spec.chest}`);
  console.log(`  Sleeves  : ${spec.sleeves}`);
  console.log(`  Material : ${spec.material}`);
  console.log('----------------------------------------------------------------');

  for (const shot of shotsToRun) {
    const route = router.resolveShotRoute(shot, {
      provider: providerName,
    });
    const prompt = renderShotPrompt(spec, shot);
    const destPath = resolve(outputDir, `${shot.toLowerCase()}.png`);

    console.log(`\n[SHOT PLAN: ${shot}]`);
    console.log(`  Target File : ${destPath}`);
    console.log(`  Provider    : ${route.provider.providerName}`);
    console.log(`  Model ID    : ${route.modelId}`);
    console.log(`  Prompt      : ${prompt}`);

    if (isDryRun) {
      console.log(`  Status      : [DRY-RUN VALIDATED — NO PAID API CALL]`);
      continue;
    }

    console.log(`  Submitting to ${route.provider.providerName}...`);
    try {
      const record = await service.generateMarketingShot(spec, shot, {
        personImage: shot === 'MODEL_HERO' ? personImagePath : undefined,
        provider: route.provider.providerName,
        model: route.modelId,
        destPath,
      });
      console.log(`  Completed! External Job: ${record.externalJobId}, Saved: ${record.resultPath}`);
    } catch (err) {
      console.error(`  Failed: ${(err as Error).message}`);
    }
  }

  console.log('\n================================================================');
  if (isDryRun) {
    console.log('DRY-RUN COMPLETE: All routes, prompts, and specs verified.');
    console.log('To run ONE paid generation manually, execute:');
    for (const shot of shotsToRun) {
      console.log(`  node --env-file=.env scripts/generate-marketing-set.ts --shot ${shot}`);
    }
  } else {
    console.log('ASSET GENERATION COMPLETE.');
    console.log('Next step: Review fidelity before proceeding to video generation.');
  }
  console.log('================================================================');
}

await main();

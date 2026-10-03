import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { GenerationService } from '../src/mastra/generation/service.ts';
import { ProviderRouter } from '../src/mastra/generation/provider-router.ts';
import { resolveFalKey } from '../src/mastra/generation/config.ts';
import type { GenerateImageRequest, GenerationCapability } from '../src/mastra/generation/types.ts';

/**
 * Manual test CLI for ONE cloud image generation (MVP keyframe step).
 *
 * Usage:
 *   node --env-file=.env scripts/generate-keyframe.ts \
 *     --product ./path/to/blouse.png \
 *     [--person ./path/to/model.png] \
 *     [--output ./output/keyframe.png] \
 *     [--provider fal] \
 *     [--model fal-ai/flux-pro/v1/fill] \
 *     [--prompt "commercial marketing shot"] \
 *     [--dry-run]
 */

const FLAGS = new Set([
  '--product',
  '--person',
  '--output',
  '--provider',
  '--model',
  '--capability',
  '--prompt',
]);
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
    'Usage: node --env-file=.env scripts/generate-keyframe.ts --product <path> [options]',
    'Options:',
    '  --product <path>      Path to product reference image (required)',
    '  --person <path>       Path to person/model reference image (optional)',
    '  --output <path>       Path where resulting keyframe should be saved (default: .generation-workdir/keyframe-<id>.png)',
    '  --provider <name>     Provider name (default: fal)',
    '  --model <id>          Model ID override (default: auto from capability)',
    '  --capability <cap>    Capability: virtual_try_on | image_edit (default: virtual_try_on if person given)',
    '  --prompt <text>       Steering prompt',
    '  --dry-run             Simulate without calling live paid APIs',
    '  --json                Emit output in JSON format',
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

  if (!flags.product) {
    const msg = 'Missing required flag: --product <path>';
    if (jsonOutput) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    process.exitCode = 1;
    return;
  }

  const productPath = resolve(flags.product as string);
  if (!existsSync(productPath)) {
    const msg = `Product image not found at "${productPath}"`;
    if (jsonOutput) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    process.exitCode = 1;
    return;
  }

  let personPath: string | undefined;
  if (flags.person) {
    personPath = resolve(flags.person as string);
    if (!existsSync(personPath)) {
      const msg = `Person image not found at "${personPath}"`;
      if (jsonOutput) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(msg);
      process.exitCode = 1;
      return;
    }
  }

  const providerName = isDryRun ? 'mock' : ((flags.provider as string) || 'fal');
  const modelOverride = flags.model ? (flags.model as string) : undefined;
  const capabilityOverride = flags.capability as GenerationCapability | undefined;
  const prompt = flags.prompt ? (flags.prompt as string) : undefined;

  const defaultDest = resolve(`.generation-workdir/keyframe-${Date.now()}.png`);
  const outputPath = flags.output ? resolve(flags.output as string) : defaultDest;
  mkdirSync(dirname(outputPath), { recursive: true });

  if (!isDryRun && providerName === 'fal') {
    try {
      resolveFalKey();
    } catch (err) {
      const msg = (err as Error).message;
      if (jsonOutput) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(`Config error: ${msg}`);
      process.exitCode = 1;
      return;
    }
  }

  const request: GenerateImageRequest = {
    productImages: [productPath],
    personImage: personPath,
    prompt,
    width: 768,
    height: 1024,
  };

  const router = new ProviderRouter();
  const service = new GenerationService({ router });

  if (isDryRun) {
    console.log('[DRY-RUN] Validated request:');
    console.log(`  Provider:    ${providerName}`);
    console.log(`  Product:     ${productPath}`);
    console.log(`  Person:      ${personPath ?? '(none)'}`);
    console.log(`  Output dest: ${outputPath}`);
    console.log(`  Prompt:      ${prompt ?? '(default)'}`);
    console.log('[DRY-RUN] No external API call made. Remove --dry-run when ready to execute.');
    if (jsonOutput) {
      console.log(JSON.stringify({ ok: true, dryRun: true, request, outputPath }));
    }
    return;
  }

  console.log(`Submitting image generation to provider "${providerName}"...`);
  console.log(`  Product: ${productPath}`);
  if (personPath) console.log(`  Person:  ${personPath}`);
  console.log(`  Output:  ${outputPath}`);

  try {
    const record = await service.generateImage(request, {
      provider: providerName,
      model: modelOverride,
      capability: capabilityOverride,
      destPath: outputPath,
    });

    if (jsonOutput) {
      console.log(JSON.stringify({ ok: true, record }));
    } else {
      console.log('\nGeneration complete!');
      console.log(`  External Job ID: ${record.externalJobId}`);
      console.log(`  Model:           ${record.model}`);
      console.log(`  Latency:         ${record.latencyMs ?? 0} ms`);
      console.log(`  Result artifact: ${record.resultPath}`);
    }
  } catch (err) {
    const errorMsg = (err as Error).message;
    if (jsonOutput) {
      console.log(JSON.stringify({ ok: false, error: errorMsg }));
    } else {
      console.error(`\nGeneration failed: ${errorMsg}`);
    }
    process.exitCode = 1;
  }
}

await main();
